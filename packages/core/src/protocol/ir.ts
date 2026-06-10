import { z } from "zod";

// IR — the unified central representation of the protocol layer (docs/05). All
// translation goes nativeIn -> IR -> nativeOut, so N protocols need 2N transform
// functions instead of N². The IR takes the OpenAI Chat Completions shape as its
// skeleton (the de-facto standard that litellm/Portkey/new-api/one-api/Bifrost
// independently converge on) and EXTENDS it with optional fields that carry the
// Anthropic/Gemini differences: thinking/reasoning blocks, multipart typed
// content (image/document), tool-call IDs, cache-control, and — most importantly
// — the `provider_raw` passthrough bag that holds upstream-native fields
// (raw stop_reason / usage) which cannot be mapped losslessly.
//
// This module is the SINGLE TYPE SOURCE for the protocol layer: transformers,
// the streaming state machine, and the error model all `z.infer` from here.
// Per CLAUDE.md principle 1, packages/core imports no web framework; per the
// Zod schema-first rule, every type below comes from z.infer (no hand-written
// interfaces, no `any`). See docs/05-protocol-translation.md.

// —— Multipart content (text / image / thinking) ————————————————————————————
// Each part is a discriminated union on `type`, so an unknown `type` fails
// closed rather than slipping through.

export const IRTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  // Anthropic prompt-cache breakpoint on this block (e.g. {type:"ephemeral"}). No
  // other protocol has a per-block cache knob, so it rides as an optional passthrough.
  cache_control: z.unknown().optional(),
});

export const IRImagePartSchema = z.object({
  type: z.literal("image"),
  // Normalized image reference: a data-url or remote url. Anthropic
  // source:{base64} and OpenAI image_url both collapse into this; any lossy
  // original structure goes into provider_raw.
  url: z.string(),
  mediaType: z.string().optional(),
  cache_control: z.unknown().optional(), // Anthropic per-block cache breakpoint
});

export const IRThinkingPartSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(), // Anthropic thinking signature
});

// —— Multimodal input parts (litellm parity). Audio carries inline base64 + a
// format hint (wav/mp3/…); video/document accept a remote url OR inline base64 and
// optional metadata. The transformer enforces per-provider rules; the IR only needs
// a lossless home so audio/video/document survive translation. ————————————————————
export const IRAudioPartSchema = z.object({
  type: z.literal("audio"),
  data: z.string(), // base64
  format: z.string(), // wav | mp3 | aac | flac | pcm | …
  transcript: z.string().optional(),
});

export const IRVideoPartSchema = z.object({
  type: z.literal("video"),
  url: z.string().optional(), // remote / gs:// reference
  data: z.string().optional(), // OR inline base64
  mediaType: z.string().optional(),
  fps: z.number().optional(),
  startOffset: z.string().optional(), // e.g. "1.5s"
  endOffset: z.string().optional(),
});

export const IRDocumentPartSchema = z.object({
  type: z.literal("document"),
  url: z.string().optional(), // remote http(s) reference
  data: z.string().optional(), // base64 (e.g. PDF)
  fileId: z.string().optional(), // provider-uploaded file handle (OpenAI file_id / Anthropic file source)
  mediaType: z.string().optional(),
  filename: z.string().optional(),
  cache_control: z.unknown().optional(), // Anthropic per-block cache breakpoint
});

export const IRContentPartSchema = z.discriminatedUnion("type", [
  IRTextPartSchema,
  IRImagePartSchema,
  IRThinkingPartSchema,
  IRAudioPartSchema,
  IRVideoPartSchema,
  IRDocumentPartSchema,
]);
export type IRContentPart = z.infer<typeof IRContentPartSchema>;

// —— Shared parity sub-schemas (litellm unified model). Declared once here and
// reused by IRMessage/IRChoice/IRUsage AND the streaming chunk (gemini-types.ts) and
// the OpenAI chunk (anthropic/stream.ts), so reasoning/citations/logprobs/usage-
// detail have ONE shape across every protocol. All permissive (.passthrough() where
// upstreams add fields) and fail-open on unknown extras. ——————————————————————————

/**
 * Reasoning effort knob (OpenAI o-series / Anthropic budget / Gemini level).
 *
 * Tolerant by design (litellm parity): the type stays a finite union — so budget
 * tables and the Gemini thinking-config map stay exhaustive/type-safe — but the
 * PARSE never throws. Real clients ship new tiers over time (Codex added `xhigh`;
 * `max` exists too), so any UNRECOGNIZED string is clamped to `high` instead of
 * 400ing the request (an over-strict enum is exactly what broke Codex with
 * `effort:"xhigh"`). Known tiers (incl. none/xhigh/max) round-trip losslessly and
 * are forwarded to upstreams that understand them; budget-based providers
 * (Anthropic/Gemini) map them to a thinking budget. Mirrors litellm
 * REASONING_EFFORT = none|minimal|low|medium|high|xhigh (+max) and its
 * passthrough-or-clamp model — never a hard reject.
 */
export const IR_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const IRReasoningEffortSchema = z.preprocess(
  (v) =>
    typeof v === "string" && !(IR_REASONING_EFFORTS as readonly string[]).includes(v) ? "high" : v,
  z.enum(IR_REASONING_EFFORTS),
);
export type IRReasoningEffort = z.infer<typeof IRReasoningEffortSchema>;

/** A thinking/redacted-thinking block (Anthropic-shaped; reused for streaming). */
export const IRThinkingBlockSchema = z
  .object({
    type: z.string(), // "thinking" | "redacted_thinking"
    thinking: z.string().optional(),
    data: z.string().optional(), // redacted payload
    signature: z.string().optional(),
  })
  .passthrough();
export type IRThinkingBlock = z.infer<typeof IRThinkingBlockSchema>;

/** A citation/annotation (OpenAI url_citation shape; grounding folds in here). */
export const IRAnnotationSchema = z
  .object({
    type: z.string(), // "url_citation" | "file_citation" | …
    url: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    start_index: z.number().int().optional(),
    end_index: z.number().int().optional(),
  })
  .passthrough();
export type IRAnnotation = z.infer<typeof IRAnnotationSchema>;

/** Token-level logprobs (OpenAI ChoiceLogprobs shape). */
export const IRTopLogprobSchema = z.object({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int()).nullable().optional(),
});
export const IRLogprobTokenSchema = z.object({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int()).nullable().optional(),
  top_logprobs: z.array(IRTopLogprobSchema).optional(),
});
export const IRLogprobsSchema = z
  .object({
    content: z.array(IRLogprobTokenSchema).nullable().optional(),
    // refusal track (OpenAI ChoiceLogprobs.refusal) — a structural home so
    // cross-protocol consumers read it from the schema, not blind passthrough.
    refusal: z.array(IRLogprobTokenSchema).nullable().optional(),
  })
  .passthrough();
export type IRLogprobs = z.infer<typeof IRLogprobsSchema>;

/** A model-generated image (vision/image-out models). */
export const IRImageOutSchema = z.object({
  url: z.string().optional(),
  b64_json: z.string().optional(),
  mediaType: z.string().optional(),
  revised_prompt: z.string().optional(),
});

/** A model-generated audio response (OpenAI ChatCompletionAudioResponse shape). */
export const IRAudioOutSchema = z.object({
  id: z.string().optional(),
  data: z.string().optional(),
  transcript: z.string().optional(),
  expires_at: z.number().int().optional(),
});

/** Per-modality / cache token breakdown (prompt or completion side). */
export const IRTokenDetailsSchema = z
  .object({
    text_tokens: z.number().int().nonnegative().optional(),
    audio_tokens: z.number().int().nonnegative().optional(),
    image_tokens: z.number().int().nonnegative().optional(),
    video_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cache_creation_tokens: z.number().int().nonnegative().optional(),
  })
  .partial()
  .passthrough();

// —— Tool call (carries an ID; OpenAI's integer stream index is reconciled by
// the streaming state machine, not stored here). ————————————————————————————

export const IRToolCallSchema = z.object({
  id: z.string(), // tool-call ID; synthesized by the transformer when Gemini omits one
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    // arguments is a JSON STRING (OpenAI shape), never a parsed object. Stream
    // fragmentation / jsonrepair is the transformer's job — IR does not parse it.
    arguments: z.string(),
  }),
  // The OpenAI streaming integer index, when an upstream supplied an explicit
  // (possibly non-sequential) one. Lets stream synthesis preserve parallel-tool-call
  // ordering instead of blindly re-sequencing by array position.
  openaiIndex: z.number().int().nonnegative().optional(),
});
export type IRToolCall = z.infer<typeof IRToolCallSchema>;

// —— Message (role=tool carries tool_call_id; content is a string or multipart,
// and may be null for an assistant turn that only emits tool_calls). `developer`
// is OpenAI's renamed system tier — kept as a FIRST-CLASS role so it survives the
// IR intact; protocols without a developer concept fold it into their system
// instruction (see gemini-transformer's collectSystemText). ————————————————————

export const IRMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(IRContentPartSchema)]).nullable(),
  tool_calls: z.array(IRToolCallSchema).optional(), // assistant initiates
  tool_call_id: z.string().optional(), // role=tool backfills the matching id
  name: z.string().optional(),
  // —— litellm-parity response extensions (all optional). reasoning_content is the
  // flat reasoning string (DeepSeek/Groq/o-series); thinking_blocks is the structured
  // Anthropic form (kept in parallel, NOT folded into content). annotations carries
  // citations/grounding. images/audio carry model-GENERATED media (distinct from the
  // input image/audio content parts). ————————————————————————————————————————————————
  reasoning_content: z.string().nullable().optional(),
  thinking_blocks: z.array(IRThinkingBlockSchema).optional(),
  annotations: z.array(IRAnnotationSchema).optional(),
  images: z.array(IRImageOutSchema).optional(),
  audio: IRAudioOutSchema.optional(),
});
export type IRMessage = z.infer<typeof IRMessageSchema>;

// —— provider_raw passthrough bag: upstream-native fields that cannot be mapped
// losslessly. `.catchall(z.unknown())` is REQUIRED — without it unknown upstream
// fields would be stripped, breaking the lossless-passthrough goal. ——————————

export const ProviderRawSchema = z
  .object({
    stop_reason: z.unknown().optional(), // raw upstream finish/stop value (pre-mapping)
    usage: z.unknown().optional(), // raw upstream usage (billing / reconstruction)
  })
  .catchall(z.unknown()); // any other native field is retained verbatim
export type ProviderRaw = z.infer<typeof ProviderRawSchema>;

// —— Request ————————————————————————————————————————————————————————————————

export const IRRequestSchema = z.object({
  model: z.string(),
  messages: z.array(IRMessageSchema),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  // o-series models require max_completion_tokens instead of max_tokens. The IR has
  // no .catchall, so without this explicit field it is stripped on inbound parse.
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  response_format: z.unknown().optional(),
  cache_control: z.unknown().optional(), // extension: cache-control passthrough
  // Provider prompt-cache controls that affect request affinity / cached-content reuse.
  // OpenAI-compatible clients use prompt_cache_*; Gemini/LiteLLM use cached_content.
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  cached_content: z.string().optional(),
  thinking: z.unknown().optional(), // extension: provider-shaped reasoning/thinking config
  // —— litellm-parity sampling + control params (all optional). The IR holds them;
  // each transformer maps the subset its protocol supports and warns/passes through
  // the rest (a backend that can't honor `n>1` rejects cleanly, never silently drops).
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
  // Additional LiteLLM/OpenAI-compatible request knobs that have a native OpenAI
  // Chat surface and therefore must survive OpenAI -> IR -> OpenAI and gateway
  // execution. Provider-specific routing knobs such as api_key/base_url remain
  // deliberately excluded for security.
  functions: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  web_search_options: z.unknown().optional(),
  include_server_side_tool_invocations: z.boolean().optional(),
  verbosity: z.string().optional(),
  safety_identifier: z.string().optional(),
  provider_raw: ProviderRawSchema.optional(),
});
export type IRRequest = z.infer<typeof IRRequestSchema>;

// —— Usage (input = prompt minus cache read/write; see docs/research-notes pit #2).
// The IR only needs room to hold these; the cache arithmetic is the transformer's job.
// ————————————————————————————————————————————————————————————————————————————

export const IRUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
    // —— litellm-parity usage detail (all optional). reasoning_tokens (o-series /
    // Gemini thoughtsTokenCount), cache_creation_tokens (Anthropic ephemeral write),
    // and per-modality breakdowns. The cache arithmetic stays the transformer's job;
    // the IR only needs room to hold the detail. ————————————————————————————————
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cache_creation_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: IRTokenDetailsSchema.optional(),
    completion_tokens_details: IRTokenDetailsSchema.optional(),
  })
  .partial();
export type IRUsage = z.infer<typeof IRUsageSchema>;

// —— Response ——————————————————————————————————————————————————————————————
// finish_reason is NOT narrowed to an enum here: mapping to a legal value is the
// transformer's job (docs/research-notes pit #1). IR only guarantees the raw
// value has a home in provider_raw.stop_reason.

export const IRChoiceSchema = z.object({
  index: z.number().int(),
  message: IRMessageSchema,
  finish_reason: z.string().nullable(),
  logprobs: IRLogprobsSchema.nullable().optional(), // litellm-parity token logprobs
});
export type IRChoice = z.infer<typeof IRChoiceSchema>;

export const IRResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(IRChoiceSchema),
  usage: IRUsageSchema.optional(),
  // OpenAI Chat / Responses report the resolved service tier on the response; a
  // first-class home so it survives cross-protocol (no .catchall on this schema).
  service_tier: z.string().optional(),
  provider_raw: ProviderRawSchema.optional(),
});
export type IRResponse = z.infer<typeof IRResponseSchema>;
