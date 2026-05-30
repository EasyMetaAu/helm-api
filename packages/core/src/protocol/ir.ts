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
});

export const IRImagePartSchema = z.object({
  type: z.literal("image"),
  // Normalized image reference: a data-url or remote url. Anthropic
  // source:{base64} and OpenAI image_url both collapse into this; any lossy
  // original structure goes into provider_raw.
  url: z.string(),
  mediaType: z.string().optional(),
});

export const IRThinkingPartSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(), // Anthropic thinking signature
});

export const IRContentPartSchema = z.discriminatedUnion("type", [
  IRTextPartSchema,
  IRImagePartSchema,
  IRThinkingPartSchema,
]);
export type IRContentPart = z.infer<typeof IRContentPartSchema>;

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
});
export type IRToolCall = z.infer<typeof IRToolCallSchema>;

// —— Message (role=tool carries tool_call_id; content is a string or multipart,
// and may be null for an assistant turn that only emits tool_calls). —————————

export const IRMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(IRContentPartSchema)]).nullable(),
  tool_calls: z.array(IRToolCallSchema).optional(), // assistant initiates
  tool_call_id: z.string().optional(), // role=tool backfills the matching id
  name: z.string().optional(),
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
  stream: z.boolean().optional(),
  response_format: z.unknown().optional(),
  cache_control: z.unknown().optional(), // extension: cache-control passthrough
  thinking: z.unknown().optional(), // extension: reasoning/thinking config
  provider_raw: ProviderRawSchema.optional(),
});
export type IRRequest = z.infer<typeof IRRequestSchema>;

// —— Usage (input = prompt − cached; see docs/research-notes pit #2). The IR
// only needs room to hold these; the prompt−cached arithmetic is the
// transformer's job. ————————————————————————————————————————————————————————

export const IRUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
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
});
export type IRChoice = z.infer<typeof IRChoiceSchema>;

export const IRResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(IRChoiceSchema),
  usage: IRUsageSchema.optional(),
  provider_raw: ProviderRawSchema.optional(),
});
export type IRResponse = z.infer<typeof IRResponseSchema>;
