import { z } from "zod";
import { ReasoningEffortSchema } from "../config/lanes-schema.js";

// Catalog metadata = per-model capabilities + pricing. Two layers:
//   1. generated  — synced from LiteLLM's model_prices_and_context_window.json
//                   via `pnpm sync:catalog`, checked into the repo. Supply-chain
//                   INPUT, never read at request time to pick a model.
//   2. override   — manual config/capabilities.yaml + config/pricing.yaml.
//                   Manual entries ALWAYS WIN (CLAUDE.md implementation conventions).
// Invalid override → fail-closed (principle 2). See docs/02 security rules.

// Non-image INPUT modalities a backend can accept (P7 multimodal routing). image is
// already gated by supportsVision; this set covers audio / video / document so a lane
// only routes a request carrying that modality to a backend that advertises it.
// Optional: absent ⇒ empty ⇒ the backend accepts NONE of these extra modalities (a
// request without them is unaffected; one WITH them gets an explicit skip reason).
export const InputModalitySchema = z.enum(["audio", "video", "document"]);
export type InputModality = z.infer<typeof InputModalitySchema>;

// Per-model reasoning/effort wire compatibility. The router's normalized
// `reasoning_effort` may become different provider fields per attempt
// (`reasoning.effort`, Anthropic `output_config.effort`, Anthropic `thinking`,
// Gemini `thinkingConfig`). Some models support only a subset of tiers, or only
// one of those wire fields. Config declares that explicitly so the executor can
// map or strip unsupported fields before the upstream call instead of hard-coding
// model ids or burning avoidable 400s.
export const ReasoningEffortWireCapabilitySchema = z
  .strictObject({
    supported: z.boolean(),
    // If omitted with supported:true, every known Helm tier is accepted as-is.
    levels: z.array(ReasoningEffortSchema).nonempty().optional(),
    // Incoming Helm tier -> upstream-supported tier. Unknown keys are allowed so
    // operators can bridge newly observed client tiers before Helm adds them.
    map: z.record(z.string().min(1), ReasoningEffortSchema).optional(),
  })
  .strict();

export const ReasoningEffortCapabilitySchema = z
  .strictObject({
    // OpenAI Chat `reasoning_effort` / Responses `reasoning.effort`.
    openaiReasoning: ReasoningEffortWireCapabilitySchema.optional(),
    // Anthropic adaptive thinking effort: `output_config: { effort }`.
    anthropicOutputConfig: ReasoningEffortWireCapabilitySchema.optional(),
    // Anthropic manual extended thinking: `thinking: { type, budget_tokens }`.
    anthropicThinking: ReasoningEffortWireCapabilitySchema.optional(),
    // Gemini `generationConfig.thinkingConfig`.
    geminiThinkingConfig: ReasoningEffortWireCapabilitySchema.optional(),
  })
  .strict();

export const CapabilitiesSchema = z.object({
  supportsTools: z.boolean(),
  // JSON-output capability as an ORDERED tier (none < object < schema), NOT a boolean:
  //   none   — no JSON mode at all (e.g. `*/auto` aggregators; pruned for any JSON request).
  //   object — `response_format:{type:"json_object"}` only (official DeepSeek: json_object
  //            yes, json_schema 400s "This response_format type is unavailable now").
  //   schema — native strict structured output (`response_format:{type:"json_schema"}` /
  //            Anthropic output_format / Gemini responseSchema). Implies `object`.
  // A boolean cannot express "object but not schema"; that conflation routed a strict
  // json_schema request onto json_object-only DeepSeek → guaranteed upstream 400. Synced
  // from LiteLLM's `supports_response_schema` (schema|none); the `object` tier is set via
  // manual capabilities.yaml overrides.
  jsonOutput: z.enum(["none", "object", "schema"]),
  supportsVision: z.boolean(),
  supportsStreaming: z.boolean(),
  // Extra input modalities (besides text+image) the backend accepts. See above.
  modalities: z.array(InputModalitySchema).optional(),
  // Some upstream relays (e.g. la.atmy.work gpt-5.x) REQUIRE stream:true and 400 a
  // non-stream request ("Stream must be set to true"). That is a request-SHAPE
  // constraint, NOT a capability gap — the model DOES stream (supportsStreaming
  // stays true). Optional: absent ⇒ false (model serves non-stream fine). When
  // true, the capability filter skips this candidate for NON-stream requests
  // (no_nonstream_support) so it never burns an attempt nor poisons the breaker;
  // streaming requests still use it normally.
  requiresStreaming: z.boolean().optional(),
  // Gemini/LiteLLM cachedContent is a REQUIRED provider-side context reference, not
  // a harmless passthrough. Absent ⇒ false so mixed fallback chains never run a
  // cached-content request on a provider that would ignore or reject the reference.
  supportsCachedContent: z.boolean().optional(),
  // IMAGE-GENERATION model: the model OUTPUTS images (gpt-image-2, gemini-*-image
  // "Nano Banana"), not just understands them (that is supportsVision). Absent ⇒ false.
  // An image model is ALWAYS model-pinned — it has no "auto"/classify semantics: the
  // client names it exactly. The router pins it to its exact alias ahead of the
  // model-alias glob shim (route-request §0) so a native-Gemini image request reaches
  // its provider via native passthrough (preserving responseModalities → inlineData)
  // instead of being swallowed by a `gemini-*flash*` glob onto a text lane.
  outputImage: z.boolean().optional(),
  reasoningEffort: ReasoningEffortCapabilitySchema.optional(),
  maxContextTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative().nullable(),
});

const NullablePriceSchema = z.number().nonnegative().nullable();

// A full-request rate card that becomes active once the request crosses an input
// threshold. Providers such as OpenAI and Google price BOTH input and output at
// the higher band when the prompt is over the boundary, so this cannot be modeled
// as a marginal per-token surcharge. Tiers must be strictly ascending to keep
// selection deterministic and config fail-closed.
export const ContextPricingTierSchema = z
  .strictObject({
    minPromptTokens: z.number().int().positive(),
    inputPerMTokUsd: z.number().nonnegative(),
    outputPerMTokUsd: z.number().nonnegative(),
    cacheReadPerMTokUsd: NullablePriceSchema.optional(),
    cacheWritePerMTokUsd: NullablePriceSchema.optional(),
    cacheWrite1hPerMTokUsd: NullablePriceSchema.optional(),
    imageOutputPerMTokUsd: NullablePriceSchema.optional(),
    audioInputPerMTokUsd: NullablePriceSchema.optional(),
    audioCacheReadPerMTokUsd: NullablePriceSchema.optional(),
  })
  .strict();
export type ContextPricingTier = z.infer<typeof ContextPricingTierSchema>;

const ContextPricingTiersSchema = z.array(ContextPricingTierSchema).superRefine((tiers, ctx) => {
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.minPromptTokens <= previous.minPromptTokens
    ) {
      ctx.addIssue({
        code: "custom",
        path: [index, "minPromptTokens"],
        message: "context pricing tiers must be strictly ascending",
      });
    }
  }
});

// Alternative processing modes (for example OpenAI/xAI `priority` or `flex`).
// The upstream-confirmed response tier selects one complete rate card. Some
// providers do not publish a high-context price for a mode; maxPromptTokens makes
// that boundary explicit so costing returns unknown instead of inventing a rate.
export const ServicePricingTierSchema = z
  .strictObject({
    inputPerMTokUsd: z.number().nonnegative(),
    outputPerMTokUsd: z.number().nonnegative(),
    cacheReadPerMTokUsd: NullablePriceSchema.optional(),
    cacheWritePerMTokUsd: NullablePriceSchema.optional(),
    cacheWrite1hPerMTokUsd: NullablePriceSchema.optional(),
    imageOutputPerMTokUsd: NullablePriceSchema.optional(),
    audioInputPerMTokUsd: NullablePriceSchema.optional(),
    audioCacheReadPerMTokUsd: NullablePriceSchema.optional(),
    maxPromptTokens: z.number().int().nonnegative().optional(),
    contextTiers: ContextPricingTiersSchema.optional(),
  })
  .strict();
export type ServicePricingTier = z.infer<typeof ServicePricingTierSchema>;

export const PricingSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative().nullable(),
  outputPerMTokUsd: z.number().nonnegative().nullable(),
  // Prompt-cache prices (memory compaction economics). Synced from LiteLLM's
  // cache_read_input_token_cost / cache_creation_input_token_cost. `.default(null)`
  // so pre-existing generated artifacts and partial overrides keep parsing; null
  // means "unpublished" and the consumer applies its own heuristic, NOT zero.
  cacheReadPerMTokUsd: z.number().nonnegative().nullable().default(null),
  cacheWritePerMTokUsd: z.number().nonnegative().nullable().default(null),
  // Anthropic cache writes have two official TTL rates: 5m (the legacy field
  // above) and 1h. Optional keeps old generated artifacts source-compatible.
  cacheWrite1hPerMTokUsd: NullablePriceSchema.optional(),
  // Image models can return text/thinking and image tokens in one response at
  // different rates. outputPerMTokUsd prices non-image output; this prices IMAGE.
  imageOutputPerMTokUsd: NullablePriceSchema.optional(),
  // Gemini Flash-Lite prices AUDIO prompt/cache tokens differently from
  // text/image/video. Optional rates fall back to the ordinary input/cache card.
  audioInputPerMTokUsd: NullablePriceSchema.optional(),
  audioCacheReadPerMTokUsd: NullablePriceSchema.optional(),
  // Full-request long-context bands (not marginal bands).
  contextTiers: ContextPricingTiersSchema.optional(),
  serviceTiers: z.record(z.string().min(1), ServicePricingTierSchema).optional(),
  // Response-confirmed inference geography multipliers (for example Anthropic's
  // US-only data-residency premium). Kept on the model card so eligibility and
  // rates remain config-as-code instead of model-name branches in the calculator.
  inferenceGeoMultipliers: z.record(z.string().min(1), z.number().positive()).optional(),
});

export const CatalogSourceSchema = z.enum(["generated", "override"]);

export const CatalogEntrySchema = z.object({
  modelKey: z.string().min(1),
  capabilities: CapabilitiesSchema,
  pricing: PricingSchema,
  source: CatalogSourceSchema,
});

// A single generated-catalog file: a checked-in supply-chain artifact.
export const GeneratedCatalogEntrySchema = z.object({
  modelKey: z.string().min(1),
  capabilities: CapabilitiesSchema,
  pricing: PricingSchema,
});

export const GeneratedCatalogSchema = z.object({
  generatedAt: z.string().min(1),
  source: z.string().min(1), // upstream provenance, e.g. "litellm:model_prices_and_context_window.json"
  models: z.array(GeneratedCatalogEntrySchema),
});

// Override files (capabilities.yaml / pricing.yaml). Both are maps keyed by
// modelKey. Every field is optional so a manual entry can override a single
// field (e.g. just supportsVision) without restating the whole record.
// `.strict()` (matching PricingOverrideEntrySchema below) makes an UNKNOWN key
// FAIL-CLOSED (principle 2) instead of being silently stripped. Critical for the
// `supportsJsonMode` → `jsonOutput` tier migration: a stale `supportsJsonMode`
// left in an operator's capabilities.yaml would otherwise be dropped by `.partial()`,
// degrading a manually-JSON-capable alias to `jsonOutput:"none"` so its requests
// silently skip the model. Refuse to boot instead — the operator migrates the key
// to `jsonOutput: none|object|schema` (no safe auto-translation: the old boolean
// conflated object vs schema, which is exactly the bug this migration fixes).
export const CapabilitiesOverrideEntrySchema = CapabilitiesSchema.partial().strict();
// NOT `PricingSchema.partial()`: the cache fields carry `.default(null)`, and
// `.partial()` over a defaulted field still MATERIALIZES the omitted key as null
// on parse — so an operator overriding only `inputPerMTokUsd` would silently wipe
// the generated `cacheReadPerMTokUsd` on the spread merge. Declared explicitly
// (plain optional + nullable, NO defaults): an omitted field stays `undefined`
// and the merge preserves the generated value; an explicit `null` clears it.
export const PricingOverrideEntrySchema = z
  .object({
    inputPerMTokUsd: z.number().nonnegative().nullable().optional(),
    outputPerMTokUsd: z.number().nonnegative().nullable().optional(),
    cacheReadPerMTokUsd: z.number().nonnegative().nullable().optional(),
    cacheWritePerMTokUsd: z.number().nonnegative().nullable().optional(),
    cacheWrite1hPerMTokUsd: NullablePriceSchema.optional(),
    imageOutputPerMTokUsd: NullablePriceSchema.optional(),
    audioInputPerMTokUsd: NullablePriceSchema.optional(),
    audioCacheReadPerMTokUsd: NullablePriceSchema.optional(),
    contextTiers: ContextPricingTiersSchema.optional(),
    serviceTiers: z.record(z.string().min(1), ServicePricingTierSchema).optional(),
    inferenceGeoMultipliers: z.record(z.string().min(1), z.number().positive()).optional(),
  })
  .strict();

export const CapabilitiesOverrideSchema = z.record(
  z.string().min(1),
  CapabilitiesOverrideEntrySchema,
);
export const PricingOverrideSchema = z.record(z.string().min(1), PricingOverrideEntrySchema);

export type ReasoningEffortWireCapability = z.infer<typeof ReasoningEffortWireCapabilitySchema>;
export type ReasoningEffortCapability = z.infer<typeof ReasoningEffortCapabilitySchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type GeneratedCatalogEntry = z.infer<typeof GeneratedCatalogEntrySchema>;
export type GeneratedCatalog = z.infer<typeof GeneratedCatalogSchema>;
export type CapabilitiesOverride = z.infer<typeof CapabilitiesOverrideSchema>;
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;
