import { z } from "zod";
import {
  type IRContentPart,
  type IRMessage,
  type IRRequest,
  IRRequestSchema,
  type IRToolCall,
} from "../ir.js";

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
  AnthropicToolUseBlockSchema,
  AnthropicToolResultBlockSchema,
  AnthropicThinkingBlockSchema,
  AnthropicRedactedThinkingBlockSchema,
  AnthropicUnknownBlockSchema,
]);

const AnthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
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

const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(AnthropicMessageSchema),
    system: AnthropicSystemSchema.optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stream: z.boolean().optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

// Thinking blocks are kept out of the prompt content and stashed in the IR
// `thinking` extension (the request-level reasoning/thinking passthrough bag).
type IRThinkingExt = { type: "thinking"; text: string; signature?: string };

// —— system: string | block[] -> IR message content (string or multipart). ————————
function normalizeSystem(system: z.infer<typeof AnthropicSystemSchema>): IRMessage["content"] {
  if (typeof system === "string") return system;
  return system.map((b) => ({ type: "text" as const, text: b.text }));
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

  // Rule 1: hoist the top-level system prompt to the head of messages.
  if (parsed.system !== undefined) {
    messages.push({ role: "system", content: normalizeSystem(parsed.system) });
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
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: (block as { text: string }).text });
          break;
        case "image":
          parts.push(
            imagePartFromSource((block as z.infer<typeof AnthropicImageBlockSchema>).source),
          );
          break;
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
    } else {
      // user: emit the user turn (if it has any non-tool_result content), then the
      // fanned-out tool_result messages as standalone role:"tool" turns.
      if (parts.length > 0) messages.push({ role: "user", content: parts });
      for (const tr of toolResults) messages.push(tr);
    }
  }

  // Rule 6: collapse any adjacent same-role turns left after the fan-out.
  const merged = mergeConsecutiveSameRole(messages);

  const ir: IRRequest = {
    model: parsed.model,
    messages: merged,
    ...(parsed.tools !== undefined ? { tools: parsed.tools.map(toIRTool) } : {}),
    ...(parsed.tool_choice !== undefined ? { tool_choice: parsed.tool_choice } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.max_tokens !== undefined ? { max_tokens: parsed.max_tokens } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    ...(thinking.length > 0 ? { thinking } : {}),
  };

  // Final structural validation: the IR we hand downstream is always well-formed.
  return IRRequestSchema.parse(ir);
}
