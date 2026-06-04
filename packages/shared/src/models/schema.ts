import { z } from "zod";
import { CapabilitiesSchema, PricingSchema } from "../catalog/schema.js";

// Public model-listing schema for GET /v1/models — the OpenAI-compatible model
// discovery endpoint. Single source of truth via z.infer (no hand-written types).
//
// Principle 6 (expose the lane abstraction, NOT the model market): the listing's
// FIRST-CLASS entries are LANES (economy/balanced/premium/…) plus the `auto`
// directive — that is all a default key ever sees. Concrete provider aliases
// (a supply-chain detail) are emitted ONLY for keys with allow_custom_model
// (they already bypass the lane abstraction by design), enriched with the
// capability/pricing metadata those keys need to choose a model. The gateway
// route decides which set to include per authenticated key; this schema only
// describes the shape.

// Distinguishes a lane/`auto` selector (`lane`) from a concrete provider alias
// (`model`). A Helm extension to the OpenAI model object — OpenAI clients ignore
// unknown fields, so the response stays drop-in compatible.
export const ModelKindSchema = z.enum(["lane", "model"]);
export type ModelKind = z.infer<typeof ModelKindSchema>;

// One entry in the listing. The first four fields are the OpenAI model object
// (`id`/`object`/`created`/`owned_by`); the rest are Helm extensions. `created`
// is a stable constant (Helm has no per-model creation date) — OpenAI clients
// only require the field to be present.
export const ModelObjectSchema = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  // "helm" for lanes/`auto`; the provider name (alias prefix) for a concrete model.
  owned_by: z.string().min(1),
  type: ModelKindSchema,
  // Lanes whose expanded chain includes this entry. For a lane entry it is the
  // lane itself; for a model alias it is every lane that can route to it. Omitted
  // for `auto`.
  lanes: z.array(z.string().min(1)).optional(),
  // Capability + pricing metadata, present only for concrete model aliases that
  // have a catalog entry (lanes carry none — they are an abstraction).
  capabilities: CapabilitiesSchema.optional(),
  pricing: PricingSchema.optional(),
});
export type ModelObject = z.infer<typeof ModelObjectSchema>;

// Top-level GET /v1/models envelope — OpenAI-compatible `{ object: "list", data }`.
export const ModelsListSchema = z.object({
  object: z.literal("list"),
  data: z.array(ModelObjectSchema),
});
export type ModelsList = z.infer<typeof ModelsListSchema>;
