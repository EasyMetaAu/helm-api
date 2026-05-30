import { z } from "zod";

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
    inlineData: GeminiInlineDataSchema.optional(),
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
  })
  .passthrough();

// —— Request ———————————————————————————————————————————————————————————————————————

export const GeminiGenerateContentRequestSchema = z
  .object({
    contents: z.array(GeminiContentSchema),
    systemInstruction: GeminiContentSchema.optional(),
    tools: z.array(GeminiToolSchema).optional(),
    toolConfig: z.unknown().optional(),
    generationConfig: GeminiGenerationConfigSchema.optional(),
  })
  .passthrough();
export type GeminiGenerateContentRequest = z.infer<typeof GeminiGenerateContentRequestSchema>;

// —— Response ——————————————————————————————————————————————————————————————————————
// finishReason is a Gemini enum; we keep it as a string so an unknown future value
// does not fail parse (the transformer maps it to a legal IR value + keeps raw).

export const GeminiUsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
    cachedContentTokenCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>;

export const GeminiCandidateSchema = z
  .object({
    content: GeminiContentSchema,
    finishReason: z.string().optional(),
    index: z.number().int().optional(),
    safetyRatings: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>;

export const GeminiGenerateContentResponseSchema = z
  .object({
    candidates: z.array(GeminiCandidateSchema).optional(),
    usageMetadata: GeminiUsageMetadataSchema.optional(),
    modelVersion: z.string().optional(),
  })
  .passthrough();
export type GeminiGenerateContentResponse = z.infer<typeof GeminiGenerateContentResponseSchema>;

// —— Streaming (?alt=sse): each SSE event is a COMPLETE GenerateContentResponse
// snapshot, so the SSE event schema is the response schema itself. ————————————————

export const GeminiSSEEventSchema = GeminiGenerateContentResponseSchema;
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
  })
  .partial();

export const IRChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(IRChunkChoiceSchema).optional(),
  usage: IRChunkUsageSchema.nullable().optional(),
});
export type IRChunk = z.infer<typeof IRChunkSchema>;
