import { z } from "zod";
import {
  IRLogprobsSchema,
  type IRMessage,
  IRRequestSchema,
  type IRResponse,
  IRResponseSchema,
  IRTokenDetailsSchema,
} from "./ir.js";
import { resolveReasoning, stripThinkingFromContent } from "./reasoning.js";
import type { NativeRequest, NativeResponse, Transformer } from "./transformer.js";

// OpenAI Chat transformer — the hub IDENTITY transform (docs/05). The IR takes
// the OpenAI Chat Completions shape as its skeleton, so OpenAI's transformer is
// (near) identity: it maps requests/responses almost verbatim into/out of the
// IR. This is the correctness ANCHOR of the whole protocol layer — if OpenAI
// cannot round-trip losslessly, the IR design itself is wrong.
//
// "Identity" is NOT "passthrough": inbound requests are still Zod-validated
// (fail-closed, CLAUDE.md principle 2), and the upstream-native `usage` /
// `finish_reason` are stashed into `provider_raw` so a different client protocol
// (Anthropic/Gemini) can later be reconstructed and billing has the raw values
// (research-notes pits #1 and #2). Framework-agnostic per principle 1; no `any`.

// —— Inbound OpenAI Chat request schema (minimal set). Used purely for
// fail-closed validation; messages are validated structurally by the IR. ——————
const OpenAIChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.unknown()),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

// —— OpenAI usage shape. `prompt_tokens` is the FULL prompt (cached + fresh);
// `prompt_tokens_details.cached_tokens` is the cached slice (pit #2).
// `completion_tokens_details` carries the litellm-parity reasoning/audio breakdown
// (IRTokenDetailsSchema is the shared shape; .passthrough() keeps unknown extras). —
const OpenAIUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
    completion_tokens_details: IRTokenDetailsSchema.optional(),
  })
  .passthrough();

const OpenAIChoiceSchema = z.object({
  index: z.number().int(),
  message: z.object({}).passthrough(),
  finish_reason: z.string().nullable(),
  // litellm-parity: per-choice token logprobs (shared IR shape). Optional + nullable
  // because OpenAI omits it unless `logprobs:true` was requested.
  logprobs: IRLogprobsSchema.nullable().optional(),
});

const OpenAIResponseSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    created: z.number().int().optional(),
    system_fingerprint: z.string().nullable().optional(),
    choices: z.array(OpenAIChoiceSchema),
    usage: OpenAIUsageSchema.optional(),
  })
  .passthrough();

// —— finish_reason -> legal OpenAI value (pit #1). OpenAI clients only accept this
// closed set; any out-of-vocabulary upstream value (e.g. a proxied Anthropic
// "max_tokens") collapses to the nearest legal value while the RAW value stays in
// provider_raw.stop_reason for lossless reconstruction/billing. ————————————————————
const OPENAI_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
]);
function toOpenAIFinishReason(raw: string | null): string | null {
  if (raw === null) return null;
  if (OPENAI_FINISH_REASONS.has(raw)) return raw;
  // Map common cross-protocol aliases; everything else falls back to "stop".
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
    case "STOP":
    case "complete":
      return "stop";
    case "max_tokens":
    case "MAX_TOKENS":
      return "length";
    case "tool_use":
    case "function_call_required":
      return "tool_calls";
    case "content_filtered":
    case "safety":
    case "recitation":
      return "content_filter";
    default:
      return "stop";
  }
}

// —— Request: OpenAI native -> IR (identity, but fail-closed validated). ————————
function toIRRequest(req: NativeRequest) {
  // fail-closed: an invalid request never enters the pipeline (identity != passthrough).
  OpenAIChatRequestSchema.parse(req);
  // Isomorphic mapping; the IR (also OpenAI-shaped) validates the full structure.
  return IRRequestSchema.parse(req);
}

// —— Request: IR -> OpenAI native (identity). The IR is already OpenAI-shaped, so
// we strip only the IR-internal `provider_raw` bag (never a wire field). ————————
function toOpenAIRequest(ir: z.infer<typeof IRRequestSchema>): NativeRequest {
  const { provider_raw: _provider_raw, ...wire } = IRRequestSchema.parse(ir);
  return wire;
}

// —— Response: upstream OpenAI -> IR. Stash raw stop_reason/usage in provider_raw
// (pits #1, #2) and split usage so IR.prompt_tokens is the non-cached input. ————
function toIRResponse(res: NativeResponse): IRResponse {
  const parsed = OpenAIResponseSchema.parse(res);
  const rawUsage = parsed.usage;
  const cached = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const fullPrompt = rawUsage?.prompt_tokens;
  // reasoning_tokens lives under completion_tokens_details (OpenAI o-series); lift it
  // to the flat IRUsage.reasoning_tokens too so cross-protocol billing has one home.
  const completionDetails = rawUsage?.completion_tokens_details;
  const reasoningTokens = completionDetails?.reasoning_tokens;

  const irResponse = {
    id: parsed.id,
    model: parsed.model,
    choices: parsed.choices.map((c) => ({
      index: c.index,
      // message is OpenAI-shaped already (assistant/tool_calls/content +
      // reasoning_content/annotations); the IR message schema validates it.
      message: c.message as IRMessage,
      finish_reason: c.finish_reason,
      ...(c.logprobs !== undefined ? { logprobs: c.logprobs } : {}),
    })),
    usage:
      rawUsage === undefined
        ? undefined
        : {
            // input = prompt - cached (pit #2: never bill cached at full price).
            ...(fullPrompt !== undefined ? { prompt_tokens: fullPrompt - cached } : {}),
            ...(rawUsage.completion_tokens !== undefined
              ? { completion_tokens: rawUsage.completion_tokens }
              : {}),
            ...(cached > 0 ? { cached_tokens: cached } : {}),
            ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
            ...(completionDetails !== undefined
              ? { completion_tokens_details: completionDetails }
              : {}),
          },
    provider_raw: {
      // raw upstream values, untouched, for cross-protocol reconstruction/billing.
      stop_reason: parsed.choices[0]?.finish_reason ?? null,
      ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
      // system_fingerprint is OpenAI-only (no IR home); keep it for re-emission.
      ...(parsed.system_fingerprint != null
        ? { system_fingerprint: parsed.system_fingerprint }
        : {}),
    },
  };
  return IRResponseSchema.parse(irResponse);
}

// —— IR message -> OpenAI-shaped message. Reasoning is surfaced flat on
// message.reasoning_content (the OpenAI o-series/DeepSeek field) and any thinking
// content part is stripped from `content`, since OpenAI clients do not understand a
// {type:"thinking"} content block. A message that already carries reasoning_content
// (native OpenAI origin) is preserved. (P6) ————————————————————————————————————————
function toOpenAIMessage(message: IRMessage): IRMessage {
  const { reasoningText } = resolveReasoning(message);
  const content = stripThinkingFromContent(message.content);
  if (reasoningText === undefined && content === message.content) return message;
  return {
    ...message,
    content,
    ...(reasoningText !== undefined ? { reasoning_content: reasoningText } : {}),
  };
}

// —— Response: IR -> OpenAI native (sent back to the client). Rebuild the OpenAI
// usage shape, adding cached back into prompt_tokens so the full prompt is
// reported (matching the upstream) without double-billing the cache. ——————————
function toOpenAIResponse(res: IRResponse): NativeResponse {
  const parsed = IRResponseSchema.parse(res);
  const u = parsed.usage;
  let usage: Record<string, unknown> | undefined;
  if (u !== undefined) {
    const cached = u.cached_tokens ?? 0;
    const nonCached = u.prompt_tokens ?? 0;
    const fullPrompt = nonCached + cached;
    const completion = u.completion_tokens ?? 0;
    usage = {
      prompt_tokens: fullPrompt,
      completion_tokens: completion,
      total_tokens: fullPrompt + completion,
      ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
      // Re-emit the reasoning/audio breakdown verbatim (OpenAI o-series clients
      // read reasoning_tokens here, not from the flat IR mirror).
      ...(u.completion_tokens_details !== undefined
        ? { completion_tokens_details: u.completion_tokens_details }
        : {}),
    };
  }
  // system_fingerprint round-trips through provider_raw (no IR-native home).
  const rawFingerprint = parsed.provider_raw?.system_fingerprint;
  const systemFingerprint = typeof rawFingerprint === "string" ? rawFingerprint : undefined;
  return {
    id: parsed.id,
    object: "chat.completion",
    // OpenAI responses always carry a `created` epoch-seconds timestamp; computing
    // the current time here is fine (transformer/app code, not pure routing logic).
    created: Math.floor(Date.now() / 1000),
    model: parsed.model,
    ...(systemFingerprint !== undefined ? { system_fingerprint: systemFingerprint } : {}),
    choices: parsed.choices.map((c) => ({
      index: c.index,
      // OpenAI carries reasoning OUT-OF-BAND in message.reasoning_content — a
      // {type:"thinking"} content part (from an Anthropic/Gemini/Responses origin)
      // must NOT leak into the OpenAI `content` array. resolveReasoning unifies the
      // flat + content-block IR shapes; we then strip thinking from content. (P6)
      message: toOpenAIMessage(c.message),
      // map to a legal OpenAI value; the raw value stays in provider_raw.stop_reason.
      finish_reason: toOpenAIFinishReason(c.finish_reason),
      ...(c.logprobs !== undefined ? { logprobs: c.logprobs } : {}),
    })),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export const openaiTransformer: Transformer = {
  name: "openai",
  endPoint: "/v1/chat/completions",

  transformRequestOut(req) {
    return toIRRequest(req);
  },

  transformResponseOut(res) {
    return toOpenAIResponse(res);
  },

  transformRequestIn(ir) {
    return toOpenAIRequest(ir);
  },

  transformResponseIn(res) {
    return toIRResponse(res);
  },
};
