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
  type ResolvedCompactionPricing,
  resolveCompactionPricing,
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
export { lastUserMessageText } from "./classifier/message-text.js";
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
  LocalVolumeSink,
  type LocalVolumeSinkOptions,
} from "./cleanup/archive/local-volume-sink.js";
// Automatic data cleanup / retention / archival (admin "Data cleanup"). The
// scheduled sweep + manual "Clean Now" both run runCleanupPass; archive-before-delete
// writes verified gzip-JSONL via the ArchiveSink. Framework-agnostic.
export {
  ArchiveDiskFullError,
  type ArchivedTableResult,
  type ArchiveManifest,
  type ArchiveSink,
} from "./cleanup/archive/types.js";
export {
  AUTO_VACUUM_CHECK_INTERVAL_MS,
  createAutoVacuumRunner,
  shouldAutoVacuum,
} from "./cleanup/auto-vacuum.js";
export { buildCleanupPlan, type CleanupAction, type CleanupTable } from "./cleanup/cleanup-plan.js";
export {
  type CleanupReport,
  type CleanupRunnerDeps,
  type CleanupTableReport,
  runCleanup,
} from "./cleanup/cleanup-runner.js";
export {
  CLEANUP_LAST_RUN_KEY,
  type CleanupTrigger,
  type RunCleanupPassDeps,
  readLastCleanupReport,
  runCleanupPass,
  type StoredCleanupReport,
} from "./cleanup/run-pass.js";
export {
  type CleanupSchedulerDeps,
  type CleanupSchedulerHandle,
  startCleanupScheduler,
} from "./cleanup/scheduler.js";
export {
  type Config,
  ConfigError,
  formatIssues,
  type LoadConfigOptions,
  loadConfig,
} from "./config/loader.js";
// The execution-fallback loop lives in apps/gateway/src/routes/execute.ts (the
// production path, covered by execute.test.ts). The former executor/fallback.ts
// re-implementation was unused and had diverged — removed (review finding C1).
// Only the shared attempt-record type survives here.
export type { AttemptRecord } from "./executor/attempt-record.js";
// Pure lane-graph flattener (primary→fallback, recursive, dedup, cycle-guarded) →
// ordered leaf aliases. Shared by routing + the public model listing; also used by
// the gateway's image-lane chain resolver so an image lane fails over like a text lane.
export { expandLaneChain } from "./lanes/expand-chain.js";
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
// Memory middleware — auto-adaptive Observer compaction. Pure + internal (NOT
// config): prices/context resolve from the catalog, workload stats derive from
// store data; the background worker assembles the inputs per job.
export {
  AUTO_PRIORS,
  type AutoCompactionInputs,
  type CompactionDecision,
  type CompactionTunables,
  chooseAutoCompaction,
  type EffectiveCompactionPrices,
  effectiveCompactionPrices,
  resolveCompactionTunables,
} from "./memory/compaction-policy.js";
// Memory forgetting — the decay buffer-flush TRIGGER (docs/12 P5). Run on the worker
// tick (never per request): enqueues account-scoped decay jobs for due accounts, gated.
export { type DecayTriggerDeps, maybeEnqueueDecayJobs } from "./memory/decay-trigger.js";
// Memory forgetting — the OFF-hot-path decay SWEEP (docs/12 P5). Soft-archives sub-
// threshold observations for one account; gated behind forgetting.enabled. Sibling of
// runObserverJob/runReflectorJob — deps-injected, fail-open. Framework-agnostic.
export {
  type DecayDeps,
  type DecayJob,
  runDecayJob,
  type ScorableObservation,
} from "./memory/forgetting/decay.js";
// Memory forgetting — deterministic fact dedup/supersede helpers (docs/12 P6). Pure
// leaf: subject_key normalization + sha256 content_hash for idempotent ingest.
export {
  buildReconciledFactBatch,
  type FactBatchCandidate,
  factContentHash,
  normalizeFactText,
  normalizeSubjectKey,
} from "./memory/forgetting/facts.js";
// Memory forgetting — the retention HARD-DELETE (docs/12 P7, the ONLY DELETE). Run on the
// worker tick (account-agnostic, off the request path); drops aged archived observations +
// aged expired facts. Gated behind forgetting.enabled, fail-open. Framework-agnostic.
export { pruneRetainedMemory, type RetentionDeps } from "./memory/forgetting/retention.js";
// Memory forgetting — the pure, deterministic forgetting score (docs/12). Leaf module:
// no store/config/framework deps. Imported by the inject trim (P4) + decay sweep (P5).
export {
  effectiveReferencedAt,
  forgettingScore,
  recency,
  type ScoreConfig,
  type ScoreInput,
} from "./memory/forgetting/score.js";
// Memory compaction — the idle-flush TRIGGER (memory-formation backstop). Run on
// the worker tick: enqueues idle-flush observer jobs for quiet threads with
// uncovered history. NOT gated behind forgetting (memory formation is baseline).
export { type IdleFlushDeps, maybeEnqueueIdleObserverJobs } from "./memory/idle-flush.js";
// Memory middleware — inject phase (docs/08 Phase 2). Synchronous on the request
// path: load + assemble a budgeted, cache-friendly context prefix in the fixed
// docs/08 order, enqueue write-back, fail-open. Framework-agnostic; never touches
// routing/lane state.
export {
  assembleInjectedContext,
  enqueueObserverWriteback,
  type InjectDeps,
  type InjectInput,
  type InjectResult,
} from "./memory/inject.js";
// Memory middleware — inject↔IR bridge (docs/08 Phase 2, #217 Phase 4 PREFIX
// model). Computes the live-window content_hashes for window-aware dedup, runs the
// assembler, and APPENDS the memory TEXT BLOCK as a trailing <system-reminder> turn —
// the live conversation (tool_calls / images / tool results) AND the client's cached
// system prefix are KEPT VERBATIM. No D7 gate. `wrapMemoryReminder` is the shared
// <system-reminder> envelope the native passthrough splice reuses.
export {
  type InjectBridgeDeps,
  type InjectBridgeResult,
  injectIntoIR,
  wrapMemoryReminder,
} from "./memory/inject-bridge.js";
// Memory middleware — observe phase (docs/08 Phase 1). Framework-agnostic
// write-only persistence; never injects memory or changes routing.
export {
  type IRToolResult,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  ownerScopedThreadId,
  projectScopedThreadId,
  resolveMemoryMode,
  serializeContent,
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
// docs/14 — hybrid fact retrieval: the embedding port (gateway injects the impl) +
// the RRF fusion used inside the adapters and re-exported for tests + the background
// embedding job that fills the vector index.
export type { Embedder } from "./memory/recall/embedder.js";
export {
  type EmbeddingJob,
  type EmbeddingJobDeps,
  runEmbeddingJob,
} from "./memory/recall/embedding-job.js";
export { type FusedRank, RRF_K, reciprocalRankFusion } from "./memory/recall/rrf.js";
// Memory middleware — background Reflector (docs/08 Phase 2). Periodically merges a
// scope's observations into a stable, versioned reflection; off the main request
// path, fail-open. Framework-agnostic; never touches routing/lane state.
export {
  type ExtractedFact,
  type ReflectorDeps,
  type ReflectorForgettingConfig,
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
export { clientThreadIdFromStorageId } from "./memory/thread-scope.js";
export {
  type MemoryMeta,
  MemoryMetaSchema,
  type MemoryScope,
  MemoryScopeSchema,
} from "./memory/types.js";
export { type BlockedModelMatcher, createBlockedModelMatcher } from "./model-blocking.js";
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
  extractBillingHeaderIdentity,
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
export { normalizeClaudeCodeDateFingerprintInAnthropicRequest } from "./protocol/anthropic/request.js";
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
  REASONING_EFFORT_BUDGET as GEMINI_REASONING_EFFORT_BUDGET,
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
  IR_REASONING_EFFORTS,
  type IRChoice,
  IRChoiceSchema,
  type IRContentPart,
  IRContentPartSchema,
  IRImagePartSchema,
  type IRMessage,
  IRMessageSchema,
  type IRReasoningEffort,
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
// Lane-forced reasoning-effort → wire mapping (native-passthrough body rewrite +
// the Anthropic thinking bridge). Used by the gateway executor + anthropic provider.
export {
  ANTHROPIC_THINKING_BUDGET,
  type AnthropicThinking,
  applyForcedAnthropicThinking,
  applyForcedReasoningToNativeBody,
  reasoningEffortToAnthropicThinking,
} from "./protocol/reasoning-effort.js";
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
export {
  mapResponsesStatus,
  responsesInputItemsAreCrossProtocolLossy,
  responsesTransformer,
} from "./protocol/responses.js";
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
  createSSEIncompleteFrameGuard,
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
export {
  type ChunkClass,
  guardPreOutputFailure,
  type PreOutputClassifier,
  preOutputClassifierFor,
  streamErrorFromData,
} from "./provider/failover-guard.js";
export {
  createGeminiClient,
  type GeminiClientConfig,
  type GeminiClientDeps,
} from "./provider/gemini.js";
// Interactive OAuth subscription-provider kit (issue #38): authorization-code +
// PKCE / device-code login flows, built-in provider registry (anthropic,
// github-copilot), and the flow primitives. Ported from openclaw (MIT).
export {
  ACTIVE_LIMIT_RECOVERY_THRESHOLD,
  ANTHROPIC_WINDOW_MINUTES,
  type AnthropicLoginStart,
  aggregateByCalendar,
  anthropicOAuthProvider,
  anthropicUsageToWindows,
  beginAnthropicLogin,
  beginCopilotDeviceLogin,
  beginOpenAICodexLogin,
  beginXaiDeviceLogin,
  buildOAuthRequestSignal,
  buildOpenAICodexUserAgent,
  type CalendarGranularity,
  COPILOT_HEADERS,
  type CodexCreditsSnapshot,
  type CodexLoginStart,
  type CodexModelInfo,
  CodexModelInfoSchema,
  type CodexModelsResponse,
  CodexModelsResponseSchema,
  type CodexQuotaDetails,
  type CodexRateLimitReachedType,
  type CodexReasoningEffortPreset,
  CodexReasoningEffortPresetSchema,
  type ComputeUsagePeriodsInput,
  type CopilotDeviceStart,
  type CopilotPollResult,
  CURATED_OAUTH_MODELS,
  codexActiveLimitIdFromProviderRaw,
  completeAnthropicLogin,
  completeOpenAICodexLogin,
  computeUsagePeriods,
  createOAuthPoolClient,
  createSerializingClient,
  DEFAULT_429_COOLDOWN_MS,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  detectQuotaResetPeriods,
  discoverOAuthModels,
  expandOpenAICodexModelAliases,
  filterRetiredOpenAICodexLimits,
  GROK_OAUTH_MEDIA_MODELS,
  getGitHubCopilotBaseUrl,
  getOAuthProvider,
  getOAuthProviders,
  githubCopilotOAuthProvider,
  hasLiveModelDiscovery,
  isAccountWideQuotaWindow,
  isOpenAICodexWorkspacePlan,
  isRetiredOpenAICodexLimit,
  isRetiredOpenAICodexModel,
  isRoutableXaiOAuthModel,
  LIMIT_THRESHOLD,
  listOAuthProviderIds,
  listOpenAICodexModels,
  listXaiOAuthModels,
  type OAuthAuthInfo,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthPoolClient,
  type OAuthPoolDeps,
  type OAuthPoolMember,
  type OAuthPrompt,
  type OAuthProviderId,
  type OAuthProviderInterface,
  type OAuthRateLimitParkContext,
  type OAuthSelectionStrategy,
  type OpenAICodexIdentity,
  OpenAICodexIdentityMismatchError,
  OpenAICodexModelsError,
  type OpenAICodexModelsOptions,
  type OpenAICodexModelsResult,
  openAICodexIdentityFingerprint,
  openaiCodexOAuthProvider,
  parseAnthropicUsageBody,
  parseCodexQuotaDetails,
  parseCodexQuotaHeaderDetails,
  parseCodexQuotaHeaders,
  parseCodexResetCredits,
  parseCodexResetResult,
  parseCodexUsageBody,
  parseOAuthAuthorizationInput,
  parseOpenAICodexIdentity,
  parseXaiGrokCreditsResponse,
  parseXaiOAuthModels,
  pollCopilotDeviceOnce,
  pollXaiDeviceOnce,
  QueueTimeoutError,
  type ReasoningEffort,
  ReasoningEffortSchema,
  refreshGitHubCopilotToken,
  refreshOpenAICodexToken,
  refreshXaiOAuthToken,
  resolveOpenAICodexClientVersion,
  resolveOpenAICodexModelAlias,
  resolveXaiGrokClientVersion,
  type SerializeClientDeps,
  selectCodexActiveLimitWindows,
  type UsagePeriodsResult,
  windowMinutesForKey,
  windowsToActiveUsageRecovery,
  windowsToUsageLimit,
  XAI_GROK_CLIENT_VERSION,
  XAI_GROK_CLIENT_VERSION_ENV,
  XAI_GROK_OAUTH_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
  type XaiApiBackend,
  type XaiDevicePollResult,
  type XaiDeviceStart,
  type XaiOAuthModel,
  type XaiReasoningEffort,
  type XaiReasoningEffortOption,
  xaiGrokCatalogHeaders,
  xaiGrokInferenceHeaders,
  xaiGrokProtocolHeaders,
  xaiOAuthProvider,
} from "./provider/oauth/index.js";
export {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  createOpenAIClient,
  type ImageEditInput,
  type ImageEditMultipartField,
  type OpenAIClientDeps,
  type ProviderClient,
  type ProviderConfig,
  type RealtimeCallRequest,
  type RealtimeCallResult,
  type RealtimeSidebandTarget,
  UpstreamError,
} from "./provider/openai.js";
export {
  aggregateResponsesStream,
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  type CodexResponsesClientConfig,
  type CodexResponsesClientDeps,
  type CodexResponsesNativeBodyFix,
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnectInput,
  type CodexResponsesWebSocketConnection,
  type CodexResponsesWebSocketConnector,
  type CodexResponsesWebSocketReceivedMessage,
  codexAccountIdFromToken,
  createCodexResponsesClient,
  createGenericOpenAIResponsesClient,
  type GenericOpenAIResponsesClientDeps,
  hoistResponsesInstructions,
  openaiToResponsesRequest,
  type ResponsesInstructionsFix,
  sanitizeCodexResponsesNativeBody,
  translateResponsesSSE,
} from "./provider/openai-responses.js";
export {
  anthropicNativeBodyRequiresSystemFold,
  canUseNativePassthrough,
  type NativePassthroughDecision,
  type NativePassthroughDecisionInput,
  type NativePassthroughDisableReason,
} from "./provider/protocol.js";
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
export {
  __setWreqModuleForTesting,
  checkTlsTransportAvailable,
  makeTlsImpersonationFetch,
  proxyConfigToUrl,
  type TlsImpersonationFetchOptions,
  type TlsTransportProbeResult,
  TlsTransportUnavailableError,
  type TransportProfile,
} from "./provider/tls-transport.js";
// OAuth subscription providers (issue #38): non-interactive token manager
// (refresh_token / client_credentials), single-flight refresh, injected clock.
// Framework-agnostic; env→secret resolution stays in the composition root.
export {
  type ConfidentialOAuth,
  createTokenManager,
  executionTokenExpirySkewMs,
  oauthRefreshQueueDepth,
  type PresetOAuth,
  type ResolvedOAuth,
  type TokenManager,
  type TokenManagerDeps,
  TokenRefreshError,
} from "./provider/token-manager.js";
export {
  createDistributedKeyedSemaphore,
  type DistributedAcquireArgs,
  type DistributedAcquireResult,
  type DistributedKeyedSemaphore,
  type DistributedKeyedSemaphoreOptions,
} from "./queue/distributed-keyed-semaphore.js";
// In-memory request queueing primitives (issue #93): per-key counting semaphore
// with FIFO overflow queue (feature A), per-key serial gate with inter-request
// delay (feature B), and the user-turn detector. Single-process by design.
export {
  type AcquireArgs,
  type AcquireResult,
  createKeyedSemaphore,
  type KeyedSemaphore,
  type KeyedSemaphoreDeps,
} from "./queue/keyed-semaphore.js";
export {
  createKeyedSerialGate,
  type KeyedSerialGate,
  type KeyedSerialGateDeps,
  type SerialAcquireArgs,
  type SerialAcquireResult,
} from "./queue/keyed-serial-gate.js";
export { isUserMessageRequest } from "./queue/user-turn.js";
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
  optimizeVisualContext,
  type VisualContextCompressionInput,
  type VisualContextCompressionMutation,
  type VisualContextCompressionResult,
  type VisualContextCompressor,
} from "./request-optimizer/visual-context-compression.js";
export {
  type Classification as LaneResolverClassification,
  type LaneDecision,
  type PolicyOutcome as LaneResolverPolicyOutcome,
  type ResolveLaneInput,
  resolveLane,
} from "./routing/lane-resolver.js";
// Virtual model-alias map (docs/04 compatibility shim) — resolver + boot-time
// fail-closed target validator, consumed by route-request (rewrite) and the
// gateway composition root (boot validation).
export {
  type ModelAliasMap,
  resolveModelAlias,
  validateModelAliasTargets,
} from "./routing/model-alias.js";
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
  type RoutingSignalFeedbackDeps,
  routeRequest,
} from "./routing/route-request.js";
export {
  createRuntimeMemoryCoordinator,
  deriveRuntimeMemoryBudget,
  deriveSafeWorkingMemoryCapacity,
  type RuntimeMemoryBudget,
  type RuntimeMemoryCoordinator,
  type RuntimeMemoryLease,
  runtimeMemoryBudget,
  runtimeMemoryCoordinator,
  runtimeSafeWorkingMemoryCapacity,
} from "./runtime/memory-budget.js";
export {
  acquireResponseWork,
  createResponseWorkAdmission,
  type ResponseWorkAdmission,
  ResponseWorkCapacityError,
  type ResponseWorkLease,
  runtimeResponseWorkAdmission,
} from "./runtime/response-work-admission.js";
// Runtime-mutable settings (admin "System Settings") — load/seed/persist the
// operator-facing config subset that can change at runtime without a restart.
export {
  defaultSettingsFromConfig,
  loadRuntimeSettings,
  RUNTIME_SETTINGS_KEY,
  type SettingsLog,
  saveRuntimeSettings,
} from "./settings/runtime-settings.js";
// Agentic Signals — low-cost production feedback layer (docs/02, research-notes
// "Plano"). Pure aggregator + background collector distill REDACTED routing
// signals from already-persisted decision records off the request path. The
// optional routeRequest consumer reads them fail-open for ranked-lane promotion.
// Framework-agnostic; fail-open.
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
// At-rest encryption for recoverable operator-managed secrets. AES-256-GCM under
// HELM_OAUTH_ENC_KEY; used for OAuth subscription tokens and recoverable API keys.
export {
  decryptSecret,
  encryptSecret,
  loadEncKeyFromEnv,
} from "./store/crypto/token-cipher.js";
export {
  type CachedKeyStoreOptions,
  type CreateStoreOptions,
  createCachedKeyStore,
  createPgDb,
  createPgliteDb,
  createSqliteDb,
  createStore,
  InMemoryRateLimitStore,
  InMemorySignalStore,
  PERSISTED_SESSION_MAX_REVISIONS,
  PgBudgetStore,
  PgConcurrencyLeaseStore,
  PgConfigStore,
  type PgDb,
  PgKeyStore,
  PgMemoryStore,
  PgOAuthQuotaStore,
  PgOAuthResetPeriodStore,
  PgOAuthTokenStore,
  PgOAuthUsageStore,
  PgRateLimitStore,
  PgResponsesRegistryStore,
  PgSignalStore,
  PgTelemetryStore,
  restoreSessionRevisionJson,
  runMigrations,
  runPgMigrations,
  SESSION_MAX_REVISIONS,
  SqliteBudgetStore,
  SqliteConfigStore,
  type SqliteDb,
  SqliteKeyStore,
  SqliteMemoryStore,
  SqliteOAuthQuotaStore,
  SqliteOAuthResetPeriodStore,
  SqliteOAuthTokenStore,
  SqliteOAuthUsageStore,
  SqliteRateLimitStore,
  SqliteResponsesRegistryStore,
  SqliteSignalStore,
  SqliteTelemetryStore,
  type StoreSet,
  splitSessionRequestJson,
} from "./store/index.js";
export type {
  BudgetDim,
  BudgetPeekResult,
  BudgetStore,
  ConcurrencyLeaseStore,
  ConfigStore,
  CreateKeyInput,
  InsertPayloadInput,
  InsertTelemetryInput,
  KeyStore,
  MemoryAdminStats,
  MemoryAdminStatsScope,
  MemoryJobStatus,
  MemoryStore,
  OAuthQuotaStore,
  OAuthResetPeriodStore,
  OAuthTokenRecord,
  OAuthTokenStore,
  OAuthUsageStore,
  RateLimitConsumeResult,
  RateLimitStore,
  RequestPayload,
  RequestPayloadMeta,
  RequestPayloadPart,
  RequestPayloadPartRecord,
  ResponsesRegistryRecord,
  ResponsesRegistryStore,
  SessionRecord,
  SessionRevisionPage,
  SessionRevisionPageOptions,
  SessionRevisionRecord,
  SignalStore,
  TelemetryStore,
  UpsertSessionRevisionInput,
} from "./store/ports.js";
// docs/13 — thrown by MemoryStore.updateFact on a content_hash collision (value
// export: it's a class the admin/MCP routes catch to return 409, not just a type).
export { MemoryFactContentHashConflictError } from "./store/ports.js";
export {
  buildDecisionRecord,
  type ClassifierOutput,
  correlationTraceId,
  type DecisionParts,
  type FinalOutcome,
  type LaneSelection,
  type PersistDecisionOptions,
  type PolicyOutcome as TelemetryPolicyOutcome,
  persistDecision,
} from "./telemetry/decision.js";
export { type RedactOptions, redact, redactKey } from "./telemetry/redaction.js";
