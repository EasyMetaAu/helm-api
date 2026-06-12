import { z } from "zod";
import {
  type IRContentPart,
  type IRMessage,
  type IRRequest,
  IRRequestSchema,
  type IRToolCall,
} from "../ir.js";
import { guardRequestFor, type ProtocolWarning, readWarnings } from "../protocol-guards.js";
import { type AnthropicOutputFormat, responseFormatToOutputFormat } from "./output-format.js";
import { createAnthropicToolNameMap, sanitizeAnthropicToolName } from "./response.js";

// Anthropic Messages -> IR inbound normalization (docs/05, task protocol.anthropic-req).
// This is the inbound half of "nativeIn -> IR -> nativeOut, never N×N direct".
// Anthropic's wire shape diverges from the OpenAI-shaped IR hub in four structural
// ways, all flattened here so routing/providers face ONE internal shape:
//   1. `system` lives at the top level (string | block[]) — hoisted to messages[0].
//   2. `tool_result` is a content block inside a user turn — split into role:"tool".
//   3. `tool_use` is a content block inside an assistant turn — lifted to tool_calls.
//   4. `thinking`/`redacted_thinking` blocks carry a signature — kept in the IR
//      `thinking` extension, never in normal content (so they don't pollute prompts).
//   5. images arrive as source:{type:"base64",media_type,data} — collapsed into the
//      IR image part (data-url + mediaType), per pit #5 in docs/05.
//   6. Anthropic forbids consecutive same-role messages downstream — after the
//      tool_result fan-out we merge any adjacent same-role turns.
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). Reimplemented
// from the docs, NOT copied from musistudio/llms or litellm. fail-open on unknown
// blocks (principle 3); fail-closed on a structurally invalid request (principle 2).

// —— Inbound Anthropic request schema (minimal, fail-closed validation). The block
// shapes use passthrough() so unknown fields survive into provider_raw-style
// handling and forward compatibility is preserved. ——————————————————————————————
const AnthropicTextBlockSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();

const AnthropicImageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: z
      .object({
        type: z.string(),
        media_type: z.string().optional(),
        data: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// Anthropic document block (PDF / text). source mirrors the image block: a base64
// payload with media_type, OR a remote {type:"url", url}. file_id variant survives via
// passthrough. Carried inbound so anthropic->X document requests reach the IR (P7).
const AnthropicDocumentBlockSchema = z
  .object({
    type: z.literal("document"),
    source: z
      .object({
        type: z.string(),
        media_type: z.string().optional(),
        data: z.string().optional(),
        url: z.string().optional(),
        file_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const AnthropicToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const AnthropicToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    // Anthropic allows content to be a string OR a block[]; both are normalized.
    content: z.unknown().optional(),
  })
  .passthrough();

const AnthropicThinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

const AnthropicRedactedThinkingBlockSchema = z
  .object({ type: z.literal("redacted_thinking"), data: z.string() })
  .passthrough();

// Unknown block types are tolerated (fail-open) rather than rejected: a future
// Anthropic block type must not 5xx an otherwise-valid request.
const AnthropicUnknownBlockSchema = z.object({ type: z.string() }).passthrough();

const AnthropicContentBlockSchema = z.union([
  AnthropicTextBlockSchema,
  AnthropicImageBlockSchema,
  AnthropicDocumentBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicToolResultBlockSchema,
  AnthropicThinkingBlockSchema,
  AnthropicRedactedThinkingBlockSchema,
  AnthropicUnknownBlockSchema,
]);

// Anthropic documents only user/assistant message roles (system lives top-level),
// but real clients — notably Claude Code — inject system content (MCP server
// instructions, system-reminders) as a role:"system" MESSAGE in the array. We accept
// system/developer here and fold them into the system prompt downstream (transformOut
// keeps the role; systemFromMessages collapses it), matching LiteLLM parity. Rejecting
// them 400'd every Claude Code request ("invalid_value messages[].role").
const AnthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
  })
  .passthrough();

const AnthropicSystemSchema = z.union([z.string(), z.array(AnthropicTextBlockSchema)]);

const AnthropicToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
  })
  .passthrough();

// Anthropic structured-output: { type:"json_schema", schema } (the newer
// output_format API LiteLLM prefers). Carried inbound so anthropic->X json-schema
// requests round-trip back to an IR response_format (issue #59, Theme 3).
const AnthropicOutputFormatSchema = z
  .object({ type: z.literal("json_schema"), schema: z.unknown() })
  .passthrough();

// Anthropic extended-thinking config: { type:"enabled", budget_tokens } (or a
// future "adaptive"/"disabled" shape). Carried as a passthrough bag so it round-trips
// into IR.thinking verbatim and back out unchanged (LiteLLM forwards `thinking` as-is).
const AnthropicThinkingConfigSchema = z
  .object({ type: z.string(), budget_tokens: z.number().int().nonnegative().optional() })
  .passthrough();

const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(AnthropicMessageSchema),
    system: AnthropicSystemSchema.optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    // —— litellm-parity sampling knobs (mapped straight to/from the IR). ——
    top_p: z.number().optional(),
    top_k: z.number().int().optional(),
    stream: z.boolean().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: z.unknown().optional(),
    output_format: AnthropicOutputFormatSchema.optional(),
    // —— extended-thinking + routing knobs. thinking -> IR.thinking; service_tier
    // passes through; metadata is Anthropic's only documented user-attribution field
    // and has no IR home, so it is preserved verbatim in provider_raw. ——
    thinking: AnthropicThinkingConfigSchema.optional(),
    service_tier: z.string().optional(),
    cache_control: z.unknown().optional(),
    metadata: z.unknown().optional(),
    context_management: z.unknown().optional(),
    mcp_servers: z.unknown().optional(),
    container: z.unknown().optional(),
    speed: z.unknown().optional(),
    output_config: z.unknown().optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

// Thinking blocks are kept out of the prompt content and stashed in the IR
// `thinking` extension (the request-level reasoning/thinking passthrough bag).
type IRThinkingExt = { type: "thinking"; text: string; signature?: string };

// Claude Code ≥2.1.29 injects a per-request billing attribution block as the FIRST
// top-level system entry: "x-anthropic-billing-header: cc_version=<v>.<3hex>;
// cc_entrypoint=<entry>; cch=<5hex>;". The `cch` is recomputed EVERY request, so
// forwarding the block verbatim breaks prompt caching (strict prefix match) for the
// whole conversation — cached_tokens=0 + a full prefix re-write per turn
// (anthropics/claude-code #24168, #40652). So it is stripped from the IR here on the
// way in (keeps it out of the OpenAI-relay lanes entirely). The native-Anthropic
// subscription executor then re-emits a coherent, cache-stable header of its own —
// reusing the client's REAL version/entrypoint when the route captured them via
// extractBillingHeaderIdentity (anti-ban), else a baked fallback version.
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// undefined = nothing left to hoist (the system param was only the billing block).
function stripBillingHeader(
  system: z.infer<typeof AnthropicSystemSchema>,
): z.infer<typeof AnthropicSystemSchema> | undefined {
  if (typeof system === "string") {
    return system.startsWith(BILLING_HEADER_PREFIX) ? undefined : system;
  }
  const kept = system.filter((b) => !b.text.startsWith(BILLING_HEADER_PREFIX));
  return kept.length > 0 ? kept : undefined;
}

// Capture the inbound CLI's billing identity — "cc_version=<v>; cc_entrypoint=<e>" with
// the rotating `cch` (and any optional cc_workload / cc_is_subagent) dropped — from the
// SAME system[0] block stripBillingHeader removes. The route stamps the result onto IR
// metadata so the subscription executor can re-emit the client's OWN version instead of
// a pinned spoof. Returns null unless BOTH tokens match a tight shape: the value is
// client-controlled and gets re-emitted into the upstream identity, so an
// abnormal/unparseable header falls back (null) rather than echoing untrusted bytes.
const CC_VERSION_RE = /cc_version=([0-9]+(?:\.[0-9]+)*\.[0-9a-f]{3})(?:;|\s|$)/;
const CC_ENTRYPOINT_RE = /cc_entrypoint=([a-z][a-z0-9_-]{0,31})(?:;|\s|$)/;

export function extractBillingHeaderIdentity(system: unknown): string | null {
  const header = billingHeaderText(system);
  if (header === null) return null;
  const version = header.match(CC_VERSION_RE)?.[1];
  const entrypoint = header.match(CC_ENTRYPOINT_RE)?.[1];
  if (version === undefined || entrypoint === undefined) return null;
  return `cc_version=${version}; cc_entrypoint=${entrypoint}`;
}

// The verbatim billing-header text from a native Anthropic `system` (string | block[]),
// or null when absent. Defensive about shape — the route hands us the raw parsed body.
function billingHeaderText(system: unknown): string | null {
  if (typeof system === "string") {
    return system.startsWith(BILLING_HEADER_PREFIX) ? system : null;
  }
  if (Array.isArray(system)) {
    for (const b of system) {
      const text = (b as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.startsWith(BILLING_HEADER_PREFIX)) return text;
    }
  }
  return null;
}

// —— system: string | block[] -> IR message content (string or multipart). ————————
function normalizeSystem(system: z.infer<typeof AnthropicSystemSchema>): IRMessage["content"] {
  if (typeof system === "string") return system;
  // Preserve a per-block cache_control breakpoint (common on big system prompts);
  // AnthropicTextBlockSchema is .passthrough(), so it rode through inbound parse.
  return system.map((b) => {
    const cc = (b as { cache_control?: unknown }).cache_control;
    return {
      type: "text" as const,
      text: b.text,
      ...(cc !== undefined ? { cache_control: cc } : {}),
    };
  });
}

// —— image block source:{base64} -> IR image part. Anthropic only carries the raw
// base64 + media_type, so we synthesize a data-url and keep media_type (pit #5). ——
function imagePartFromSource(
  source: z.infer<typeof AnthropicImageBlockSchema>["source"],
): IRContentPart {
  // Already a remote/data url: pass it through untouched.
  if (source.type === "url" && source.url !== undefined) {
    return {
      type: "image",
      url: source.url,
      ...(source.media_type ? { mediaType: source.media_type } : {}),
    };
  }
  const mediaType = source.media_type ?? "application/octet-stream";
  const url = `data:${mediaType};base64,${source.data ?? ""}`;
  return { type: "image", url, mediaType };
}

// —— document block source -> IR document part. base64 keeps data+media_type inline;
// a url source -> document.url; an uploaded-file source -> document.fileId, so the
// upload handle round-trips back to a {type:"file"} source losslessly (P7). ——————————
function documentPartFromSource(
  source: z.infer<typeof AnthropicDocumentBlockSchema>["source"],
): IRContentPart {
  if (source.type === "url" && source.url !== undefined) {
    return {
      type: "document",
      url: source.url,
      ...(source.media_type ? { mediaType: source.media_type } : {}),
    };
  }
  if (source.type === "file" && source.file_id !== undefined) {
    return {
      type: "document",
      fileId: source.file_id,
      ...(source.media_type ? { mediaType: source.media_type } : {}),
    };
  }
  // base64 (or any inline-data source): keep data + media_type on the IR part.
  return {
    type: "document",
    data: source.data ?? "",
    ...(source.media_type ? { mediaType: source.media_type } : {}),
  };
}

// —— tool_use -> IR tool_call. input is serialized to a STABLE JSON string (OpenAI
// shape). A string input is forwarded verbatim (already JSON-ish); otherwise we
// JSON.stringify the object. ————————————————————————————————————————————————————
function toToolCall(block: z.infer<typeof AnthropicToolUseBlockSchema>): IRToolCall {
  const args = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: args },
  };
}

// —— tool_result.content (string | block[]) -> IR role:"tool" content. ———————————
function normalizeToolResultContent(content: unknown): IRMessage["content"] {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: IRContentPart[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        const b = block as { type: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push({ type: "text", text: b.text });
          continue;
        }
      }
      // Unknown tool_result sub-block: degrade to a JSON text placeholder (fail-open).
      parts.push({ type: "text", text: JSON.stringify(block) });
    }
    return parts;
  }
  return JSON.stringify(content);
}

// —— Anthropic tool (input_schema) -> IR/OpenAI tool (function.parameters). ———————
function toIRTool(tool: z.infer<typeof AnthropicToolSchema>) {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
    },
    ...((tool as { cache_control?: unknown }).cache_control !== undefined
      ? { cache_control: (tool as { cache_control?: unknown }).cache_control }
      : {}),
  };
}

// —— Merge consecutive same-role messages (Anthropic forbids them downstream).
// role:"tool" messages are NEVER merged: each carries a distinct tool_call_id and
// must round-trip 1:1. Plain string contents are wrapped to multipart on merge so
// concatenation is unambiguous. ——————————————————————————————————————————————————
function asParts(content: IRMessage["content"]): IRContentPart[] {
  if (content === null) return [];
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return content;
}

function mergeConsecutiveSameRole(messages: IRMessage[]): IRMessage[] {
  const out: IRMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.role === msg.role &&
      msg.role !== "tool" &&
      prev.role !== "tool"
    ) {
      // Merge: concatenate content as multipart, union tool_calls.
      const mergedParts = [...asParts(prev.content), ...asParts(msg.content)];
      const mergedCalls = [...(prev.tool_calls ?? []), ...(msg.tool_calls ?? [])];
      out[out.length - 1] = {
        ...prev,
        content: mergedParts.length > 0 ? mergedParts : null,
        ...(mergedCalls.length > 0 ? { tool_calls: mergedCalls } : {}),
      };
      continue;
    }
    out.push(msg);
  }
  return out;
}

/**
 * Native Anthropic Messages request -> unified IR (OpenAI Chat shape + extensions).
 * Pure: no network, no environment, no framework. fail-closed on an invalid request,
 * fail-open on unknown content blocks.
 */
export function transformRequestOut(req: unknown): IRRequest {
  // fail-closed: a structurally invalid request never enters the pipeline.
  const parsed = AnthropicMessagesRequestSchema.parse(req);

  const messages: IRMessage[] = [];
  const thinking: IRThinkingExt[] = [];

  // Rule 1: hoist the top-level system prompt to the head of messages (after
  // dropping the cache-busting Claude Code billing block, see stripBillingHeader).
  if (parsed.system !== undefined) {
    const system = stripBillingHeader(parsed.system);
    if (system !== undefined) {
      messages.push({ role: "system", content: normalizeSystem(system) });
    }
  }

  for (const m of parsed.messages) {
    // A plain-string message maps straight to an IR string-content message.
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    const parts: IRContentPart[] = [];
    const toolCalls: IRToolCall[] = [];
    const toolResults: IRMessage[] = [];

    for (const block of m.content) {
      // Per-block cache_control (prompt-cache breakpoint) is preserved onto the IR part
      // so it round-trips back out — Anthropic caching is otherwise silently dropped.
      const cacheControl = (block as { cache_control?: unknown }).cache_control;
      switch (block.type) {
        case "text":
          parts.push({
            type: "text",
            text: (block as { text: string }).text,
            ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
          });
          break;
        case "image": {
          const part = imagePartFromSource(
            (block as z.infer<typeof AnthropicImageBlockSchema>).source,
          );
          if (cacheControl !== undefined && part.type === "image")
            part.cache_control = cacheControl;
          parts.push(part);
          break;
        }
        case "document": {
          const part = documentPartFromSource(
            (block as z.infer<typeof AnthropicDocumentBlockSchema>).source,
          );
          if (cacheControl !== undefined && part.type === "document")
            part.cache_control = cacheControl;
          parts.push(part);
          break;
        }
        case "thinking": {
          const b = block as z.infer<typeof AnthropicThinkingBlockSchema>;
          // Rule 4: kept in the IR extension, NOT in normal content.
          thinking.push({
            type: "thinking",
            text: b.thinking,
            ...(b.signature !== undefined ? { signature: b.signature } : {}),
          });
          break;
        }
        case "redacted_thinking": {
          const b = block as z.infer<typeof AnthropicRedactedThinkingBlockSchema>;
          thinking.push({ type: "thinking", text: b.data });
          break;
        }
        case "tool_use":
          // Rule 3: lift into assistant.tool_calls.
          toolCalls.push(toToolCall(block as z.infer<typeof AnthropicToolUseBlockSchema>));
          break;
        case "tool_result": {
          // Rule 2: split into a standalone role:"tool" message.
          const b = block as z.infer<typeof AnthropicToolResultBlockSchema>;
          toolResults.push({
            role: "tool",
            content: normalizeToolResultContent(b.content),
            tool_call_id: b.tool_use_id,
          });
          break;
        }
        default:
          // Rule (boundary): unknown block type degrades to a text placeholder
          // instead of dropping the request (fail-open, CLAUDE.md principle 3).
          parts.push({ type: "text", text: JSON.stringify(block) });
          break;
      }
    }

    if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: parts.length > 0 ? parts : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === "system" || m.role === "developer") {
      // system/developer turn: keep the role so it folds into the system prompt
      // downstream (systemFromMessages) instead of being mistaken for a user turn.
      // (The string-content fast path above already preserves m.role.)
      if (parts.length > 0) messages.push({ role: m.role, content: parts });
    } else {
      // user: tool_result blocks must remain immediately after the assistant
      // tool_use turn. If a client appends normal text to the same Anthropic user
      // message, keep that text as the next user turn after the fanned-out tools.
      for (const tr of toolResults) messages.push(tr);
      if (parts.length > 0) messages.push({ role: "user", content: parts });
    }
  }

  // Rule 6: collapse any adjacent same-role turns left after the fan-out.
  const merged = mergeConsecutiveSameRole(messages);

  // output_format (json_schema) -> IR response_format so anthropic->X structured
  // output round-trips (issue #59, Theme 3). We rewrap as an OpenAI-shaped
  // response_format.json_schema since the IR hub is OpenAI-shaped.
  const responseFormat =
    parsed.output_format !== undefined
      ? {
          type: "json_schema",
          json_schema: { name: "output", schema: parsed.output_format.schema },
        }
      : undefined;

  // Anthropic-native controls with no IR home are preserved in provider_raw so an
  // anthropic->anthropic round-trip is lossless.
  const providerRaw: Record<string, unknown> = {};
  if (parsed.metadata !== undefined) providerRaw.metadata = parsed.metadata;
  if (parsed.context_management !== undefined) {
    providerRaw.context_management = normalizeAnthropicContextManagement(parsed.context_management);
  }
  if (parsed.mcp_servers !== undefined) providerRaw.mcp_servers = parsed.mcp_servers;
  if (parsed.container !== undefined) providerRaw.container = parsed.container;
  if (parsed.speed !== undefined) providerRaw.speed = parsed.speed;
  if (parsed.output_config !== undefined) providerRaw.output_config = parsed.output_config;

  const ir: IRRequest = {
    model: parsed.model,
    messages: merged,
    ...(parsed.tools !== undefined ? { tools: parsed.tools.map(toIRTool) } : {}),
    ...(parsed.tool_choice !== undefined ? { tool_choice: parsed.tool_choice } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
    ...(parsed.top_k !== undefined ? { top_k: parsed.top_k } : {}),
    ...(parsed.max_tokens !== undefined ? { max_tokens: parsed.max_tokens } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    // Anthropic stop_sequences[] is the IR `stop` (string | string[]) — carried as the
    // array verbatim; the OpenAI/IR side accepts both forms.
    ...(parsed.stop_sequences !== undefined ? { stop: parsed.stop_sequences } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    // The extended-thinking config rides IR.thinking (the provider-shaped reasoning
    // bag), distinct from the per-message `thinking` block extension built above.
    ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
    ...(parsed.service_tier !== undefined ? { service_tier: parsed.service_tier } : {}),
    ...(parsed.cache_control !== undefined ? { cache_control: parsed.cache_control } : {}),
    ...(Object.keys(providerRaw).length > 0 ? { provider_raw: providerRaw } : {}),
  };

  // Per-message thinking BLOCKS (kept out of prompt content) live on provider_raw,
  // never colliding with the request-level thinking CONFIG above. Merge if both.
  if (thinking.length > 0) {
    ir.provider_raw = { ...(ir.provider_raw ?? {}), thinking_blocks: thinking };
  }

  // Final structural validation: the IR we hand downstream is always well-formed.
  return IRRequestSchema.parse(ir);
}

// ——————————————————————————————————————————————————————————————————————————————
// Outbound: IR (OpenAI-Chat shape) -> native Anthropic Messages request (issue #59,
// Theme 1). The inverse of transformRequestOut, completing Anthropic's bidirectional
// protocol surface. This is PROTOCOL translation only: unlike provider/anthropic.ts
// (which serves the OAuth subscription endpoint), it carries NO Claude-Code system
// spoof and NO identity headers — those are provider/transport concerns.
//
// Structural rules (mirroring LiteLLM behavior — referenced, not copied):
//   • system + developer turns fold into the top-level `system` param IN MESSAGE
//     ORDER (LiteLLM map_developer_role_to_system_role; consistent with #50). Emit a
//     string when a single text segment, else text blocks.
//   • assistant.tool_calls -> tool_use blocks (input = JSON.parse(arguments) best-effort).
//   • role:"tool" -> a tool_result block on a user message (tool_use_id = tool_call_id).
//   • IR image data-url -> Anthropic image source {type:"base64", media_type, data}
//     (reverse of the inbound base64->data-url collapse); a remote url passes through
//     as source {type:"url", url}.
//   • tools -> Anthropic tools[{name, description, input_schema}], names sanitized to
//     ^[a-zA-Z0-9_-]{1,128}$ (the shared createAnthropicToolNameMap); the reverse map
//     is stashed in provider_raw for recovery.
//   • tool_choice auto|required|none|{function} -> {type:auto}|{type:any}|omit|{type:tool,name}.
//   • max_tokens is REQUIRED by Anthropic — default 4096 if absent.
//   • response_format json_schema -> output_format {type:json_schema, schema} (Theme 3).

export interface AnthropicTextBlockOut {
  type: "text";
  text: string;
  cache_control?: unknown;
}
export interface AnthropicImageBlockOut {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
  cache_control?: unknown;
}
export interface AnthropicDocumentBlockOut {
  type: "document";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "file"; file_id: string };
  cache_control?: unknown;
}
export interface AnthropicToolUseBlockOut {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlockOut {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
export type AnthropicRequestBlock =
  | AnthropicTextBlockOut
  | AnthropicImageBlockOut
  | AnthropicDocumentBlockOut
  | AnthropicToolUseBlockOut
  | AnthropicToolResultBlockOut;

export interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: AnthropicRequestBlock[];
}

export interface AnthropicOutboundTool {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: unknown;
}

export type AnthropicToolChoiceOut =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "none" }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicThinkingConfigOut {
  type: string;
  budget_tokens?: number;
}

export interface AnthropicOutboundRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlockOut[];
  messages: AnthropicRequestMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicOutboundTool[];
  tool_choice?: AnthropicToolChoiceOut;
  output_format?: AnthropicOutputFormat;
  thinking?: AnthropicThinkingConfigOut;
  service_tier?: string;
  cache_control?: unknown;
  metadata?: unknown;
  context_management?: unknown;
  mcp_servers?: unknown;
  container?: unknown;
  speed?: unknown;
  output_config?: unknown;
}

const DEFAULT_MAX_TOKENS = 4096;

// reasoning_effort -> Anthropic extended-thinking budget (tokens). Anthropic has no
// native effort tiers, so each IR tier maps to a thinking budget (LiteLLM referenced,
// NOT copied). A positive budget emits type:"enabled"; `none` (budget 0) disables
// thinking (handled in thinkingFromIR).
// Exact litellm parity (constants.py + _map_reasoning_effort): minimal/low both floor
// at ANTHROPIC_MIN_THINKING_BUDGET_TOKENS=1024, medium=2048, high=4096, xhigh=8192,
// max=16384, none=0. (The previous helm values low:2048/medium:8192/high:16384 over-
// budgeted 2-4x — a direct billing/latency inflation since thinking tokens bill as output.)
const REASONING_EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 1024,
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16384,
};

function thinkingFromIR(ir: IRRequest): AnthropicThinkingConfigOut | undefined {
  // An explicit thinking config wins: forward it verbatim (LiteLLM passes `thinking`
  // straight through). We narrow the unknown bag to the outbound shape defensively.
  if (ir.thinking !== undefined && ir.thinking !== null && typeof ir.thinking === "object") {
    const cfg = ir.thinking as { type?: unknown; budget_tokens?: unknown };
    if (typeof cfg.type === "string") {
      return {
        type: cfg.type,
        ...(typeof cfg.budget_tokens === "number" ? { budget_tokens: cfg.budget_tokens } : {}),
      };
    }
  }
  // Otherwise derive a budget from reasoning_effort (the cross-protocol knob).
  // `none` maps to budget 0 = disable thinking entirely (Anthropic rejects
  // type:"enabled" with a 0 budget), so only a POSITIVE budget enables it.
  if (ir.reasoning_effort !== undefined) {
    const budget = REASONING_EFFORT_TO_BUDGET[ir.reasoning_effort];
    if (budget !== undefined && budget > 0) return { type: "enabled", budget_tokens: budget };
  }
  return undefined;
}

// IR.stop (string | string[]) -> Anthropic stop_sequences[] (always an array).
function stopSequencesFromIR(stop: IRRequest["stop"]): string[] | undefined {
  if (stop === undefined) return undefined;
  return typeof stop === "string" ? [stop] : stop;
}

function normalizeAnthropicContextManagement(value: unknown): unknown {
  return Array.isArray(value) ? { edits: value } : value;
}

function parseToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

// IR image part (data-url or remote url) -> Anthropic image block (reverse of the
// inbound base64->data-url collapse, pit #5).
function imageBlockFromPart(
  part: Extract<IRContentPart, { type: "image" }>,
): AnthropicImageBlockOut {
  const match = /^data:([^;]+);base64,(.*)$/.exec(part.url);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  return { type: "image", source: { type: "url", url: part.url } };
}

// IR document part -> Anthropic document block. An uploaded-file handle -> {type:"file"}
// source; inline base64 keeps data+media_type; a remote ref -> {type:"url"} source (P7).
function documentBlockFromPart(
  part: Extract<IRContentPart, { type: "document" }>,
): AnthropicDocumentBlockOut {
  if (part.fileId !== undefined) {
    return { type: "document", source: { type: "file", file_id: part.fileId } };
  }
  if (part.data !== undefined) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: part.mediaType ?? "application/pdf",
        data: part.data,
      },
    };
  }
  return { type: "document", source: { type: "url", url: part.url ?? "" } };
}

function contentToBlocks(content: IRMessage["content"]): AnthropicRequestBlock[] {
  if (content === null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  const blocks: AnthropicRequestBlock[] = [];
  for (const part of content) {
    let block: AnthropicRequestBlock | undefined;
    if (part.type === "text") block = { type: "text", text: part.text };
    else if (part.type === "image") block = imageBlockFromPart(part);
    else if (part.type === "document") block = documentBlockFromPart(part);
    // thinking/audio/video parts are not re-emitted on the Anthropic request path
    // (Anthropic Messages has no audio/video content block today).
    if (block === undefined) continue;
    // Re-attach the prompt-cache breakpoint preserved on the IR part (only text/image/
    // document blocks are built here; tool blocks have no cache_control surface).
    const cc = (part as { cache_control?: unknown }).cache_control;
    if (cc !== undefined) (block as { cache_control?: unknown }).cache_control = cc;
    blocks.push(block);
  }
  return blocks;
}

function hasExplicitCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExplicitCacheControl);
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, "cache_control")) return true;
  return Object.values(obj).some(hasExplicitCacheControl);
}

function systemFromMessages(
  messages: readonly IRMessage[],
): string | AnthropicTextBlockOut[] | undefined {
  const blocks: AnthropicTextBlockOut[] = [];
  for (const m of messages) {
    if (m.role !== "system" && m.role !== "developer") continue;
    for (const block of contentToBlocks(m.content)) {
      if (block.type === "text") blocks.push(block);
    }
  }
  if (blocks.length === 0) return undefined;
  // Collapse to a bare string ONLY when nothing carries a cache_control breakpoint —
  // a string has no place for it, so a single cached block must stay a block array.
  const hasCacheControl = blocks.some(
    (b) => (b as { cache_control?: unknown }).cache_control !== undefined,
  );
  if (!hasCacheControl && blocks.length === 1 && blocks[0] !== undefined) return blocks[0].text;
  return blocks;
}

function mapToolChoice(
  toolChoice: unknown,
  toolNameMap: ReturnType<typeof createAnthropicToolNameMap>,
  parallelToolCalls?: boolean,
): AnthropicToolChoiceOut | undefined {
  // parallel_tool_calls:false -> Anthropic disable_parallel_tool_use:true (valid only
  // on auto/any/tool, NOT none). `undefined` means "client didn't ask" -> omit.
  const disable = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (toolChoice === "auto") return { type: "auto", ...disable };
  if (toolChoice === "required") return { type: "any", ...disable };
  if (toolChoice === "none") return { type: "none" };
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const choice = toolChoice as { type?: unknown; function?: { name?: unknown } };
    const name = choice.function?.name;
    if (choice.type === "function" && typeof name === "string" && name !== "") {
      return { type: "tool", name: toolNameMap.toAnthropic(name), ...disable };
    }
  }
  // No explicit tool_choice, but the client disabled parallel tool use: Anthropic
  // requires the flag to ride a tool_choice, so synthesize the default {type:auto}.
  if (parallelToolCalls === false) return { type: "auto", disable_parallel_tool_use: true };
  return undefined;
}

/**
 * IR request -> native Anthropic Messages request. Pure, framework-agnostic
 * (CLAUDE.md principle 1). Reimplemented from public docs/LiteLLM behavior, NOT
 * copied. fail-closed on a structurally invalid IR; never carries provider_raw onto
 * the wire (the gateway strips it; here it is only used to record the tool-name map
 * INTERNALLY and is dropped from the returned object's own enumerable serialization
 * unless a caller opts to keep it — see the matrix test which asserts no leakage).
 */
/**
 * IR -> native Anthropic request AND the structured degradation warnings (n_capped /
 * data_loss) the guard produced. Exposed so a caller (route / pipeline / telemetry)
 * can OBSERVE the degradation — `transformRequestIn` alone returns only the native
 * request and would otherwise drop the warnings (Codex review P2). Pure: the warnings
 * are read off the guarded IR's provider_raw, which never reaches the wire.
 */
export function transformRequestInWithWarnings(ir: IRRequest): {
  request: AnthropicOutboundRequest;
  warnings: ProtocolWarning[];
} {
  return {
    request: transformRequestIn(ir),
    warnings: readWarnings(guardRequestFor("anthropic", ir)),
  };
}

export function transformRequestIn(ir: IRRequest): AnthropicOutboundRequest {
  // P8 inter-translation hardening: cap n>1 (Anthropic emits one candidate) and
  // record data_loss warnings for logprobs/modalities (no Anthropic surface). The
  // guard lives on the IR's provider_raw.warnings, which is stripped before the wire
  // (no leak); here we only consume the guarded IR so the native output is correct.
  // Warnings are surfaced via transformRequestInWithWarnings (above) for observability.
  const parsed = IRRequestSchema.parse(guardRequestFor("anthropic", ir));

  // Sanitize tool names up-front so both the tools[] block and tool_choice map
  // through the SAME forward map (a tool_choice name must match a declared tool).
  const toolNames = (parsed.tools ?? [])
    .map((t) => {
      const fn = (t as { function?: { name?: unknown } }).function;
      return typeof fn?.name === "string" ? fn.name : undefined;
    })
    .filter((n): n is string => n !== undefined);
  const toolNameMap = createAnthropicToolNameMap(toolNames);

  const messages: AnthropicRequestMessage[] = [];
  for (const m of parsed.messages) {
    if (m.role === "system" || m.role === "developer") continue; // folded into system
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content:
              typeof m.content === "string"
                ? m.content
                : m.content === null
                  ? ""
                  : m.content
                      .filter((p): p is { type: "text"; text: string } => p.type === "text")
                      .map((p) => p.text)
                      .join(""),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = contentToBlocks(m.content);
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: toolNameMap.toAnthropic(call.function.name),
          input: parseToolInput(call.function.arguments),
        });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    // user
    messages.push({ role: "user", content: contentToBlocks(m.content) });
  }

  const merged = mergeConsecutiveSameRoleOut(messages);

  const tools: AnthropicOutboundTool[] | undefined =
    parsed.tools !== undefined && parsed.tools.length > 0
      ? parsed.tools.map((t) => {
          const fn = (
            t as {
              cache_control?: unknown;
              function?: {
                name?: unknown;
                description?: unknown;
                parameters?: unknown;
                cache_control?: unknown;
              };
            }
          ).function;
          const toolCacheControl = (t as { cache_control?: unknown }).cache_control;
          const rawName = typeof fn?.name === "string" ? fn.name : "";
          return {
            name:
              rawName === "" ? sanitizeAnthropicToolName("tool") : toolNameMap.toAnthropic(rawName),
            ...(typeof fn?.description === "string" ? { description: fn.description } : {}),
            input_schema: fn?.parameters ?? { type: "object" },
            ...(toolCacheControl !== undefined
              ? { cache_control: toolCacheControl }
              : fn?.cache_control !== undefined
                ? { cache_control: fn.cache_control }
                : {}),
          };
        })
      : undefined;

  const system = systemFromMessages(parsed.messages);
  const toolChoice = mapToolChoice(parsed.tool_choice, toolNameMap, parsed.parallel_tool_calls);
  // responseFormatToOutputFormat invokes filterAnthropicOutputSchema internally, so
  // the outbound output_format drops Anthropic-unsupported constraint keywords.
  const outputFormat = responseFormatToOutputFormat(parsed.response_format);
  const thinking = thinkingFromIR(parsed);
  const stopSequences = stopSequencesFromIR(parsed.stop);

  // NB: the tool-name reverse map is NOT emitted onto the outbound request wire (an
  // Anthropic Messages request has no provider_raw field, and the matrix's no-leak
  // invariant forbids smuggling internal bookkeeping there). It is NOT recoverable
  // from the Anthropic RESPONSE alone — that only carries the sanitized name. The map
  // IS deterministic, though: an orchestrator that called transformRequestIn rebuilds
  // the identical map with `createAnthropicToolNameMap(<original tool names from the
  // IR request>)` and passes it to `transformNativeResponseToIR(res, map)`, which
  // restores `db_query` -> `db.query`. Stateless callers (no map) keep the sanitized
  // name. See response.ts.
  const out: AnthropicOutboundRequest = {
    model: parsed.model,
    max_tokens: parsed.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: merged,
    ...(system !== undefined ? { system } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
    ...(parsed.top_k !== undefined ? { top_k: parsed.top_k } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    ...(stopSequences !== undefined ? { stop_sequences: stopSequences } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(parsed.service_tier !== undefined ? { service_tier: parsed.service_tier } : {}),
    ...(parsed.cache_control !== undefined && !hasExplicitCacheControl([system, merged, tools])
      ? { cache_control: parsed.cache_control }
      : {}),
    // metadata (Anthropic user-attribution) was stashed in provider_raw inbound; re-emit it.
    ...(parsed.provider_raw?.metadata !== undefined
      ? { metadata: parsed.provider_raw.metadata }
      : {}),
    ...(parsed.provider_raw?.context_management !== undefined
      ? {
          context_management: normalizeAnthropicContextManagement(
            parsed.provider_raw.context_management,
          ),
        }
      : {}),
    ...(parsed.provider_raw?.mcp_servers !== undefined
      ? { mcp_servers: parsed.provider_raw.mcp_servers }
      : {}),
    ...(parsed.provider_raw?.container !== undefined
      ? { container: parsed.provider_raw.container }
      : {}),
    ...(parsed.provider_raw?.speed !== undefined ? { speed: parsed.provider_raw.speed } : {}),
    ...(parsed.provider_raw?.output_config !== undefined
      ? { output_config: parsed.provider_raw.output_config }
      : {}),
  };
  return out;
}

// Merge consecutive same-role Anthropic messages (Anthropic forbids them). Concats
// block arrays; never merges across a user/assistant boundary. Mirrors the inbound
// mergeConsecutiveSameRole but on the Anthropic block shape.
function mergeConsecutiveSameRoleOut(
  messages: AnthropicRequestMessage[],
): AnthropicRequestMessage[] {
  const out: AnthropicRequestMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
      continue;
    }
    out.push({ role: msg.role, content: [...msg.content] });
  }
  return out;
}
