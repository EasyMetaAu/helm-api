// @helm/shared — Zod schemas + shared types. Single source of truth for types
// (via z.infer). Framework-agnostic. See CLAUDE.md.

export const SHARED_PACKAGE = "@helm/shared" as const;

// Catalog model — capabilities + pricing, generated (supply-chain) + override
// (manual wins). See CLAUDE.md 实现约定, docs/02 安全规则.
export {
  type Capabilities,
  type CapabilitiesOverride,
  CapabilitiesOverrideSchema,
  CapabilitiesSchema,
  type CatalogEntry,
  CatalogEntrySchema,
  type CatalogSource,
  CatalogSourceSchema,
  type GeneratedCatalog,
  type GeneratedCatalogEntry,
  GeneratedCatalogEntrySchema,
  GeneratedCatalogSchema,
  type Pricing,
  type PricingOverride,
  PricingOverrideSchema,
  PricingSchema,
} from "./catalog/schema.js";

// Layer-2 eval output model (docs/03 §任务分类) — strict JSON the eval model
// emits; validated as untrusted external input, fail-open on any failure.
export {
  type Complexity,
  ComplexitySchema,
  type EvalOutput,
  EvalOutputSchema,
  type TaskType,
  TaskTypeSchema,
} from "./classifier/eval-output.schema.js";
// Classifier config model (docs/03, research-notes Manifest) — DATA-driven
// Layer-1 classifier surface + eval block. Schema is the single type source.
export {
  type ClassifierConfig,
  ClassifierConfigSchema,
  type ClassifierEvalConfig,
  ClassifierEvalConfigSchema,
  type ClassifierRulesConfig,
  ClassifierRulesConfigSchema,
  type DimensionConfig,
  DimensionConfigSchema,
  type Tier,
  TierSchema,
} from "./config/classifier-schema.js";
// Hardened Layer-2 eval config block — single source of truth for the eval
// shape consumed by eval.contract/client/cache/cascade (docs/03 Layer 2).
export {
  type EvalCacheConfig,
  EvalCacheConfigSchema,
  type EvalConfig,
  EvalConfigSchema,
} from "./config/eval-config.schema.js";
// Config model (docs/02, 06).
export {
  type AuthConfig,
  AuthConfigSchema,
  type BootstrapConfig,
  BootstrapConfigSchema,
  type HelmConfig,
  HelmConfigSchema,
  type ProviderConfig,
  ProviderConfigSchema,
  type RateLimitConfig,
  RateLimitConfigSchema,
  type RuntimeConfig,
  RuntimeConfigSchema,
  type ServerConfig,
  ServerConfigSchema,
} from "./config/schema.js";
// Decision record (docs/02, 03, 04, 07).
export {
  type AttemptStatus,
  AttemptStatusSchema,
  type ClassifierDecision,
  ClassifierDecisionSchema,
  type DecidedBy,
  DecidedBySchema,
  type DecisionRecord,
  DecisionRecordSchema,
  type FinalDecision,
  FinalDecisionSchema,
  type LaneDecision,
  LaneDecisionSchema,
  type PolicyDecision,
  PolicyDecisionSchema,
  type ProviderAttempt,
  ProviderAttemptSchema,
} from "./decision/schema.js";
// Structured error model + error_class -> HTTP map (docs/07).
export {
  ERROR_CLASS_HTTP_STATUS,
  type ErrorClass,
  ErrorClassSchema,
  type HelmError,
  HelmErrorSchema,
  makeHelmError,
} from "./error/schema.js";
// API key record (docs/06) — hash + prefix only, never plaintext.
export {
  type ApiKeyRecord,
  ApiKeyRecordSchema,
  type KeyRole,
  KeyRoleSchema,
} from "./key/schema.js";
// Internal request structure (docs/02).
export {
  type InternalRequest,
  InternalRequestSchema,
  type MemoryMode,
  MemoryModeSchema,
  type Protocol,
  ProtocolSchema,
  type RequestMetadata,
  RequestMetadataSchema,
} from "./request/schema.js";
export { version } from "./version.js";
