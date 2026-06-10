import { z } from "zod";
import {
  IRAnnotationSchema,
  IRAudioOutSchema,
  IRLogprobsSchema,
  IRThinkingBlockSchema,
  IRTokenDetailsSchema,
} from "../ir.js";

// Gemini generateContent / streamGenerateContent wire schemas (docs/05). Zod is the
// SINGLE type source (CLAUDE.md): every Gemini type below is `z.infer`-ed, never a
// hand-written interface. `.passthrough()` keeps unknown upstream fields alive for
// forward compatibility (e.g. safetyRatings, citationMetadata) instead of stripping
// them. The transformer narrows raw JSON with these schemas; core imports no
// framework. Reimplemented from the public Gemini API docs, NOT copied from a vendor
// SDK. No `any`.

// —— Parts (a Gemini `content.parts[]` element). A part is one of: text, inlineData
// (base64 blob), functionCall, functionResponse. Modeled as a permissive object so
// an unknown future part shape does not fail parse (fail-open). ————————————————————

export const GeminiInlineDataSchema = z.object({
  mimeType: z.string(),
  data: z.string(), // base64
});

// fileData references a remote/uploaded blob (gs:// or Files API uri) instead of
// inlining base64. Used for large audio/video/document inputs (P7 multimodal).
export const GeminiFileDataSchema = z.object({
  mimeType: z.string().optional(),
  fileUri: z.string(),
});

// videoMetadata rides ALONGSIDE an inlineData/fileData video part: frame-sampling rate
// and a clip window. Offsets are duration strings ("1.5s"). (P7 multimodal)
export const GeminiVideoMetadataSchema = z
  .object({
    fps: z.number().optional(),
    startOffset: z.string().optional(),
    endOffset: z.string().optional(),
  })
  .passthrough();

export const GeminiFunctionCallSchema = z.object({
  name: z.string(),
  args: z.unknown().optional(), // parsed object (Gemini sends JSON object, not a string)
});

export const GeminiFunctionResponseSchema = z.object({
  name: z.string(),
  response: z.unknown().optional(),
});

export const GeminiPartSchema = z
  .object({
    text: z.string().optional(),
    // thought=true marks a reasoning part (Gemini "thinking" output); thoughtSignature
    // is the opaque signature Gemini attaches to a thought part. Declared explicitly
    // (was only surviving via passthrough) so the reasoning bridge can read them. (P6)
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    inlineData: GeminiInlineDataSchema.optional(),
    fileData: GeminiFileDataSchema.optional(),
    videoMetadata: GeminiVideoMetadataSchema.optional(),
    functionCall: GeminiFunctionCallSchema.optional(),
    functionResponse: GeminiFunctionResponseSchema.optional(),
  })
  .passthrough();
export type GeminiPart = z.infer<typeof GeminiPartSchema>;

// —— Content (a turn). Gemini roles are user|model (no system role — that lives in
// the top-level systemInstruction). role is optional on streamed snapshots. ————————

export const GeminiContentSchema = z
  .object({
    role: z.enum(["user", "model"]).optional(),
    parts: z.array(GeminiPartSchema),
  })
  .passthrough();
export type GeminiContent = z.infer<typeof GeminiContentSchema>;

// —— Tools: functionDeclarations[].parameters is an OpenAPI-subset JSON Schema. ————

export const GeminiFunctionDeclarationSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  })
  .passthrough();

export const GeminiToolSchema = z
  .object({
    functionDeclarations: z.array(GeminiFunctionDeclarationSchema).optional(),
  })
  .passthrough();
export type GeminiTool = z.infer<typeof GeminiToolSchema>;

// —— generationConfig: a subset of generation knobs we translate. ——————————————————

export const GeminiGenerationConfigSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    responseMimeType: z.string().optional(),
    responseSchema: z.unknown().optional(),
    // —— litellm-parity sampling/control knobs (camelCase Gemini wire names). All
    // optional; the transformer maps the IR's flat OpenAI-shaped params onto these.
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    frequencyPenalty: z.number().optional(),
    presencePenalty: z.number().optional(),
    seed: z.number().int().optional(),
    stopSequences: z.array(z.string()).optional(),
    candidateCount: z.number().int().positive().optional(),
    responseLogprobs: z.boolean().optional(),
    logprobs: z.number().int().nonnegative().optional(),
    responseModalities: z.array(z.string()).optional(),
    // thinkingConfig{thinkingBudget?, includeThoughts?} (Gemini reasoning control).
    thinkingConfig: z
      .object({
        thinkingBudget: z.number().int().optional(),
        includeThoughts: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// —— Request ———————————————————————————————————————————————————————————————————————
// safetySettings is an opaque array (HarmCategory/threshold tuples) we passthrough
// rather than model — it is provider supply-chain config, not an IR concept.

export const GeminiGenerateContentRequestSchema = z
  .object({
    contents: z.array(GeminiContentSchema),
    systemInstruction: GeminiContentSchema.optional(),
    tools: z.array(GeminiToolSchema).optional(),
    toolConfig: z.unknown().optional(),
    generationConfig: GeminiGenerationConfigSchema.optional(),
    safetySettings: z.array(z.unknown()).optional(),
    cachedContent: z.string().optional(),
    thinkingConfig: z.unknown().optional(),
  })
  .passthrough();
export type GeminiGenerateContentRequest = z.infer<typeof GeminiGenerateContentRequestSchema>;

// —— Response ——————————————————————————————————————————————————————————————————————
// finishReason is a Gemini enum; we keep it as a string so an unknown future value
// does not fail parse (the transformer maps it to a legal IR value + keeps raw).

// Per-modality token detail entry: {modality, tokenCount} (Gemini usage breakdown).
export const GeminiModalityTokenCountSchema = z
  .object({
    modality: z.string().optional(),
    tokenCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const GeminiUsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
    cachedContentTokenCount: z.number().int().nonnegative().optional(),
    // —— litellm-parity usage detail. thoughtsTokenCount is the reasoning-token count
    // (-> IRUsage.reasoning_tokens); the *Details arrays carry per-modality breakdown.
    thoughtsTokenCount: z.number().int().nonnegative().optional(),
    promptTokensDetails: z.array(GeminiModalityTokenCountSchema).optional(),
    candidatesTokensDetails: z.array(GeminiModalityTokenCountSchema).optional(),
    // The per-modality breakdown of the CACHED prompt tokens (distinct from the
    // aggregate cachedContentTokenCount). Without this the cached count is dropped
    // entirely when Gemini reports only the breakdown.
    cacheTokensDetails: z.array(GeminiModalityTokenCountSchema).optional(),
  })
  .passthrough();
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>;

export const GeminiCandidateSchema = z
  .object({
    content: GeminiContentSchema,
    finishReason: z.string().optional(),
    index: z.number().int().optional(),
    safetyRatings: z.array(z.unknown()).optional(),
    // —— litellm-parity candidate annotations. groundingMetadata/citationMetadata fold
    // into IRMessage.annotations (url_citation); logprobsResult -> IRChoice.logprobs.
    groundingMetadata: z.unknown().optional(),
    citationMetadata: z.unknown().optional(),
    logprobsResult: z.unknown().optional(),
  })
  .passthrough();
export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>;

// promptFeedback: when blockReason is present the whole prompt was rejected upstream
// (no candidates). The transformer surfaces it as finish_reason content_filter and
// stashes the raw block in provider_raw.
export const GeminiPromptFeedbackSchema = z
  .object({
    blockReason: z.string().optional(),
    safetyRatings: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type GeminiPromptFeedback = z.infer<typeof GeminiPromptFeedbackSchema>;

export const GeminiGenerateContentResponseSchema = z
  .object({
    candidates: z.array(GeminiCandidateSchema).optional(),
    usageMetadata: GeminiUsageMetadataSchema.optional(),
    modelVersion: z.string().optional(),
    promptFeedback: GeminiPromptFeedbackSchema.optional(),
  })
  .passthrough();
export type GeminiGenerateContentResponse = z.infer<typeof GeminiGenerateContentResponseSchema>;

// —— Streaming (?alt=sse): each SSE event is a GenerateContentResponse carrying an
// INCREMENTAL delta (clients accumulate text frame to frame). The event shape equals
// the response shape, so the SSE event schema reuses the response schema. ——————————

// A streamed frame is normally a response snapshot, but Gemini can also push a
// top-level `error` frame ({error:{code,message,status}}) mid-stream. We allow it on
// the SSE event so transformStreamIn can detect and surface it instead of silently
// dropping a failed generation.
export const GeminiErrorSchema = z
  .object({
    code: z.number().int().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const GeminiSSEEventSchema = GeminiGenerateContentResponseSchema.extend({
  error: GeminiErrorSchema.optional(),
});
export type GeminiSSEEvent = z.infer<typeof GeminiSSEEventSchema>;

// —— IR chunk (the IR-level streaming delta). The IR is OpenAI-Chat shaped, so its
// streaming chunk is the OpenAI chat.completion.chunk shape. Declared here (the
// protocol layer has no shared chunk module yet) and exported so the gateway/other
// transformers can consume it. Schema-first; type via z.infer. ————————————————————

export const IRToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

export const IRChunkDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(IRToolCallDeltaSchema).optional(),
  // —— litellm-parity streaming delta extensions (all optional). reasoning_content
  // streams ahead of text (DeepSeek/o-series); thinking_blocks/annotations/audio/
  // logprobs ride the same delta. Shared shapes come from ir.ts so every protocol's
  // stream machine emits/consumes ONE form. ————————————————————————————————————————
  reasoning_content: z.string().nullable().optional(),
  thinking_blocks: z.array(IRThinkingBlockSchema).optional(),
  annotations: z.array(IRAnnotationSchema).optional(),
  audio: IRAudioOutSchema.optional(),
  logprobs: IRLogprobsSchema.nullable().optional(),
});

export const IRChunkChoiceSchema = z.object({
  index: z.number().int(),
  delta: IRChunkDeltaSchema.optional(),
  finish_reason: z.string().nullable().optional(),
});

export const IRChunkUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cache_creation_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: IRTokenDetailsSchema.optional(),
    completion_tokens_details: IRTokenDetailsSchema.optional(),
  })
  .partial();

export const IRChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(IRChunkChoiceSchema).optional(),
  usage: IRChunkUsageSchema.nullable().optional(),
});
export type IRChunk = z.infer<typeof IRChunkSchema>;
