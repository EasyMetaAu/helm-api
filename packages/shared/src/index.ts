// @helm/shared — Zod schemas + shared types. Single source of truth for types
// (via z.infer). Framework-agnostic. See CLAUDE.md.

export const SHARED_PACKAGE = "@helm/shared" as const;

// Catalog model — capabilities + pricing, generated (supply-chain) + override
// (manual wins). See CLAUDE.md implementation conventions, docs/02 security rules.
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
// Layer-2 eval output model (docs/03 §Task classification) — strict JSON the eval model
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
  ClassifierConfigStrictSchema,
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
// Lane model (config/lanes.yaml, docs/04) — single source of truth for the lane
// abstraction, composed into HelmConfigSchema and re-exported by @helm/core.
export {
  type Lane,
  type LaneConstraints,
  LaneConstraintsSchema,
  LaneSchema,
  type LanesConfig,
  LanesConfigSchema,
  parseLanesConfig,
} from "./config/lanes-schema.js";
// Policy model (config/policies.yaml, docs/04) — server-side first-match routing
// rules; composed into HelmConfigSchema and re-exported by @helm/core.
export {
  type PoliciesConfig,
  PoliciesConfigSchema,
  type Policy,
  type PolicyMatch,
  PolicyMatchSchema,
  PolicySchema,
  parsePoliciesConfig,
} from "./config/policy-schema.js";
// Runtime-mutable settings (admin "System Settings" page) — operator-facing
// config changeable at runtime without a restart. See packages/core settings.
export {
  type LogLevel,
  LogLevelSchema,
  type RuntimeSettings,
  RuntimeSettingsSchema,
} from "./config/runtime-settings.schema.js";
// Config model (docs/02, 06).
export {
  type AuthConfig,
  AuthConfigSchema,
  type BootstrapConfig,
  BootstrapConfigSchema,
  type CompactionOverrides,
  CompactionOverridesSchema,
  type ForgettingConfig,
  ForgettingSchema,
  type HelmConfig,
  HelmConfigSchema,
  isOAuthPreset,
  type MemoryConfig,
  MemoryConfigSchema,
  type MemoryLlmConfig,
  MemoryLlmSchema,
  type OAuthConfig,
  OAuthConfigSchema,
  type OAuthCredential,
  OAuthCredentialSchema,
  type OAuthPresetConfig,
  OAuthPresetConfigSchema,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderModel,
  ProviderModelSchema,
  type RateLimitConfig,
  RateLimitConfigSchema,
  type RateLimitQuota,
  type RateLimitQuotaOverride,
  RateLimitQuotaOverrideSchema,
  RateLimitQuotaSchema,
  type RoutingSignalFeedbackConfig,
  RoutingSignalFeedbackConfigSchema,
  type RuntimeConfig,
  RuntimeConfigSchema,
  type ServerConfig,
  ServerConfigSchema,
  type StoreConfig,
  StoreConfigSchema,
} from "./config/schema.js";
// Admin request-debug list query model (pagination + error/role filters, docs/07).
export {
  REQUESTS_PAGE_SIZE_DEFAULT,
  REQUESTS_PAGE_SIZE_MAX,
  type RequestsQuery,
  RequestsQuerySchema,
} from "./decision/requests-query.js";
// Decision record (docs/02, 03, 04, 07).
export {
  type AttemptErrorDetail,
  AttemptErrorDetailSchema,
  type AttemptStatus,
  AttemptStatusSchema,
  type ClassifierDecision,
  ClassifierDecisionSchema,
  type CostBreakdown,
  CostBreakdownSchema,
  type DecidedBy,
  DecidedBySchema,
  type DecisionRecord,
  DecisionRecordSchema,
  type FinalDecision,
  FinalDecisionSchema,
  type LaneDecision,
  LaneDecisionSchema,
  type MemoryDecision,
  MemoryDecisionSchema,
  type PolicyDecision,
  PolicyDecisionSchema,
  type ProviderAttempt,
  ProviderAttemptSchema,
  type TokenUsageBreakdown,
  TokenUsageSchema,
} from "./decision/schema.js";
// Admin dashboard token-accounting aggregate query model.
export { type StatsQuery, StatsQuerySchema } from "./decision/stats-query.js";
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
  type CreateKeyRequest,
  CreateKeyRequestSchema,
  type KeyRole,
  KeyRoleSchema,
  type MemoryThreadSource,
  MemoryThreadSourceSchema,
  type OverBudgetBehavior,
  OverBudgetBehaviorSchema,
  type UpdateKeyRequest,
  UpdateKeyRequestSchema,
} from "./key/schema.js";
// Memory middleware background-job queue contracts (docs/08 Phase 2).
export {
  type MemoryJobEnqueueInput,
  MemoryJobEnqueueInputSchema,
  type MemoryJobRow,
  MemoryJobRowSchema,
  type MemoryJobType,
  MemoryJobTypeSchema,
} from "./memory/jobs.js";
// Memory middleware storage contracts (docs/08) — POST-MVP persistence floor.
export {
  type AssembledMessage,
  AssembledMessageSchema,
  type AssembledMessageSource,
  AssembledMessageSourceSchema,
  type Fact,
  FactSchema,
  type MemoryFactInput,
  MemoryFactInputSchema,
  type MemoryMessageInput,
  MemoryMessageInputSchema,
  type MemoryObservationInput,
  MemoryObservationInputSchema,
  type MemoryRole,
  MemoryRoleSchema,
  type MemoryStatus,
  MemoryStatusSchema,
  type MemoryThreadInput,
  MemoryThreadInputSchema,
  type Observation,
  ObservationSchema,
  type RawMessage,
  RawMessageSchema,
  type Reflection,
  ReflectionSchema,
  type ReflectionScope,
  ReflectionScopeSchema,
  type ReflectionUpsertInput,
  ReflectionUpsertInputSchema,
} from "./memory/schema.js";
export { decodeScopeId, encodeScopeId } from "./memory/scope-codec.js";
// Public model-listing model (GET /v1/models) — OpenAI-compatible discovery
// envelope; lanes are first-class, concrete aliases are key-gated (principle 6).
export {
  type ModelKind,
  ModelKindSchema,
  type ModelObject,
  ModelObjectSchema,
  type ModelsList,
  ModelsListSchema,
} from "./models/schema.js";
// Per-account OAuth subscription usage + quota observability (providers page).
// Fail-open artifacts: usage = today's served traffic; quota = latest rate-limit
// window snapshot; plus the (untrusted) Anthropic usage-endpoint response shape.
export {
  type AnthropicOAuthUsage,
  AnthropicOAuthUsageSchema,
  type CodexOAuthUsage,
  CodexOAuthUsageSchema,
  type OAuthQuotaSnapshot,
  OAuthQuotaSnapshotSchema,
  type OAuthQuotaWindow,
  OAuthQuotaWindowSchema,
  type OAuthUsageRow,
  OAuthUsageRowSchema,
} from "./oauth/usage-schema.js";
// Internal request structure (docs/02).
export {
  type InternalRequest,
  InternalRequestSchema,
  type MemoryMode,
  MemoryModeSchema,
  type OpenAIChatRequest,
  OpenAIChatRequestSchema,
  type Protocol,
  ProtocolSchema,
  type RequestMetadata,
  RequestMetadataSchema,
  type TargetProviderProtocol,
  TargetProviderProtocolSchema,
} from "./request/schema.js";
// Routing signal (POST-MVP Agentic Signals feedback layer; docs/02 telemetry).
export { type RoutingSignal, RoutingSignalSchema } from "./signals/schema.js";
export { version } from "./version.js";
