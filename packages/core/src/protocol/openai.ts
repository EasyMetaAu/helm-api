import { z } from "zod";
import {
  type IRContentPart,
  IRLogprobsSchema,
  type IRMessage,
  IRReasoningEffortSchema,
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
// response_format is validated FAIL-CLOSED (CLAUDE.md principle 2): a json_schema
// missing its name/schema is a client error, not something to forward to the upstream
// and let it 400 opaquely. text / json_object carry no required sub-fields.
const OpenAIResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).passthrough(),
  z.object({ type: z.literal("json_object") }).passthrough(),
  z
    .object({
      type: z.literal("json_schema"),
      json_schema: z
        .object({
          name: z.string(),
          schema: z.unknown().refine((v) => v !== undefined, { message: "schema is required" }),
          strict: z.boolean().nullable().optional(),
          description: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
]);

const OpenAIChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.unknown()),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  // o-series models require max_completion_tokens; validated here and carried verbatim.
  max_completion_tokens: z.number().int().positive().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().positive().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().nonnegative().optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  modalities: z.array(z.enum(["text", "audio", "image", "video"])).optional(),
  reasoning_effort: IRReasoningEffortSchema.optional(),
  user: z.string().optional(),
  service_tier: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  cached_content: z.string().optional(),
  functions: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  web_search_options: z.unknown().optional(),
  include_server_side_tool_invocations: z.boolean().optional(),
  verbosity: z.string().optional(),
  safety_identifier: z.string().optional(),
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
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
        cache_creation_tokens: z.number().int().nonnegative().optional(),
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      })
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
    service_tier: z.string().nullable().optional(),
    choices: z.array(OpenAIChoiceSchema),
    usage: OpenAIUsageSchema.optional(),
  })
  .passthrough();

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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

// —— Multimodal content normalization (P7). OpenAI clients send NATIVE typed
// content parts — image_url / input_audio / file — which are NOT valid IR part
// discriminants (the IR uses image / audio / document). We normalize them into the
// IR shape inbound and re-emit the native OpenAI shapes outbound so an
// openai->openai round-trip is lossless and other protocols see the unified IR
// parts. Text/thinking/already-IR parts pass through untouched. ————————————————————

// data:<mime>;base64,<data> -> {mime,data}; returns null for a non-data url.
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { mediaType: match[1], data: match[2] };
}

// One native OpenAI content part -> one IR content part. Unknown shapes degrade to a
// JSON text placeholder (fail-open, principle 3) rather than failing the request.
function nativePartToIR(part: unknown): IRContentPart {
  if (typeof part !== "object" || part === null) {
    return { type: "text", text: typeof part === "string" ? part : JSON.stringify(part) };
  }
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text":
      return { type: "text", text: typeof p.text === "string" ? p.text : "" };
    case "image_url": {
      // image_url may be a bare string OR { url, detail }.
      const iu = p.image_url;
      const url =
        typeof iu === "string"
          ? iu
          : typeof iu === "object" &&
              iu !== null &&
              typeof (iu as { url?: unknown }).url === "string"
            ? (iu as { url: string }).url
            : "";
      const parsed = parseDataUrl(url);
      return parsed !== null
        ? { type: "image", url, mediaType: parsed.mediaType }
        : { type: "image", url };
    }
    case "input_audio": {
      const ia = (p.input_audio ?? {}) as { data?: unknown; format?: unknown };
      return {
        type: "audio",
        data: typeof ia.data === "string" ? ia.data : "",
        format: typeof ia.format === "string" ? ia.format : "wav",
      };
    }
    case "file": {
      // OpenAI file content: { file: { file_data?: data-url, file_id?, filename?, format? } }.
      // A PDF data-url becomes an IR document; file_id/url survive on document.url.
      const f = (p.file ?? {}) as {
        file_data?: unknown;
        file_id?: unknown;
        filename?: unknown;
        format?: unknown;
      };
      const fileData = typeof f.file_data === "string" ? f.file_data : undefined;
      const filename = typeof f.filename === "string" ? f.filename : undefined;
      const parsed = fileData !== undefined ? parseDataUrl(fileData) : null;
      if (parsed !== null) {
        return {
          type: "document",
          data: parsed.data,
          mediaType: parsed.mediaType,
          ...(filename !== undefined ? { filename } : {}),
        };
      }
      // An uploaded-file handle is preserved as fileId (NOT url) so it round-trips
      // back to file.file_id; a non-data-url string falls back to a remote url ref.
      const fmt = typeof f.format === "string" ? { mediaType: f.format } : {};
      const name = filename !== undefined ? { filename } : {};
      if (typeof f.file_id === "string") {
        return { type: "document", fileId: f.file_id, ...fmt, ...name };
      }
      return { type: "document", url: fileData ?? "", ...fmt, ...name };
    }
    default:
      // Already an IR-shaped part (image/audio/video/document/thinking) — pass it
      // through; the IR schema validates it. Truly unknown shapes fall to JSON text.
      if (
        p.type === "image" ||
        p.type === "audio" ||
        p.type === "video" ||
        p.type === "document" ||
        p.type === "thinking"
      ) {
        return part as IRContentPart;
      }
      return { type: "text", text: JSON.stringify(part) };
  }
}

// Normalize a native OpenAI message's content (string | part[]) for the IR. A string
// stays a string; an array is normalized part-by-part. Non-content fields are kept.
function normalizeMessageContentToIR(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  const m = message as Record<string, unknown>;
  if (!Array.isArray(m.content)) return message;
  return { ...m, content: m.content.map(nativePartToIR) };
}

// One IR content part -> native OpenAI content part. The inverse of nativePartToIR:
// image -> image_url, audio -> input_audio, document -> file. text passes through.
function irPartToNative(part: IRContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image_url", image_url: { url: part.url } };
    case "audio":
      return { type: "input_audio", input_audio: { data: part.data, format: part.format } };
    case "document": {
      // An uploaded-file handle round-trips back to file.file_id (OpenAI's expected
      // shape); else inline base64 -> file_data data-url; else a remote url -> file_data.
      const name = part.filename !== undefined ? { filename: part.filename } : {};
      if (part.fileId !== undefined) {
        return { type: "file", file: { file_id: part.fileId, ...name } };
      }
      const fileData =
        part.data !== undefined
          ? `data:${part.mediaType ?? "application/octet-stream"};base64,${part.data}`
          : part.url;
      return {
        type: "file",
        file: {
          ...(fileData !== undefined ? { file_data: fileData } : {}),
          ...name,
        },
      };
    }
    default:
      // video / thinking have no native OpenAI content shape — preserve verbatim so a
      // downstream consumer (or an openai->openai round-trip) does not lose them.
      return part;
  }
}

function stripOpenAIPrivateMessageFields(message: IRMessage): IRMessage {
  const { thinking_blocks: _thinking_blocks, ...wireMessage } = message;
  return wireMessage;
}

function normalizeMessageContentToNative(message: IRMessage): IRMessage {
  const wireMessage = stripOpenAIPrivateMessageFields(message);
  if (!Array.isArray(wireMessage.content)) return wireMessage;
  // The IR message type only allows IRContentPart[]; the native shapes we emit are
  // wire-only, so we widen through unknown rather than fight the IR union here.
  return {
    ...wireMessage,
    content: wireMessage.content.map(irPartToNative) as unknown as IRMessage["content"],
  };
}

// —— Request: OpenAI native -> IR. Identity for everything EXCEPT multimodal content
// parts, which are normalized into the IR's typed parts; fail-closed validated. ——————
function toIRRequest(req: NativeRequest) {
  // fail-closed: an invalid request never enters the pipeline (identity != passthrough).
  const parsed = OpenAIChatRequestSchema.parse(req);
  const messages = parsed.messages.map(normalizeMessageContentToIR);
  // Isomorphic mapping; the IR (also OpenAI-shaped) validates the full structure.
  // We carry the full original request through (the minimal schema only validates a
  // subset) but with the multimodal-normalized messages substituted in.
  return IRRequestSchema.parse({ ...(req as Record<string, unknown>), messages });
}

// —— Request: IR -> OpenAI native (identity). The IR is already OpenAI-shaped, so
// we strip only the IR-internal `provider_raw` bag (never a wire field). ————————
function toOpenAIRequest(ir: z.infer<typeof IRRequestSchema>): NativeRequest {
  const { provider_raw: _provider_raw, ...wire } = IRRequestSchema.parse(ir);
  // Re-emit native OpenAI content parts (image_url/input_audio/file) so the wire
  // request a real OpenAI client/upstream expects is reconstructed losslessly (P7).
  return { ...wire, messages: wire.messages.map(normalizeMessageContentToNative) };
}

// —— Response: upstream OpenAI -> IR. Stash raw stop_reason/usage in provider_raw
// (pits #1, #2) and split usage so IR.prompt_tokens is the non-cached input. ————
function toIRResponse(res: NativeResponse): IRResponse {
  const parsed = OpenAIResponseSchema.parse(res);
  const rawUsage = parsed.usage;
  const cached = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreation =
    rawUsage?.prompt_tokens_details?.cache_write_tokens ??
    rawUsage?.prompt_tokens_details?.cache_creation_tokens ??
    rawUsage?.prompt_tokens_details?.cache_creation_input_tokens ??
    0;
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
    ...(parsed.service_tier != null ? { service_tier: parsed.service_tier } : {}),
    usage:
      rawUsage === undefined
        ? undefined
        : {
            // input = prompt - cache read/write (pit #2: never bill cached at full price).
            ...(fullPrompt !== undefined
              ? { prompt_tokens: Math.max(0, fullPrompt - cached - cacheCreation) }
              : {}),
            ...(rawUsage.completion_tokens !== undefined
              ? { completion_tokens: rawUsage.completion_tokens }
              : {}),
            ...(cached > 0 ? { cached_tokens: cached } : {}),
            ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
            ...(rawUsage.prompt_tokens_details !== undefined
              ? { prompt_tokens_details: rawUsage.prompt_tokens_details }
              : {}),
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
  const wireMessage = stripOpenAIPrivateMessageFields(message);
  if (reasoningText === undefined && content === wireMessage.content) return wireMessage;
  return {
    ...wireMessage,
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
    const cached = u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreation =
      u.cache_creation_tokens ??
      tokenCount(u.prompt_tokens_details?.cache_creation_tokens) ??
      tokenCount(u.prompt_tokens_details?.cache_creation_input_tokens) ??
      tokenCount(u.prompt_tokens_details?.cache_write_tokens) ??
      0;
    const nonCached = u.prompt_tokens ?? 0;
    const fullPrompt = nonCached + cached + cacheCreation;
    const completion = u.completion_tokens ?? 0;
    // OpenAI o-series clients read reasoning_tokens from completion_tokens_details, not
    // the flat IR mirror. Prefer the upstream detail object; else synthesize it from
    // the flat IR.usage.reasoning_tokens (e.g. an Anthropic->OpenAI thinking response
    // that only set the flat field) so the detail is never lost on the outbound side.
    const completionDetails =
      u.completion_tokens_details !== undefined
        ? u.completion_tokens_details
        : u.reasoning_tokens !== undefined
          ? { reasoning_tokens: u.reasoning_tokens }
          : undefined;
    usage = {
      prompt_tokens: fullPrompt,
      completion_tokens: completion,
      total_tokens: fullPrompt + completion,
      ...(cached > 0 || cacheCreation > 0
        ? {
            prompt_tokens_details: {
              cached_tokens: cached,
              ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
              ...(u.prompt_tokens_details !== undefined ? u.prompt_tokens_details : {}),
            },
          }
        : u.prompt_tokens_details !== undefined
          ? { prompt_tokens_details: u.prompt_tokens_details }
          : {}),
      ...(completionDetails !== undefined ? { completion_tokens_details: completionDetails } : {}),
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
    ...(parsed.service_tier !== undefined ? { service_tier: parsed.service_tier } : {}),
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
