// @helm/core — framework-agnostic routing, classification, provider execution,
// protocol translation, and Store ports. MUST NOT import any web framework
// (Hono / SvelteKit / Svelte). See CLAUDE.md principle 1.

export const CORE_PACKAGE = "@helm/core" as const;

// Re-export shared types that gateway/adapters need alongside core ports.
export type { ApiKeyRecord, DecisionRecord } from "@helm/shared";
export {
  type BootstrapDeps,
  type BootstrapResult,
  bootstrapRootKey,
} from "./auth/bootstrap.js";
export {
  extractPrefix,
  type GeneratedKey,
  generateKey,
  hashKey,
  KEY_PREFIX,
} from "./auth/keygen.js";
export {
  type CapabilityRequest,
  checkCapability,
  type FilterResult,
  type SkipReason,
} from "./capability/filter.js";
export {
  type AttemptDecision,
  type BreakerDeps,
  type CircuitBreaker,
  type CircuitConfig,
  type CircuitState,
  createCircuitBreaker,
} from "./circuit/breaker.js";
export {
  type DimensionHit,
  type DimensionScore,
  scoreDimensions,
} from "./classifier/dimensions.js";
export {
  type ClassificationResult,
  type Constraints,
  type ExplanationEntry,
  type ExplanationSource,
  type ScoreRequestDeps,
  scoreRequest,
} from "./classifier/engine.js";
export {
  applyMomentum,
  type MomentumDeps,
  type MomentumEntry,
  type MomentumResult,
  type MomentumStore,
  recordMomentum,
} from "./classifier/momentum.js";
export { createMemoryMomentumStore } from "./classifier/momentum-store.js";
export {
  applyOverrides,
  evaluateOverrides,
  type OverrideHit,
  type OverrideKind,
} from "./classifier/overrides.js";
export {
  detectCodeBlock,
  detectFilePath,
  detectMathNotation,
  detectStackTrace,
  detectTable,
  detectUrl,
} from "./classifier/signals.js";
export {
  detectTask,
  type TaskDetectResult,
  type TaskScore,
  type TaskType,
} from "./classifier/taskdetect.js";
export {
  type Complexity,
  classifyTier,
  sigmoidConfidence,
  type TierResult,
} from "./classifier/tiers.js";
export {
  type Config,
  ConfigError,
  formatIssues,
  type LoadConfigOptions,
  loadConfig,
} from "./config/loader.js";
export {
  type AttemptRecord,
  type Candidate,
  type CapabilityVerdict,
  type FallbackDeps,
  type FallbackOutcome,
  InvokeFailure,
  type InvokeFailureInit,
  type ProviderResult,
  runFallback,
} from "./executor/fallback.js";
export {
  DEFAULT_LANES,
  type Lane,
  type LaneConstraints,
  LaneConstraintsSchema,
  LaneSchema,
  type LanesConfig,
  LanesConfigSchema,
  parseLanesConfig,
} from "./lanes/schema.js";
export {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  createOpenAIClient,
  type OpenAIClientDeps,
  type ProviderClient,
  type ProviderConfig,
  UpstreamError,
} from "./provider/openai.js";
// Provider Registry — alias -> { provider, model, base_url, api_key_env }.
// `ProviderConfig` from this module is aliased to `ProviderRegistryConfig` to
// avoid colliding with the passthrough client's `ProviderConfig` above.
export {
  createProviderRegistry,
  type ProviderConfig as ProviderRegistryConfig,
  type ProviderRegistry,
  RegistryBuildError,
  type ResolvedProvider,
  type ResolveError,
  type ResolveResult,
} from "./provider/registry.js";
export {
  applyCaps,
  evaluatePolicies,
  LANE_RANK,
  type PolicyContext,
  type PolicyOutcome,
} from "./routing/policy-engine.js";
export {
  type PoliciesConfig,
  PoliciesConfigSchema,
  type Policy,
  type PolicyMatch,
  PolicyMatchSchema,
  PolicySchema,
  parsePoliciesConfig,
} from "./routing/policy-schema.js";
export {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  type ExecutionResult,
  type ProviderAttempt as RouteProviderAttempt,
  type RouteDeps,
  type RouteOptions,
  routeRequest,
} from "./routing/route-request.js";
export {
  createSqliteDb,
  runMigrations,
  type SqliteDb,
  SqliteKeyStore,
  SqliteTelemetryStore,
} from "./store/index.js";
export type {
  ConfigStore,
  CreateKeyInput,
  InsertTelemetryInput,
  KeyStore,
  TelemetryStore,
} from "./store/ports.js";
export {
  buildDecisionRecord,
  type ClassifierOutput,
  type DecisionParts,
  type FinalOutcome,
  type LaneSelection,
  type PersistDecisionOptions,
  type PolicyOutcome as TelemetryPolicyOutcome,
  persistDecision,
} from "./telemetry/decision.js";
export { type RedactOptions, redact, redactKey } from "./telemetry/redaction.js";
