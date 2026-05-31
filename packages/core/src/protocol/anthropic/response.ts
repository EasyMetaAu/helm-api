import { z } from "zod";
import type { IRResponse, IRToolCall, IRUsage } from "../ir.js";

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

// —— Anthropic native stop_reason enum (the only legal output values). —————————————
export const AnthropicStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
]);
export type AnthropicStopReason = z.infer<typeof AnthropicStopReasonSchema>;

// —— Anthropic native usage. cache_read/cache_creation are first-class, separate
// from input_tokens (so cache is never billed at full input price). ———————————————
export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
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
const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicThinkingBlockSchema,
]);
type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;

// —— provider_raw passthrough bag carried on the response (raw upstream
// stop_reason / usage, for cross-protocol reconstruction + billing). —————————————
const ProviderRawSchema = z
  .object({ stop_reason: z.unknown().optional(), usage: z.unknown().optional() })
  .catchall(z.unknown());

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(AnthropicContentBlockSchema),
  stop_reason: AnthropicStopReasonSchema,
  stop_sequence: z.string().nullable(),
  usage: AnthropicUsageSchema,
  provider_raw: ProviderRawSchema.optional(),
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
  return {
    input_tokens: input,
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
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
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const { content } = message;

  if (typeof content === "string") {
    if (content !== "") blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "thinking") {
        blocks.push({
          type: "thinking",
          thinking: part.text,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
        });
      }
      // image parts are inbound-only on the response path; nothing to emit.
    }
  }

  for (const call of message.tool_calls ?? []) {
    blocks.push(toToolUseBlock(call));
  }
  return blocks;
}

function toToolUseBlock(call: IRToolCall): AnthropicContentBlock {
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.arguments),
  };
}

/**
 * IR response -> native Anthropic Messages response. Pure. Always lands on a legal
 * stop_reason and a well-formed usage; the raw upstream stop_reason/usage ride
 * along in provider_raw so a client (or billing) can reconstruct the original.
 */
export function transformResponseIn(ir: IRResponse): AnthropicMessagesResponse {
  const choice = ir.choices[0];
  const message = choice?.message ?? { role: "assistant" as const, content: null };
  const { stop_reason, raw } = mapStopReason(choice?.finish_reason ?? "");
  const usage = mapUsage(ir.usage ?? {});

  const out: AnthropicMessagesResponse = {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ir.model,
    content: toContentBlocks(message),
    stop_reason,
    stop_sequence: null,
    usage,
    provider_raw: {
      stop_reason: raw,
      ...(ir.usage !== undefined ? { usage: ir.usage } : {}),
    },
  };

  // Final structural validation: the response handed to the client is well-formed.
  return AnthropicMessagesResponseSchema.parse(out);
}
