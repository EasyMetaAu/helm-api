import { z } from "zod";
import {
  type IRContentPart,
  type IRMessage,
  type IRResponse,
  IRResponseSchema,
  type IRToolCall,
  type IRUsage,
} from "../ir.js";
import { liftReasoningToFlat, resolveReasoning } from "../reasoning.js";

// IR -> Anthropic Messages native response (docs/05, task protocol.anthropic-resp).
// The outbound half of "nativeIn -> IR -> nativeOut, never N×N direct". Two
// high-risk mismatches live here (research-notes pits #1 and #2):
//   1. finish_reason (OpenAI/IR) <-> stop_reason (Anthropic). The OpenAI SDK DROPS
//      a whole response on an illegal enum, while collapsing everything to `end_turn`
//      makes agents silently misjudge. We map to a LEGAL enum AND stash the raw
//      finish_reason in provider_raw.stop_reason so the original is recoverable.
//   2. usage / cached billing. Anthropic splits cache reads into their own field
//      (`cache_read_input_tokens`), so `input_tokens = prompt - cached`. The IR
//      transformer already stores prompt_tokens as the NON-cached input, so we map
//      it straight across and re-expose the cached slice — never double-billing.
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). Reimplemented
// from the docs, NOT copied from musistudio/llms or litellm.

// —— Anthropic native stop_reason enum (the legal output values). pause_turn (a
// long-running tool/agent pause) and refusal (Claude declined) are newer additions;
// both are accepted on output and mapped back to a legal IR finish_reason. ——————————
export const AnthropicStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
]);
export type AnthropicStopReason = z.infer<typeof AnthropicStopReasonSchema>;

// —— Structured cache_creation breakdown (ephemeral 5m / 1h writes). Anthropic
// reports the split alongside the aggregate cache_creation_input_tokens. ——————————
export const AnthropicCacheCreationSchema = z
  .object({
    ephemeral_5m_input_tokens: z.number().int().nonnegative().optional(),
    ephemeral_1h_input_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type AnthropicCacheCreation = z.infer<typeof AnthropicCacheCreationSchema>;

// —— output_tokens_details: Anthropic surfaces the reasoning split here as
// thinking_tokens (mapped to IRUsage.reasoning_tokens). ———————————————————————————
export const AnthropicOutputTokensDetailsSchema = z
  .object({ thinking_tokens: z.number().int().nonnegative().optional() })
  .passthrough();

// —— Anthropic native usage. cache_read/cache_creation are first-class, separate
// from input_tokens (so cache is never billed at full input price). ———————————————
export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation: AnthropicCacheCreationSchema.optional(),
  output_tokens_details: AnthropicOutputTokensDetailsSchema.optional(),
  speed: z.enum(["standard", "fast"]).optional(),
  inference_geo: z.string().optional(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;

// —— Anthropic native content blocks (the subset we emit on the response path). ——
const AnthropicTextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const AnthropicToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const AnthropicThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
const AnthropicRedactedThinkingBlockSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});
// Model-generated image block on the response (P7). source is base64 (data+media_type)
// or a remote url; mirrors the request-side image block shape.
const AnthropicImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
});
const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicThinkingBlockSchema,
  AnthropicRedactedThinkingBlockSchema,
  AnthropicImageBlockSchema,
]);
type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;

export interface AnthropicToolNameMap {
  toAnthropic(name: string): string;
  toOriginal(name: string): string | undefined;
  reverse: Record<string, string>;
}

const ANTHROPIC_TOOL_NAME_MAX = 64;
const TOOL_NAME_SUFFIX_LENGTH = 9; // '_' + 8-char stable hash

function hashToolName(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(8, "0").slice(0, 8);
}

export function sanitizeAnthropicToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const base = cleaned === "" ? "tool" : cleaned;
  return base.slice(0, ANTHROPIC_TOOL_NAME_MAX);
}

function withHashSuffix(base: string, original: string): string {
  const prefix = base
    .slice(0, ANTHROPIC_TOOL_NAME_MAX - TOOL_NAME_SUFFIX_LENGTH)
    .replace(/_+$/g, "");
  return `${prefix}_${hashToolName(original)}`.slice(0, ANTHROPIC_TOOL_NAME_MAX);
}

export function createAnthropicToolNameMap(names: readonly string[] = []): AnthropicToolNameMap {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();

  function register(original: string): string {
    const existing = forward.get(original);
    if (existing !== undefined) return existing;

    const base = sanitizeAnthropicToolName(original);
    let candidate = base;
    const currentOwner = reverse.get(candidate);
    if (currentOwner !== undefined && currentOwner !== original) {
      candidate = withHashSuffix(base, original);
      let counter = 1;
      while (reverse.has(candidate) && reverse.get(candidate) !== original) {
        const suffix = `_${hashToolName(`${original}:${counter}`)}`;
        const prefix = base.slice(0, ANTHROPIC_TOOL_NAME_MAX - suffix.length).replace(/_+$/g, "");
        candidate = `${prefix}${suffix}`;
        counter += 1;
      }
    }

    forward.set(original, candidate);
    reverse.set(candidate, original);
    return candidate;
  }

  for (const name of names) register(name);

  return {
    toAnthropic: register,
    toOriginal: (name) => reverse.get(name),
    get reverse() {
      return Object.fromEntries(reverse);
    },
  };
}

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(AnthropicContentBlockSchema),
  stop_reason: AnthropicStopReasonSchema,
  stop_sequence: z.string().nullable(),
  usage: AnthropicUsageSchema,
});
export type AnthropicMessagesResponse = z.infer<typeof AnthropicMessagesResponseSchema>;

// —— finish_reason -> stop_reason (research-notes pit #1). The mapping ALWAYS lands
// on a legal enum; an unmapped/null value falls back to `end_turn` and the raw
// original is preserved by the caller in provider_raw.stop_reason. ————————————————
const STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use", // legacy OpenAI field
  // content_filter has no perfect Anthropic equivalent; map to a legal enum and
  // keep the raw value in provider_raw for the client to recover.
  content_filter: "stop_sequence",
  stop_sequence: "stop_sequence", // an IR stop-sequence hit forwards as-is
};

/**
 * Map an IR/OpenAI finish_reason to a LEGAL Anthropic stop_reason, returning both
 * the mapped enum and the verbatim raw value. The raw value is what the caller
 * stashes in provider_raw.stop_reason (iron rule: never lose the original).
 */
export function mapStopReason(finish: string): { stop_reason: AnthropicStopReason; raw: string } {
  return { stop_reason: STOP_REASON_MAP[finish] ?? "end_turn", raw: finish };
}

/**
 * Map IR usage to Anthropic usage. IR.prompt_tokens is ALREADY the non-cached
 * input (the inbound transformer subtracted cached), so input_tokens maps straight
 * across and cached is re-exposed as cache_read_input_tokens — cache is never
 * double-counted (pit #2). Missing fields degrade to 0. input is clamped to >= 0
 * to defend against anomalous upstream data (cached > prompt).
 */
export function mapUsage(u: IRUsage): AnthropicUsage {
  const cached = u.cached_tokens ?? 0;
  const input = Math.max(0, u.prompt_tokens ?? 0);
  // cache_creation = ephemeral WRITE tokens (distinct from cache_read). Surface the
  // aggregate, and — when the prompt detail carries the ephemeral split — the
  // structured cache_creation breakdown too.
  const cacheCreation = u.cache_creation_tokens;
  const detail = u.prompt_tokens_details;
  const ephemeral5m = (detail as { ephemeral_5m_input_tokens?: number } | undefined)
    ?.ephemeral_5m_input_tokens;
  const ephemeral1h = (detail as { ephemeral_1h_input_tokens?: number } | undefined)
    ?.ephemeral_1h_input_tokens;
  const breakdown: AnthropicCacheCreation | undefined =
    ephemeral5m !== undefined || ephemeral1h !== undefined
      ? {
          ...(ephemeral5m !== undefined ? { ephemeral_5m_input_tokens: ephemeral5m } : {}),
          ...(ephemeral1h !== undefined ? { ephemeral_1h_input_tokens: ephemeral1h } : {}),
        }
      : undefined;
  // reasoning_tokens -> output_tokens_details.thinking_tokens (Anthropic's name).
  const thinkingTokens = u.reasoning_tokens;
  return {
    input_tokens: input,
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
    ...(breakdown !== undefined ? { cache_creation: breakdown } : {}),
    ...(thinkingTokens !== undefined
      ? { output_tokens_details: { thinking_tokens: thinkingTokens } }
      : {}),
    ...(u.inference_geo !== undefined ? { inference_geo: u.inference_geo } : {}),
  };
}

// —— Tolerant JSON parse for tool_call.arguments. Upstream/stream-fragmented
// arguments may be truncated or have trailing junk; rather than failing the whole
// response, recover the largest balanced JSON object/array prefix. Falls back to
// an empty object so a tool_use block always carries an object input. ————————————
function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const repaired = repairJson(trimmed);
    if (repaired !== undefined) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

// Best-effort JSON repair: scan for a balanced object/array, ignoring brackets
// inside strings, and close any still-open containers. Handles the common
// "unterminated"/"trailing junk" cases without pulling in a dependency.
function repairJson(s: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      else return undefined; // mismatched — not recoverable here
    }
    if (stack.length === 0 && (ch === "}" || ch === "]")) end = i;
  }
  if (end >= 0) return s.slice(0, end + 1); // a balanced prefix exists — use it
  if (stack.length === 0) return undefined;
  // Still open: drop a dangling string, then close all open containers.
  let prefix = s;
  if (inString) {
    const lastQuote = prefix.lastIndexOf('"');
    if (lastQuote >= 0) prefix = prefix.slice(0, lastQuote);
  }
  // Trim a trailing partial token / comma so the close is syntactically valid.
  prefix = prefix.replace(/[,:]\s*$/, "").replace(/\s+$/, "");
  const closers = stack.reverse().join("");
  return prefix + closers;
}

// —— IR assistant message -> Anthropic content blocks. text/thinking come from the
// multipart content; tool_use comes from the separate IR tool_calls array. ————————
function toContentBlocks(
  message: IRResponse["choices"][number]["message"],
  toolNameMap: AnthropicToolNameMap,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const { content } = message;

  // Anthropic-native thinking history may include redacted_thinking blocks. When the
  // structured carrier is present, render it exactly so redacted payloads do not turn
  // into empty visible thinking blocks. Otherwise fall back to resolveReasoning for
  // OpenAI/Gemini/Responses-origin flat reasoning. (P6)
  if (message.thinking_blocks !== undefined && message.thinking_blocks.length > 0) {
    let emittedVisibleThinking = false;
    for (const block of message.thinking_blocks) {
      if (block.type === "redacted_thinking" && typeof block.data === "string") {
        blocks.push({ type: "redacted_thinking", data: block.data });
      } else if (typeof block.thinking === "string") {
        emittedVisibleThinking = true;
        blocks.push({
          type: "thinking",
          thinking: block.thinking,
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
        });
      }
    }
    if (!emittedVisibleThinking) {
      const { thinkingParts } = resolveReasoning(message);
      for (const part of thinkingParts) {
        blocks.push({
          type: "thinking",
          thinking: part.text,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
        });
      }
    }
  } else {
    const { thinkingParts } = resolveReasoning(message);
    for (const part of thinkingParts) {
      blocks.push({
        type: "thinking",
        thinking: part.text,
        ...(part.signature !== undefined ? { signature: part.signature } : {}),
      });
    }
  }

  if (typeof content === "string") {
    if (content !== "") blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      }
      // thinking parts were already emitted via resolveReasoning above.
    }
  }

  // Model-generated images (IRMessage.images) render as Anthropic image blocks (P7):
  // base64 -> {type:"base64",media_type,data}; a remote url -> {type:"url",url}.
  for (const img of message.images ?? []) {
    if (img.b64_json !== undefined) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType ?? "image/png",
          data: img.b64_json,
        },
      });
    } else if (img.url !== undefined) {
      blocks.push({ type: "image", source: { type: "url", url: img.url } });
    }
  }

  for (const call of message.tool_calls ?? []) {
    blocks.push(toToolUseBlock(call, toolNameMap));
  }
  return blocks;
}

function toToolUseBlock(
  call: IRToolCall,
  toolNameMap: AnthropicToolNameMap,
): AnthropicContentBlock {
  return {
    type: "tool_use",
    id: call.id,
    name: toolNameMap.toAnthropic(call.function.name),
    input: parseToolArguments(call.function.arguments),
  };
}

/**
 * IR response -> native Anthropic Messages response. Pure. Always lands on a legal
 * stop_reason and a well-formed usage. Internal raw values remain available on the
 * IR/telemetry path; the public Anthropic response body never exposes provider_raw.
 */
export function transformResponseIn(ir: IRResponse): AnthropicMessagesResponse {
  const choice = ir.choices[0];
  const message = choice?.message ?? { role: "assistant" as const, content: null };
  const { stop_reason } = mapStopReason(choice?.finish_reason ?? "");
  const anthropicSpeed: "fast" | "standard" | undefined =
    ir.service_tier === "fast" ? "fast" : ir.service_tier === "standard" ? "standard" : undefined;
  const usage = {
    ...mapUsage(ir.usage ?? {}),
    ...(anthropicSpeed !== undefined ? { speed: anthropicSpeed } : {}),
  };
  const toolNameMap = createAnthropicToolNameMap(
    (message.tool_calls ?? []).map((call) => call.function.name),
  );

  const out: AnthropicMessagesResponse = {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ir.model,
    content: toContentBlocks(message, toolNameMap),
    stop_reason,
    stop_sequence: null,
    usage,
  };

  // Final structural validation: the response handed to the client is well-formed.
  return AnthropicMessagesResponseSchema.parse(out);
}

// ——————————————————————————————————————————————————————————————————————————————
// Inbound: native Anthropic Messages response -> IR (issue #59, Theme 2). The
// reverse of transformResponseIn, completing Anthropic's bidirectional surface.
// Reference anthropicToOpenAIResponse (provider/anthropic.ts) but emit a VALIDATED
// IRResponse, with reverse stop_reason/usage mapping and raw preserved.

// —— stop_reason (Anthropic) -> finish_reason (IR/OpenAI): the reverse of
// STOP_REASON_MAP. tool_use -> tool_calls, max_tokens -> length, the rest -> stop.
const STOP_REASON_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  // pause_turn is a long-running agent/tool pause — there is no OpenAI equivalent, so
  // it bottoms out at `stop` (the raw value survives in provider_raw). refusal (Claude
  // declined) is OpenAI's content_filter (LiteLLM _FINISH_REASON_MAP).
  pause_turn: "stop",
  refusal: "content_filter",
};

// Tolerant inbound schema for a native Anthropic response. Block/usage shapes use
// passthrough so unknown fields survive; thinking blocks are recovered into the IR
// thinking content part.
const InboundTextBlockSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();
const InboundToolUseBlockSchema = z
  .object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })
  .passthrough();
const InboundThinkingBlockSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional() })
  .passthrough();
const InboundRedactedThinkingBlockSchema = z
  .object({ type: z.literal("redacted_thinking"), data: z.string() })
  .passthrough();
// Model-generated image block on an inbound native response (P7) -> IRMessage.images.
const InboundImageBlockSchema = z
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
const InboundUnknownBlockSchema = z.object({ type: z.string() }).passthrough();
const InboundContentBlockSchema = z.union([
  InboundTextBlockSchema,
  InboundToolUseBlockSchema,
  InboundThinkingBlockSchema,
  InboundRedactedThinkingBlockSchema,
  InboundImageBlockSchema,
  InboundUnknownBlockSchema,
]);

const InboundUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation: AnthropicCacheCreationSchema.optional(),
    output_tokens_details: AnthropicOutputTokensDetailsSchema.optional(),
    speed: z.string().optional(),
    inference_geo: z.string().optional(),
  })
  .passthrough();

const InboundResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(InboundContentBlockSchema),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    // Anthropic Sonnet 4+ carries a stop_details object alongside stop_reason; it has
    // no IR home, so it is preserved verbatim in provider_raw.
    stop_details: z.unknown().optional(),
    usage: InboundUsageSchema.optional(),
  })
  .passthrough();

/**
 * Native Anthropic Messages response -> IR. Pure, framework-agnostic. text blocks ->
 * message content, tool_use -> IR tool_calls (arguments = JSON.stringify(input)),
 * thinking -> IR thinking content part. stop_reason -> finish_reason (reverse map),
 * raw kept in provider_raw.stop_reason. usage: input_tokens is ALREADY the non-cached
 * input on the Anthropic wire, so prompt_tokens = input_tokens and cached_tokens =
 * cache_read_input_tokens (never double-billed). Raw usage stashed in provider_raw.
 */
export function transformNativeResponseToIR(
  native: unknown,
  toolNameMap?: AnthropicToolNameMap,
): IRResponse {
  const res = InboundResponseSchema.parse(native);

  const parts: IRContentPart[] = [];
  const toolCalls: IRToolCall[] = [];
  const images: NonNullable<IRMessage["images"]> = [];
  const redactedThinkingBlocks: NonNullable<IRMessage["thinking_blocks"]> = [];
  for (const block of res.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: (block as z.infer<typeof InboundTextBlockSchema>).text });
    } else if (block.type === "image") {
      // Model-generated image -> IRMessage.images (NOT an input content part) (P7).
      const src = (block as z.infer<typeof InboundImageBlockSchema>).source;
      if (src.type === "url" && src.url !== undefined) {
        images.push({ url: src.url, ...(src.media_type ? { mediaType: src.media_type } : {}) });
      } else if (src.data !== undefined) {
        images.push({
          b64_json: src.data,
          ...(src.media_type ? { mediaType: src.media_type } : {}),
        });
      }
    } else if (block.type === "thinking") {
      const b = block as z.infer<typeof InboundThinkingBlockSchema>;
      parts.push({
        type: "thinking",
        text: b.thinking,
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
      });
    } else if (block.type === "redacted_thinking") {
      const b = block as z.infer<typeof InboundRedactedThinkingBlockSchema>;
      redactedThinkingBlocks.push({ type: "redacted_thinking", data: b.data });
    } else if (block.type === "tool_use") {
      const b = block as z.infer<typeof InboundToolUseBlockSchema>;
      // Restore the ORIGINAL tool name when the request-side sanitizer map is
      // threaded in (e.g. `db.query` was sent as `db_query`). Without the map we
      // pass Anthropic's name through unchanged — the best we can do statelessly.
      toolCalls.push({
        id: b.id,
        type: "function",
        function: {
          name: toolNameMap?.toOriginal(b.name) ?? b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
    // unknown block types are tolerated (fail-open) and dropped from content.
  }

  // Lift the thinking content parts onto the flat reasoning_content/thinking_blocks
  // carriers so a downstream OpenAI client (which reads message.reasoning_content,
  // not a content-block thinking part) receives the reasoning losslessly (P6).
  const lifted = liftReasoningToFlat({
    role: "assistant",
    content: parts.length > 0 ? parts : toolCalls.length > 0 || images.length > 0 ? null : "",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(images.length > 0 ? { images } : {}),
  });
  const message: IRMessage =
    redactedThinkingBlocks.length > 0
      ? {
          ...lifted,
          thinking_blocks: [...(lifted.thinking_blocks ?? []), ...redactedThinkingBlocks],
        }
      : lifted;

  const rawStop = res.stop_reason ?? null;
  const finishReason = rawStop !== null ? (STOP_REASON_TO_FINISH[rawStop] ?? "stop") : null;

  const u = res.usage;
  // cache_creation aggregate: prefer the explicit field, else sum the ephemeral split.
  const cacheCreation = (() => {
    if (u === undefined) return undefined;
    if (u.cache_creation_input_tokens !== undefined) return u.cache_creation_input_tokens;
    const c = u.cache_creation;
    if (c === undefined) return undefined;
    const sum = (c.ephemeral_5m_input_tokens ?? 0) + (c.ephemeral_1h_input_tokens ?? 0);
    return sum > 0 ? sum : undefined;
  })();
  const thinkingTokens = u?.output_tokens_details?.thinking_tokens;
  const cacheCreationDetails = u?.cache_creation;
  const usage: IRUsage | undefined =
    u !== undefined
      ? {
          ...(u.input_tokens !== undefined ? { prompt_tokens: u.input_tokens } : {}),
          ...(u.output_tokens !== undefined ? { completion_tokens: u.output_tokens } : {}),
          ...(u.cache_read_input_tokens !== undefined
            ? { cached_tokens: u.cache_read_input_tokens }
            : {}),
          ...(cacheCreation !== undefined ? { cache_creation_tokens: cacheCreation } : {}),
          ...(cacheCreationDetails !== undefined
            ? {
                prompt_tokens_details: {
                  ...(cacheCreationDetails.ephemeral_5m_input_tokens !== undefined
                    ? {
                        ephemeral_5m_input_tokens: cacheCreationDetails.ephemeral_5m_input_tokens,
                      }
                    : {}),
                  ...(cacheCreationDetails.ephemeral_1h_input_tokens !== undefined
                    ? {
                        ephemeral_1h_input_tokens: cacheCreationDetails.ephemeral_1h_input_tokens,
                      }
                    : {}),
                },
              }
            : {}),
          ...(thinkingTokens !== undefined ? { reasoning_tokens: thinkingTokens } : {}),
          ...(u.inference_geo !== undefined ? { inference_geo: u.inference_geo } : {}),
        }
      : undefined;

  const ir: IRResponse = {
    id: res.id ?? `anthropic_${Date.now()}`,
    model: res.model ?? "anthropic",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(u?.speed !== undefined ? { service_tier: u.speed } : {}),
    ...(usage !== undefined ? { usage } : {}),
    provider_raw: {
      ...(rawStop !== null ? { stop_reason: rawStop } : {}),
      ...(res.stop_details !== undefined ? { stop_details: res.stop_details } : {}),
      ...(u !== undefined ? { usage: u } : {}),
    },
  };
  return IRResponseSchema.parse(ir);
}
