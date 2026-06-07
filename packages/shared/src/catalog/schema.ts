import { z } from "zod";

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

export const CapabilitiesSchema = z.object({
  supportsTools: z.boolean(),
  supportsJsonMode: z.boolean(),
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
  maxContextTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative().nullable(),
});

export const PricingSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative().nullable(),
  outputPerMTokUsd: z.number().nonnegative().nullable(),
  // Prompt-cache prices (memory compaction economics). Synced from LiteLLM's
  // cache_read_input_token_cost / cache_creation_input_token_cost. `.default(null)`
  // so pre-existing generated artifacts and partial overrides keep parsing; null
  // means "unpublished" and the consumer applies its own heuristic, NOT zero.
  cacheReadPerMTokUsd: z.number().nonnegative().nullable().default(null),
  cacheWritePerMTokUsd: z.number().nonnegative().nullable().default(null),
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
export const CapabilitiesOverrideEntrySchema = CapabilitiesSchema.partial();
export const PricingOverrideEntrySchema = PricingSchema.partial();

export const CapabilitiesOverrideSchema = z.record(
  z.string().min(1),
  CapabilitiesOverrideEntrySchema,
);
export const PricingOverrideSchema = z.record(z.string().min(1), PricingOverrideEntrySchema);

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type GeneratedCatalogEntry = z.infer<typeof GeneratedCatalogEntrySchema>;
export type GeneratedCatalog = z.infer<typeof GeneratedCatalogSchema>;
export type CapabilitiesOverride = z.infer<typeof CapabilitiesOverrideSchema>;
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;
