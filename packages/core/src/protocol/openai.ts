import { z } from "zod";
import { type IRMessage, IRRequestSchema, type IRResponse, IRResponseSchema } from "./ir.js";
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
// `prompt_tokens_details.cached_tokens` is the cached slice (pit #2). ——————————
const OpenAIUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OpenAIChoiceSchema = z.object({
  index: z.number().int(),
  message: z.object({}).passthrough(),
  finish_reason: z.string().nullable(),
});

const OpenAIResponseSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z.array(OpenAIChoiceSchema),
    usage: OpenAIUsageSchema.optional(),
  })
  .passthrough();

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

  const irResponse = {
    id: parsed.id,
    model: parsed.model,
    choices: parsed.choices.map((c) => ({
      index: c.index,
      // message is OpenAI-shaped already (assistant/tool_calls/content); the IR
      // message schema validates it.
      message: c.message as IRMessage,
      finish_reason: c.finish_reason,
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
          },
    provider_raw: {
      // raw upstream values, untouched, for cross-protocol reconstruction/billing.
      stop_reason: parsed.choices[0]?.finish_reason ?? null,
      ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
    },
  };
  return IRResponseSchema.parse(irResponse);
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
    };
  }
  return {
    id: parsed.id,
    object: "chat.completion",
    model: parsed.model,
    choices: parsed.choices.map((c) => ({
      index: c.index,
      message: c.message,
      finish_reason: c.finish_reason,
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
