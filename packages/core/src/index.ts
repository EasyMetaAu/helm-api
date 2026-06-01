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
  billedCostFromBody,
  computeCostUsd,
  resolveCostUsd,
  type TokenUsage,
  usageFromBody,
} from "./catalog/cost.js";
export { CatalogError, type LoadCatalogDeps, loadCatalog } from "./catalog/index.js";
export { type LoadRuntimeCatalogOptions, loadRuntimeCatalog } from "./catalog/load.js";
export {
  type AttemptDecision,
  type BreakerDeps,
  type CircuitBreaker,
  type CircuitConfig,
  type CircuitState,
  createCircuitBreaker,
} from "./circuit/breaker.js";
export {
  type CascadeDeps,
  type ClassificationResult as CascadeResult,
  classify as classifyCascade,
  type DecidedBy as CascadeDecidedBy,
  type EvalDecisionResult,
  type LaneId,
  type RulesResult,
} from "./classifier/cascade.js";
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
  createEvalCache,
  type EvalCache,
  type EvalCachedDeps,
  runEvalCached,
} from "./classifier/eval/cache.js";
export {
  buildEvalCacheKey,
  type CanonicalEvalInput,
  type ClassifierInput,
  toCanonicalInput,
} from "./classifier/eval/cache-key.js";
export {
  CircuitOpenError as EvalCircuitOpenError,
  type EvalClientDeps,
  type EvalDecision,
  type EvalFailReason,
  type EvalLogEvent,
  type EvalModelRequest,
  type EvalModelResponse,
  runEval,
} from "./classifier/eval/client.js";
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
  boundaryConfidence,
  type Complexity,
  classifyTier,
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
// Memory middleware — inject phase (docs/08 Phase 2). Synchronous on the request
// path: load + assemble a budgeted, cache-friendly context prefix in the fixed
// docs/08 order, enqueue write-back, fail-open. Framework-agnostic; never touches
// routing/lane state.
export {
  assembleInjectedContext,
  type InjectDeps,
  type InjectInput,
  type InjectResult,
} from "./memory/inject.js";
// Memory middleware — observe phase (docs/08 Phase 1). Framework-agnostic
// write-only persistence; never injects memory or changes routing.
export {
  type IRToolResult,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  resolveMemoryMode,
} from "./memory/observe.js";
// Memory middleware — background Reflector (docs/08 Phase 2). Periodically merges a
// scope's observations into a stable, versioned reflection; off the main request
// path, fail-open. Framework-agnostic; never touches routing/lane state.
export {
  type ReflectorDeps,
  type ReflectorJob,
  type ReflectorResult,
  runReflectorJob,
} from "./memory/reflector.js";
export {
  type MemoryMeta,
  MemoryMetaSchema,
  type MemoryScope,
  MemoryScopeSchema,
} from "./memory/types.js";
// Anthropic Messages transformer — the second client-presentation surface
// (docs/05). Inbound native->IR, outbound IR->native (+ stream state machine +
// error translation). Reimplemented from the docs, not copied from upstream.
export {
  type AnthropicErrorEnvelope,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResponse,
  AnthropicMessagesResponseSchema,
  type AnthropicSSEEvent,
  AnthropicSSEEventSchema,
  type AnthropicStopReason,
  AnthropicStopReasonSchema,
  type AnthropicUsage,
  AnthropicUsageSchema,
  anthropicTransformer,
  convertOpenAIStreamToAnthropic,
  makeAnthropicError,
  mapStopReason,
  mapUsage,
  type OpenAIChunk,
  OpenAIChunkSchema,
  synthesizeSSEFromJSON,
  transformErrorOut as anthropicTransformErrorOut,
  transformRequestOut as anthropicTransformRequestOut,
  transformResponseIn as anthropicTransformResponseIn,
} from "./protocol/anthropic/index.js";
// Protocol IR — the single central representation (docs/05). All translation
// goes nativeIn -> IR -> nativeOut. Types are z.infer of these schemas.
export {
  type IRChoice,
  IRChoiceSchema,
  type IRContentPart,
  IRContentPartSchema,
  IRImagePartSchema,
  type IRMessage,
  IRMessageSchema,
  type IRRequest,
  IRRequestSchema,
  type IRResponse,
  IRResponseSchema,
  IRTextPartSchema,
  IRThinkingPartSchema,
  type IRToolCall,
  IRToolCallSchema,
  type IRUsage,
  IRUsageSchema,
  type ProviderRaw,
  ProviderRawSchema,
} from "./protocol/ir.js";
// OpenAI Chat transformer — the hub identity transform (docs/05); correctness
// anchor for the protocol layer (nativeIn -> IR -> nativeOut, isomorphic).
export { openaiTransformer } from "./protocol/openai.js";
// Protocol transformer contract + registry + framework-agnostic endpoint mount
// (docs/05). 5-method contract per protocol; the gateway wires real routes.
export {
  DuplicateEndpointError,
  DuplicateTransformerError,
  mountEndpoints,
  TransformerRegistry,
} from "./protocol/registry.js";
// OpenAI Responses transformer — the third client presentation surface (docs/05);
// folds the flat input[] item stream into the IR and explodes it back out.
export { mapResponsesStatus, responsesTransformer } from "./protocol/responses.js";
// Streaming primitives (docs/05): generic SSE splitter, shared per-direction
// state machine + idempotent close guards, and the JSON->SSE synthesizer for
// cache hits / non-streaming upstreams. Framework-agnostic (Web ReadableStream).
export {
  type Controller,
  createStreamState,
  parseSSEData,
  readSSE,
  type SSEFrame,
  type StreamState,
  safeClose,
  safeEnqueue,
  synthesizeSSE,
} from "./protocol/streaming.js";
export type {
  BehaviorTransformer,
  NativeRequest,
  NativeResponse,
  Transformer,
} from "./protocol/transformer.js";
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
  toRegistryProviders,
} from "./provider/registry.js";
// OAuth subscription providers (issue #38): non-interactive token manager
// (refresh_token / client_credentials), single-flight refresh, injected clock.
// Framework-agnostic; env→secret resolution stays in the composition root.
export {
  createTokenManager,
  type ResolvedOAuth,
  type TokenManager,
  type TokenManagerDeps,
  TokenRefreshError,
} from "./provider/token-manager.js";
export {
  createRateLimiter,
  type RateLimiterDeps,
} from "./ratelimit/limiter.js";
export {
  type BucketState,
  type ConsumeResult,
  refill,
  tryConsume,
} from "./ratelimit/token-bucket.js";
export type {
  RateLimitConfig,
  RateLimitProbe,
  RateLimitQuota,
  RateLimitQuotaOverride,
  RateLimitResult,
} from "./ratelimit/types.js";
export {
  type Classification as LaneResolverClassification,
  type LaneDecision,
  type PolicyOutcome as LaneResolverPolicyOutcome,
  type ResolveLaneInput,
  resolveLane,
} from "./routing/lane-resolver.js";
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
// Runtime-mutable settings (admin "System Settings") — load/seed/persist the
// operator-facing config subset that can change at runtime without a restart.
export {
  defaultSettingsFromConfig,
  loadRuntimeSettings,
  RUNTIME_SETTINGS_KEY,
  type SettingsLog,
  saveRuntimeSettings,
} from "./settings/runtime-settings.js";
// Agentic Signals — POST-MVP low-cost production feedback layer (docs/02,
// research-notes "Plano"). Pure aggregator + background collector that distill
// REDACTED routing signals from already-persisted decision records, ASYNCHRONOUS
// and OFF the request path. Observe-only: this task never feeds signals back into
// routing. Framework-agnostic; fail-open.
export { aggregateSignals } from "./signals/aggregate.js";
export {
  createSignalCollector,
  type SignalCollector,
  type SignalCollectorDeps,
} from "./signals/collector.js";
export {
  type SignalSchedulerDeps,
  type SignalSchedulerHandle,
  startSignalScheduler,
} from "./signals/scheduler.js";
export type { RoutingSignal } from "./signals/types.js";
export {
  type CreateStoreOptions,
  createPgDb,
  createPgliteDb,
  createSqliteDb,
  createStore,
  InMemoryRateLimitStore,
  InMemorySignalStore,
  PgConfigStore,
  type PgDb,
  PgKeyStore,
  PgMemoryStore,
  PgRateLimitStore,
  PgSignalStore,
  PgTelemetryStore,
  runMigrations,
  runPgMigrations,
  SqliteConfigStore,
  type SqliteDb,
  SqliteKeyStore,
  SqliteMemoryStore,
  SqliteRateLimitStore,
  SqliteSignalStore,
  SqliteTelemetryStore,
  type StoreSet,
} from "./store/index.js";
export type {
  ConfigStore,
  CreateKeyInput,
  InsertPayloadInput,
  InsertTelemetryInput,
  KeyStore,
  MemoryJobStatus,
  MemoryStore,
  RateLimitConsumeResult,
  RateLimitStore,
  RequestPayload,
  SignalStore,
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
