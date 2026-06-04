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
  activeDims,
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetConfig,
  type BudgetGateDeps,
  type BudgetProbe,
  type BudgetUsage,
  createBudgetGate,
  type SettleBudgetDeps,
  settleBudget,
  windowMsFor,
} from "./budget/index.js";
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
export { type BuildModelsListInput, buildModelsList } from "./catalog/models-list.js";
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
// Memory middleware — inject↔IR bridge (docs/08 Phase 2). The D7 plain-text gate +
// D8 RawMessage synthesis / source→IR restoration shared by all request surfaces.
export {
  type InjectBridgeDeps,
  type InjectBridgeResult,
  injectIntoIR,
  isPlainTextTurn,
} from "./memory/inject-bridge.js";
// Memory middleware — observe phase (docs/08 Phase 1). Framework-agnostic
// write-only persistence; never injects memory or changes routing.
export {
  type IRToolResult,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  ownerScopedThreadId,
  resolveMemoryMode,
} from "./memory/observe.js";
// Memory middleware — background Observer (docs/08 Phase 2). Off the request path:
// compresses a thread's older raw messages into one auditable observation.
// Framework-agnostic; never touches routing/lane state.
export {
  type ObserverDeps,
  type ObserverJob,
  type ObserverResult,
  runObserverJob,
} from "./memory/observer.js";
// Memory middleware — background Reflector (docs/08 Phase 2). Periodically merges a
// scope's observations into a stable, versioned reflection; off the main request
// path, fail-open. Framework-agnostic; never touches routing/lane state.
export {
  type ReflectorDeps,
  type ReflectorJob,
  type ReflectorResult,
  runReflectorJob,
} from "./memory/reflector.js";
// Memory middleware — background worker scheduler (docs/08 Phase 2). Drains the
// memory_jobs queue off the request path, dispatching by type. Framework-agnostic.
export {
  type MemoryWorkerDeps,
  type MemoryWorkerHandle,
  startMemoryWorker,
} from "./memory/scheduler.js";
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
// Gemini-native error envelope transformer (docs/05, 07). HelmError -> the Google
// google.rpc.Status { error: { code, message, status } } shape; status/code from
// err.http_status.
export {
  type GeminiErrorEnvelope,
  makeGeminiError,
  transformErrorOut as geminiTransformErrorOut,
} from "./protocol/gemini/error.js";
// Gemini transformer + route parser (docs/05, issue #34/#52). nativeIn -> IR ->
// nativeOut, plus the pure path parser the gateway hands `{model}:{op}` to.
export {
  GEMINI_API_KEY_HEADER,
  GEMINI_ENDPOINT,
  type GeminiRoute,
  geminiTransformer,
  parseGeminiPath,
} from "./protocol/gemini/gemini-transformer.js";
// Gemini wire types (docs/05). GenerateContentRequest/Response + the snapshot SSE
// event + the OpenAI-shaped IRChunk the snapshot state machine consumes.
export {
  type GeminiGenerateContentRequest,
  GeminiGenerateContentRequestSchema,
  type GeminiGenerateContentResponse,
  GeminiGenerateContentResponseSchema,
  type GeminiSSEEvent,
  GeminiSSEEventSchema,
  type IRChunk,
} from "./protocol/gemini/gemini-types.js";
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
// OpenAI-native error envelope transformer (docs/05, 07). HelmError -> the OpenAI
// SDK's { error: { message, type, code, trace_id } } shape; status from
// err.http_status. Canonical OpenAI error mapping for the whole codebase (the
// gateway onError handler imports it). Sibling of openai.ts (single-file module).
export {
  makeOpenAIError,
  OPENAI_ERROR_SHAPE,
  type OpenAIErrorEnvelope,
  transformErrorOut as openaiTransformErrorOut,
} from "./protocol/openai-error.js";
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
// OpenAI Responses streaming state machine (docs/05): the SECOND IR→SSE machine,
// emitting the `response.*` event sequence + a JSON→SSE synthesizer for cache
// hits / non-streaming upstreams. Framework-agnostic (principle 1).
export {
  convertOpenAIStreamToResponses,
  type ResponsesSSEEvent,
  ResponsesSSEEventSchema,
  synthesizeResponsesSSEFromJSON,
} from "./protocol/responses-stream.js";
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
// Native Anthropic Messages executor (issue #38): Claude Pro/Max subscription
// routing — OpenAI-Chat IR <-> Anthropic Messages translation + Claude-Code
// identity headers + system spoof + 401 refresh-retry.
export {
  type AnthropicClientConfig,
  type AnthropicClientDeps,
  anthropicToOpenAIResponse,
  createAnthropicClient,
  openaiToAnthropicRequest,
  translateAnthropicSSE,
} from "./provider/anthropic.js";
// Interactive OAuth subscription-provider kit (issue #38): authorization-code +
// PKCE / device-code login flows, built-in provider registry (anthropic,
// github-copilot), and the flow primitives. Ported from openclaw (MIT).
export {
  type AnthropicLoginStart,
  anthropicOAuthProvider,
  anthropicUsageToWindows,
  beginAnthropicLogin,
  beginCopilotDeviceLogin,
  beginOpenAICodexLogin,
  buildOAuthRequestSignal,
  COPILOT_HEADERS,
  type CodexLoginStart,
  type CopilotDeviceStart,
  type CopilotPollResult,
  CURATED_OAUTH_MODELS,
  completeAnthropicLogin,
  completeOpenAICodexLogin,
  createOAuthPoolClient,
  discoverOAuthModels,
  getGitHubCopilotBaseUrl,
  getOAuthProvider,
  getOAuthProviders,
  githubCopilotOAuthProvider,
  hasLiveModelDiscovery,
  listOAuthProviderIds,
  type OAuthAuthInfo,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthPoolDeps,
  type OAuthPoolMember,
  type OAuthPrompt,
  type OAuthProviderId,
  type OAuthProviderInterface,
  openaiCodexOAuthProvider,
  parseAnthropicUsageBody,
  parseCodexQuotaHeaders,
  parseCodexUsageBody,
  parseOAuthAuthorizationInput,
  pollCopilotDeviceOnce,
  refreshGitHubCopilotToken,
  refreshOpenAICodexToken,
} from "./provider/oauth/index.js";
export {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  createOpenAIClient,
  type OpenAIClientDeps,
  type ProviderClient,
  type ProviderConfig,
  UpstreamError,
} from "./provider/openai.js";
export {
  aggregateResponsesStream,
  type CodexResponsesClientConfig,
  type CodexResponsesClientDeps,
  codexAccountIdFromToken,
  createCodexResponsesClient,
  openaiToResponsesRequest,
  translateResponsesSSE,
} from "./provider/openai-responses.js";
// Per-account egress proxy (issue #38 follow-up): a drop-in `fetch` that tunnels
// upstream traffic through an http/https/socks5 proxy, so distinct subscription
// accounts can leave from distinct IPs. Injected into the executors' `fetch` seam.
export { makeProxyFetch, type ProxyConfig, validateProxyConfig } from "./provider/proxy.js";
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
  type ConfidentialOAuth,
  createTokenManager,
  type PresetOAuth,
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
// At-rest encryption for OAuth subscription secrets (issue #38). AES-256-GCM under
// HELM_OAUTH_ENC_KEY; the only reversibly-stored secret class in Helm.
export {
  decryptSecret,
  encryptSecret,
  loadEncKeyFromEnv,
} from "./store/crypto/token-cipher.js";
export {
  type CreateStoreOptions,
  createPgDb,
  createPgliteDb,
  createSqliteDb,
  createStore,
  InMemoryRateLimitStore,
  InMemorySignalStore,
  PgBudgetStore,
  PgConfigStore,
  type PgDb,
  PgKeyStore,
  PgMemoryStore,
  PgOAuthQuotaStore,
  PgOAuthTokenStore,
  PgOAuthUsageStore,
  PgRateLimitStore,
  PgSignalStore,
  PgTelemetryStore,
  runMigrations,
  runPgMigrations,
  SqliteBudgetStore,
  SqliteConfigStore,
  type SqliteDb,
  SqliteKeyStore,
  SqliteMemoryStore,
  SqliteOAuthQuotaStore,
  SqliteOAuthTokenStore,
  SqliteOAuthUsageStore,
  SqliteRateLimitStore,
  SqliteSignalStore,
  SqliteTelemetryStore,
  type StoreSet,
} from "./store/index.js";
export type {
  BudgetDim,
  BudgetPeekResult,
  BudgetStore,
  ConfigStore,
  CreateKeyInput,
  InsertPayloadInput,
  InsertTelemetryInput,
  KeyStore,
  MemoryJobStatus,
  MemoryStore,
  OAuthQuotaStore,
  OAuthTokenRecord,
  OAuthTokenStore,
  OAuthUsageStore,
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
