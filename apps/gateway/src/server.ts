import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  type AnthropicSSEEvent,
  AUTO_VACUUM_CHECK_INTERVAL_MS,
  anthropicTransformer,
  type BudgetCaps,
  bootstrapRootKey,
  buildOpenAICodexUserAgent,
  COPILOT_HEADERS,
  type CodexRateLimitReachedType,
  type ConfigStore,
  type CreateKeyInput,
  CURATED_OAUTH_MODELS,
  checkTlsTransportAvailable,
  codexActiveLimitIdFromProviderRaw,
  createAnthropicClient,
  createAutoVacuumRunner,
  createBudgetGate,
  createCachedKeyStore,
  createCircuitBreaker,
  createCodexResponsesClient,
  createDistributedKeyedSemaphore,
  createGeminiClient,
  createGenericOpenAIResponsesClient,
  createKeyedSemaphore,
  createKeyedSerialGate,
  createMemoryMomentumStore,
  createOAuthPoolClient,
  createOpenAIClient,
  createProviderRegistry,
  createRateLimiter,
  createSerializingClient,
  createSignalCollector,
  createStore,
  createTokenManager,
  DEFAULT_429_COOLDOWN_MS,
  DEFAULT_LANES,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  type DecayDeps,
  decryptSecret,
  discoverOAuthModels,
  type EmbeddingJob,
  encryptSecret,
  executionTokenExpirySkewMs,
  expandLaneChain,
  expandOpenAICodexModelAliases,
  filterRetiredOpenAICodexLimits,
  type GeminiGenerateContentResponse,
  type GeneratedKey,
  GROK_OAUTH_MEDIA_MODELS,
  geminiTransformer,
  generateKey,
  getGitHubCopilotBaseUrl,
  getOAuthProvider,
  hashKey,
  hoistResponsesInstructions,
  type InjectDeps,
  type IRResponse,
  isRoutableXaiOAuthModel,
  isUserMessageRequest,
  type KeyedSerialGate,
  type Lane,
  type LanesConfig,
  LocalVolumeSink,
  listOpenAICodexModels,
  listXaiOAuthModels,
  loadConfig,
  loadEncKeyFromEnv,
  loadRuntimeCatalog,
  loadRuntimeSettings,
  makeAnthropicError,
  makeGeminiError,
  makeProxyFetch,
  makeTlsImpersonationFetch,
  maybeEnqueueDecayJobs,
  maybeEnqueueIdleObserverJobs,
  type OAuthPoolClient,
  type OAuthPoolMember,
  type OAuthSelectionStrategy,
  type OAuthTokenStore,
  type ObserveDeps,
  type ObserverDeps,
  type OpenAICodexIdentity,
  OpenAICodexModelsError,
  type OpenAICodexModelsResult,
  oauthRefreshQueueDepth,
  openAICodexIdentityFingerprint,
  type PoliciesConfig,
  type ProviderClient,
  type ProxyConfig,
  parseCodexQuotaHeaderDetails,
  parseLanesConfig,
  parseOpenAICodexIdentity,
  preOutputClassifierFor,
  pruneRetainedMemory,
  type ReflectorDeps,
  type ProviderRegistryConfig as RegistryProviderConfig,
  type ResponsesSSEEvent,
  type RouteOptions,
  readLastCleanupReport,
  redact,
  resolveCompactionPricing,
  resolveCostUsd,
  resolveOpenAICodexClientVersion,
  resolveXaiGrokClientVersion,
  responsesTransformer,
  routeRequest,
  runCleanupPass,
  runDecayJob,
  runEmbeddingJob,
  runObserverJob,
  runReflectorJob,
  runtimeMemoryBudget,
  runtimeMemoryCoordinator,
  runtimeResponseWorkAdmission,
  type StoreSet,
  saveRuntimeSettings,
  settleBudget,
  startCleanupScheduler,
  startMemoryWorker,
  startSignalScheduler,
  type TransportProfile,
  toRegistryProviders,
  validateModelAliasTargets,
  windowsToUsageLimit,
  XAI_GROK_OAUTH_BASE_URL,
  type XaiOAuthModel,
  xaiGrokInferenceHeaders,
} from "@helm/core";
import type {
  CatalogEntry,
  ClassifierConfig,
  DecisionRecord,
  ErrorClass,
  InternalRequest,
  NativePassthroughInput,
  OAuthQuotaWindow,
  ProviderConfig as ProviderConfigShared,
  RuntimeSettings,
  TargetProviderProtocol,
} from "@helm/shared";
import {
  appendMutationList,
  cloneCarrierWithBody,
  ErrorClassSchema,
  isNativePassthroughCarrier,
  isOAuthPreset,
  makeHelmError,
  nativePassthroughBody,
} from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createCodexResponsesWebSocketConnector } from "./codex-responses-websocket.js";
import { INTERNAL_API_KEY_ID } from "./internal-key.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { createMemoryEmbedder } from "./memory-embedder.js";
import { createMemoryLlmRuntime, type MemoryModelResolution } from "./memory-llm.js";
import { createSelfHttpClient } from "./memory-self-http.js";
import { authMiddleware } from "./middleware/auth.js";
import { basicAuth, resolveAdminAuth, warnIfAdminUnconfigured } from "./middleware/basic-auth.js";
import { concurrencyMiddleware, createConcurrencyGate } from "./middleware/concurrency.js";
import { HelmHttpError } from "./middleware/error-handler.js";
import { estimateRequestTokens } from "./middleware/estimate-tokens.js";
import { type RateLimiterPort, rateLimitMiddleware } from "./middleware/rate-limit.js";
import {
  type AccountSettingsMap,
  getAccountSettings,
  loadAccountSettings,
  loadGlobalOAuthSettings,
  markAccountCredentialFailure,
  resolveAccountModelsMode,
  saveAccountDiscoveredModels,
  saveAccountXaiDiscoveredModels,
} from "./oauth/account-settings.js";
import { createOAuthAdmin } from "./oauth/admin-oauth.js";
import { runResetCreditAttempt, weeklySaturated } from "./oauth/auto-reset.js";
import { loadBundledCodexModels } from "./oauth/codex-bundled-models.js";
import { normalizeOpenAICodexClientVersion } from "./oauth/codex-client-version.js";
import { resolveCodexCompactModel } from "./oauth/codex-compact.js";
import { type CodexModelCacheKey, createCodexModelCache } from "./oauth/codex-model-cache.js";
import {
  type CodexModelCatalog,
  type CodexModelCatalogSnapshot,
  createCodexModelCatalog,
} from "./oauth/codex-model-catalog.js";
import { createCodexModelsEtagTracker } from "./oauth/codex-model-etag-tracker.js";
import { codexResetCreditSharedKey } from "./oauth/codex-reset-account-key.js";
import { anthropicMetadataUserId, stableSessionId } from "./oauth/device-identity.js";
import { effectiveOAuthModelOptions, type ModelOption } from "./oauth/effective-models.js";
import {
  createOAuthModelDiscoveryCache,
  type OAuthModelDiscoveryCache,
} from "./oauth/model-discovery-cache.js";
import {
  recordObservedQuotaResetPeriods,
  recordQuotaResetCreditPeriods,
} from "./oauth/quota-reset-period.js";
import { createResetCreditGuard, resetCreditGuardHash } from "./oauth/reset-credit-guard.js";
import { createRealtimeCallRegistry, type RealtimeCallRegistry } from "./realtime-call-registry.js";
import { createResponsesRegistry } from "./responses-registry.js";
import { responsesWebSocketPreflightPending } from "./responses-websocket.js";
import { createArchiveFsAccess } from "./routes/admin/cleanup-fs.js";
import { registerAdminApi } from "./routes/admin/index.js";
import { createOAuthAccountTester, type OAuthTester } from "./routes/admin/oauth-test.js";
import { createRuntimeRuleStore } from "./routes/admin/rule-store.js";
import { createYamlRulePersister } from "./routes/admin/yaml-writeback.js";
import { mountAdminLogin } from "./routes/admin-login.js";
import { ADMIN_BUILD_ROOT, mountAdminStatic } from "./routes/admin-static.js";
import { registerChatRoutes } from "./routes/chat.js";
import { buildClassifyAdapter } from "./routes/classify.js";
import { createExecute } from "./routes/execute.js";
import { registerGeminiRoute } from "./routes/gemini.js";
import type { ImageChainTarget, ResolveImageChain } from "./routes/image-chain.js";
import { registerImagesRoute } from "./routes/images.js";
import { registerInteractionsRoute } from "./routes/interactions.js";
import { registerMcpServer } from "./routes/mcp/index.js";
import { deriveMcpSigningKey, mcpAuth, registerMcpOAuth } from "./routes/mcp/oauth.js";
import { supportsMemoryAdmin } from "./routes/mcp/tools.js";
import type { MessagesIdentity, RouteError } from "./routes/messages.js";
import { capsFromRecord, registerMessagesRoute } from "./routes/messages.js";
import { createMessagesPipeline } from "./routes/messages-pipeline.js";
import { registerModelsRoute } from "./routes/models.js";
import { clearSessionCaptureCache } from "./routes/payload-capture.js";
import { registerPortalApi } from "./routes/portal/index.js";
import { mountPortalStatic, PORTAL_BUILD_ROOT } from "./routes/portal-static.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import {
  type ResponsesCompactExecution,
  type ResponsesRouteDeps,
  registerResponsesRoute,
} from "./routes/responses.js";
import { registerUsageStatsRoute } from "./routes/usage.js";
import { registerVideosRoute, type VideoCreateTarget } from "./routes/videos.js";
import {
  createMaintenanceActivityGate,
  createSerializedMaintenanceQueue,
  createTrackedBackgroundTasks,
  maintenanceDrainTimeoutMs,
  type PausableActivity,
  withPausedActivities,
} from "./runtime/maintenance-gate.js";
import { type BodyMemoryAdmission, createBodyMemoryAdmission } from "./runtime/memory-admission.js";
import { createRuntimeResourcePressureGate } from "./runtime/resource-pressure.js";
import { startRuntimeStatsLogger } from "./runtime/runtime-stats.js";
import {
  markServingAccount,
  type ServingAccount,
  servedByAccount,
  servingAccountStore,
  withServingAccountCapture,
} from "./runtime/serving-account.js";
import { createWriteQueue } from "./runtime/write-queue.js";

export interface ServerHandle {
  app: ReturnType<typeof createApp>;
  port: number;
  host: string;
  closeResponsesWebSocketSession?: (sessionId: string) => Promise<void>;
  responsesWebSocketSessionProof?: string;
  responsesMemoryAdmission?: BodyMemoryAdmission;
  websocketIngressAdmission?: BodyMemoryAdmission;
  realtimeCallRegistry?: RealtimeCallRegistry;
  resolveRealtimeKey?: (credential: string | null) => Promise<string | null>;
  // Stop background workers (e.g. the Agentic Signals scheduler). Optional and
  // safe to skip — the timers are unref'd so they never block process exit.
  dispose?: () => void | Promise<void>;
}

// Pre-classification TPM token estimator. Extracted to middleware/estimate-tokens
// so the chat middleware AND the self-authenticating /v1/messages + /v1/responses
// routes share ONE heuristic. Re-exported here for back-compat (server.test.ts).
export { estimateRequestTokens };

// Validate a RouteError's free-form `error_class` string against the 8 known
// ErrorClass values so the Anthropic error transformer can map it precisely. An
// unrecognized class falls back to upstream_error (502) — fail-open (principle 3):
// a surprise class must not throw inside the error path.
function coerceErrorClass(value: string): ErrorClass {
  const parsed = ErrorClassSchema.safeParse(value);
  return parsed.success ? parsed.data : "upstream_error";
}

export function routeDecisionLogFields(record: Pick<DecisionRecord, "request_id" | "trace_id">): {
  request_id: string;
  trace_id: string;
} {
  return { request_id: record.request_id, trace_id: record.trace_id };
}

// Build the provider registry from the FULL multi-provider config (providers-
// multi). It is the union of two alias sources, in priority order:
//
//  1. Explicit per-model aliases from config.providers[].models[] — these map a
//     lane/policy alias (e.g. 'deepseek/deepseek-v4-flash') to a SPECIFIC provider
//     + upstream model id (the registry providerName then selects that provider's
//     client in the executor, so a fallback chain can CROSS providers).
//
//  2. Phase-0 PASSTHROUGH back-fill: any alias referenced by the active lanes
//     that is NOT already mapped by (1) is registered against the PRIMARY provider
//     with provider_model === alias (the single OpenAI-compatible upstream the
//     mock/e2e harness points at; the upstream ignores the exact model id). This
//     keeps single-provider deployments working with lanes that name bare aliases.
//
// A duplicate alias ACROSS providers in (1) fails closed at build time inside
// createProviderRegistry (principle 2); back-fill (2) never overrides (1).
// Exported for unit tests (server.test.ts) — not part of the public API.
export function buildRegistry(
  providers: ReadonlyArray<ProviderConfigShared>,
  primaryName: string,
  primaryBaseUrl: string,
  // OPTIONAL (issue #38): an OAuth primary has no api_key_env. The registry never
  // reads this to fetch a credential (the per-name client is pre-built), so the
  // back-fill entry stores "" when absent.
  primaryApiKeyEnv: string | undefined,
  lanes: LanesConfig,
  fallbackBaseUrl: string,
) {
  // (1) Explicit per-model providers (drop those with no models[] — passthrough).
  const explicit = toRegistryProviders(
    providers.filter((p) => p.models.length > 0),
    { fallbackBaseUrl },
  );
  const mapped = new Set<string>();
  for (const p of explicit) for (const m of p.models) mapped.add(m.alias);

  // (2) Back-fill the remaining lane aliases against the primary provider.
  const backfill = new Set<string>();
  for (const [, lane] of Object.entries(lanes)) {
    for (const el of [lane.primary, ...lane.fallback]) {
      // Skip lane references (resolved during chain expansion) and aliases already
      // mapped explicitly; register only the remaining terminal model aliases.
      if (!Object.hasOwn(lanes, el) && !mapped.has(el)) backfill.add(el);
    }
  }
  const cfgs: RegistryProviderConfig[] = [...explicit];
  if (backfill.size > 0) {
    // Carry the PRIMARY's protocol metadata onto the back-fill entry (issue #217).
    // Without this, a bare lane alias backed by a NON-OpenAI primary (e.g. an
    // Anthropic primary) would resolve with the default `openai_chat`/no-rewrite
    // and be mislabeled — the native passthrough guard would see a fake protocol
    // mismatch. `toRegistryProviders` already stamps EXPLICIT providers; the
    // back-fill branch must do the same for the primary it synthesizes here.
    const primary = providers.find((p) => p.name === primaryName || p.alias === primaryName);
    const providerRequiresCompatibilityRewrite =
      (primary as { providerRequiresCompatibilityRewrite?: boolean } | undefined)
        ?.providerRequiresCompatibilityRewrite ?? primary?.map_developer_role_to_system === true;
    cfgs.push({
      name: primaryName,
      base_url: primaryBaseUrl,
      api_key_env: primaryApiKeyEnv ?? "", // OAuth primary has none; registry never reads it
      targetProviderProtocol: primary?.targetProviderProtocol ?? "openai_chat",
      providerRequiresCompatibilityRewrite,
      models: [...backfill].map((alias) => ({ alias, provider_model: alias })),
    });
  }
  return createProviderRegistry(cfgs);
}

export function buildInternalLlmKeyInput(k: GeneratedKey): CreateKeyInput {
  return {
    keyId: INTERNAL_API_KEY_ID,
    hash: k.hash,
    prefix: k.prefix,
    accountId: "default",
    role: "user",
    name: "internal-llm",
    allowCustomModel: true,
    // Internal memory/eval self-calls must not recursively observe themselves.
    memoryMode: "off",
    memoryThreadSource: "header",
    // 0 is the per-key rate-limit sentinel for explicitly unlimited.
    rateLimitRpm: 0,
    rateLimitTpm: 0,
  };
}

// A resolved provider credential, ready to splice into a ProviderConfig. Either a
// static `apiKey` (key path) or the dynamic OAuth trio (getAuthHeader / on401 /
// currentSecrets). The env→plaintext resolution happens HERE (composition root,
// principle 7); core never sees an env var name.
type ProviderCredential =
  | { apiKey: string }
  | {
      getAuthHeader: () => Promise<string>;
      onUnauthorized: () => void;
      currentSecrets: () => string[];
      currentMetadata: () => Readonly<Record<string, unknown>>;
    };

// Runtime context for PRESET subscription OAuth (issue #38): the persistent
// credential store + the at-rest encryption key. Resolved once at the composition
// root (principle 7) and threaded into buildCredential so the preset token manager
// can read/decrypt the stored credential the admin login wrote.
export interface OAuthRuntimeCtx {
  store: OAuthTokenStore;
  encKey: Buffer;
}

export interface CodexOAuthRuntime {
  catalog: CodexModelCatalog;
  runInBackground: (task: () => Promise<unknown>, onError?: (error: unknown) => void) => boolean;
  clientVersion?: string;
  userAgent?: string;
  onCatalogChanged?: () => void;
}

interface CodexAccountRuntime {
  key: CodexModelCacheKey;
  catalog: CodexModelCatalog;
  fetchModels: () => Promise<OpenAICodexModelsResult>;
  accountIdentity: OpenAICodexIdentity;
  clientVersion: string;
  userAgent: string;
  runInBackground: CodexOAuthRuntime["runInBackground"];
  onCatalogChanged?: () => void;
}

interface XaiAccountRuntime {
  modelsByWireModel: ReadonlyMap<string, XaiOAuthModel>;
}

function identityString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codexIdentityFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
): OpenAICodexIdentity {
  const accountId = identityString(metadata.accountId);
  const chatgptUserId = identityString(metadata.chatgptUserId);
  const chatgptPlanType = identityString(metadata.chatgptPlanType);
  const email = identityString(metadata.email);
  return {
    ...(accountId ? { accountId } : {}),
    ...(chatgptUserId ? { chatgptUserId } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(email ? { email } : {}),
    ...(typeof metadata.isFedramp === "boolean" ? { isFedramp: metadata.isFedramp } : {}),
  };
}

function mergeCodexIdentity(
  accessToken: string,
  metadata: Readonly<Record<string, unknown>>,
): OpenAICodexIdentity {
  return {
    ...parseOpenAICodexIdentity(accessToken),
    ...codexIdentityFromMetadata(metadata),
  };
}

function codexCacheIdentity(identity: OpenAICodexIdentity): string {
  return openAICodexIdentityFingerprint(identity);
}

interface LoadedCodexAccountCatalog {
  key: CodexModelCacheKey;
  snapshot: CodexModelCatalogSnapshot;
  runtime: CodexAccountRuntime;
}

async function loadCodexAccountCatalog(input: {
  account: string;
  tokenManager: ReturnType<typeof createTokenManager>;
  proxyFetch?: typeof globalThis.fetch;
  clientVersion: string;
  catalog: CodexModelCatalog;
  onCatalogChanged?: () => void;
  runInBackground: CodexOAuthRuntime["runInBackground"];
  signal?: AbortSignal;
}): Promise<LoadedCodexAccountCatalog | null> {
  const clientVersion = normalizeOpenAICodexClientVersion(input.clientVersion);
  if (clientVersion === null) return null;
  const userAgent = buildOpenAICodexUserAgent(clientVersion);
  const accessToken = (await input.tokenManager.getAuthHeader(input.signal)).replace(
    /^Bearer /,
    "",
  );
  const accountIdentity = mergeCodexIdentity(accessToken, input.tokenManager.currentMetadata());
  const key: CodexModelCacheKey = {
    providerId: "openai-codex",
    account: input.account,
    accountIdentity: codexCacheIdentity(accountIdentity),
    clientVersion,
  };
  const fetchModelsOnce = async (signal?: AbortSignal): Promise<OpenAICodexModelsResult> => {
    const currentAccess = (await input.tokenManager.getAuthHeader(signal)).replace(/^Bearer /, "");
    const currentIdentity = mergeCodexIdentity(currentAccess, input.tokenManager.currentMetadata());
    return listOpenAICodexModels(currentAccess, {
      accountId: currentIdentity.accountId,
      isFedramp: currentIdentity.isFedramp,
      clientVersion,
      userAgent,
      fetchImpl: input.proxyFetch,
      signal,
    });
  };
  const fetchModels = async (signal?: AbortSignal): Promise<OpenAICodexModelsResult> => {
    try {
      return await fetchModelsOnce(signal);
    } catch (error) {
      if (!(error instanceof OpenAICodexModelsError) || error.httpStatus !== 401) {
        throw error;
      }
      input.tokenManager.invalidate();
      return fetchModelsOnce(signal);
    }
  };
  const snapshot = await input.catalog.load(key, fetchModels, { signal: input.signal });
  if (snapshot === null) return null;
  return {
    key,
    snapshot,
    runtime: {
      key,
      catalog: input.catalog,
      fetchModels,
      accountIdentity,
      clientVersion,
      userAgent,
      runInBackground: input.runInBackground,
      onCatalogChanged: input.onCatalogChanged,
    },
  };
}

export interface CodexClientVersionCatalog {
  keys: CodexModelCacheKey[];
  models: string[];
}

export async function loadCodexCatalogForClientVersion(input: {
  configured: ReadonlyArray<ProviderConfigShared>;
  oauthCtx: OAuthRuntimeCtx;
  config: ConfigStore;
  catalog: CodexModelCatalog;
  clientVersion: string;
  signal?: AbortSignal;
  tokenManagers?: Map<string, ReturnType<typeof createTokenManager>>;
}): Promise<CodexClientVersionCatalog> {
  const clientVersion = normalizeOpenAICodexClientVersion(input.clientVersion);
  if (clientVersion === null) return { keys: [], models: [] };
  const declared = new Set<string>(
    input.configured.flatMap((provider) =>
      provider.oauth && isOAuthPreset(provider.oauth) ? [provider.oauth.provider] : [],
    ),
  );
  if (declared.has("openai-codex")) return { keys: [], models: [] };

  input.signal?.throwIfAborted();
  const accountSettings = await waitForAbort(
    loadAccountSettings(input.config, input.oauthCtx.encKey),
    input.signal,
  );
  const keys: CodexModelCacheKey[] = [];
  const models = new Set<string>();
  const provider = getOAuthProvider("openai-codex");
  if (!provider) return { keys, models: [] };

  const bindings = await waitForAbort(input.oauthCtx.store.list(), input.signal);
  for (const binding of bindings) {
    input.signal?.throwIfAborted();
    if (binding.providerId !== "openai-codex") continue;
    const settings = getAccountSettings(accountSettings, binding.providerId, binding.account);
    if (typeof settings.credentialFailedAt === "number" || settings.schedulable === false) continue;
    const accountConfig = {
      oauth: { provider: binding.providerId, account: binding.account },
    } as unknown as ProviderConfigShared;
    const proxy = resolveProviderProxy(accountConfig, accountSettings);
    const proxyFetch = proxy ? makeProxyFetch(proxy) : undefined;
    const tokenManagerKey = JSON.stringify([binding.providerId, binding.account]);
    let tokenManager = input.tokenManagers?.get(tokenManagerKey);
    if (!tokenManager) {
      tokenManager = createTokenManager({
        oauth: {
          kind: "preset",
          providerId: binding.providerId,
          account: binding.account,
        },
        tokenStore: input.oauthCtx.store,
        encKey: input.oauthCtx.encKey,
        oauthProvider: provider,
        fetch: proxyFetch,
        now: () => Date.now(),
      });
      input.tokenManagers?.set(tokenManagerKey, tokenManager);
    }
    let loaded: LoadedCodexAccountCatalog | null;
    try {
      loaded = await loadCodexAccountCatalog({
        account: binding.account,
        tokenManager,
        proxyFetch,
        clientVersion,
        catalog: input.catalog,
        runInBackground: () => false,
        signal: input.signal,
      });
    } catch {
      continue;
    }
    if (loaded === null) continue;
    keys.push(loaded.key);
    let discovered = expandOpenAICodexModelAliases(
      [...loaded.snapshot.models]
        .sort((left, right) => left.priority - right.priority)
        .map((model) => model.slug),
    );
    if (resolveAccountModelsMode(binding.providerId, settings) === "manual") {
      const enabled = new Set(settings.enabledModels ?? []);
      discovered = discovered.filter((model) => enabled.has(model));
    }
    for (const model of discovered) models.add(model);
  }

  return { keys, models: [...models] };
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function nativeHeaderValue(
  headers: Readonly<Record<string, string | string[]>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const selected = Array.isArray(value) ? value[0] : value;
    return selected?.trim() || undefined;
  }
  return undefined;
}

export function normalizeCodexNativeClientVersion(
  input: NativePassthroughInput,
): NativePassthroughInput {
  if (!isNativePassthroughCarrier(input)) return input;
  const explicit =
    nativeHeaderValue(input.headers, "version") ??
    nativeHeaderValue(input.headers, "x-codex-client-version");
  if (explicit === undefined) return input;
  const normalized = normalizeOpenAICodexClientVersion(explicit);
  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([name]) =>
        name.toLowerCase() !== "version" && name.toLowerCase() !== "x-codex-client-version",
    ),
  );
  if (normalized !== null) headers.version = normalized;
  if (
    normalized === explicit &&
    nativeHeaderValue(input.headers, "x-codex-client-version") === undefined
  ) {
    return input;
  }
  return { ...input, headers };
}

export async function runCodexCompactProviderCall(input: {
  execute(options: {
    signal: AbortSignal;
    onResponseMeta?: (headers: Headers) => void;
    captureUpstream: (wireBody: string) => void;
  }): Promise<unknown>;
  signal: AbortSignal;
  onResponseMeta?: (headers: Headers) => void;
  onExecution?: (execution: ResponsesCompactExecution) => void;
  modelAlias: string;
  providerModel: string;
  providerName: string;
}): Promise<unknown> {
  let upstreamRequest: string | null = null;
  const holder: { selected: ServingAccount | null } = { selected: null };
  const reportExecution = (): void => {
    input.onExecution?.({
      modelAlias: input.modelAlias,
      providerModel: input.providerModel,
      providerName: input.providerName,
      upstreamRequest,
      servingAccount: holder.selected,
    });
  };
  try {
    const result = await servingAccountStore.run(holder, () =>
      input.execute({
        signal: input.signal,
        ...(input.onResponseMeta ? { onResponseMeta: input.onResponseMeta } : {}),
        captureUpstream: (wireBody) => {
          upstreamRequest = wireBody;
        },
      }),
    );
    reportExecution();
    return result;
  } catch (error) {
    try {
      reportExecution();
    } catch {
      // Preserve the provider failure if an optional observability callback misbehaves.
    }
    throw error;
  }
}

export function createHotCodexCompactExecutor(
  getClient: () => Pick<ProviderClient, "responsesCompact"> | null,
  unavailable: () => Error,
): NonNullable<ProviderClient["responsesCompact"]> {
  return async (body, options) => {
    const client = getClient();
    const method = client?.responsesCompact;
    if (method === undefined) throw unavailable();
    return await method.call(client, body, options);
  };
}

// Executor-ready subscription providers that a bound credential can AUTO-ROUTE to
// (issue #38): each maps to the executor `type` createProviderClient dispatches on.
// For Copilot the base URL is derived per-request from the token, so none is set
// here. This map is the SINGLE gate for "which subscriptions route" — the live
// model catalog (effectiveOAuthAliases) reads its keys (ROUTABLE_OAUTH_IDS).
// Each entry also pins the upstream wire protocol (targetProviderProtocol) +
// whether a compatibility rewrite mutates the body (issue #217). Native protocol
// passthrough reads these to decide a same-protocol forward is byte-safe: the
// OAuth pool aliases bypass the registry, so the executor can't infer the wire
// protocol from a ResolvedProvider — it gets the prefix→protocol map instead.
const ROUTABLE_OAUTH: Record<
  string,
  {
    type: string;
    baseUrl?: string;
    targetProviderProtocol: TargetProviderProtocol;
    providerRequiresCompatibilityRewrite: boolean;
  }
> = {
  anthropic: {
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    targetProviderProtocol: "anthropic_messages",
    providerRequiresCompatibilityRewrite: false,
  },
  "github-copilot": {
    type: "openai",
    targetProviderProtocol: "openai_chat",
    providerRequiresCompatibilityRewrite: false,
  },
  // ChatGPT Codex via the native Responses executor (the endpoint is
  // baseUrl + /responses). No list-models API → hasLiveModelDiscovery stays false
  // (curated list only; the Manage dialog hides "Pull from provider").
  "openai-codex": {
    type: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    targetProviderProtocol: "openai_responses",
    providerRequiresCompatibilityRewrite: false,
  },
  // SuperGrok/X Premium via the Grok CLI subscription proxy. This is a generic
  // OpenAI Responses transport; it must not inherit ChatGPT/Codex headers.
  xai: {
    type: "openai-responses-generic",
    baseUrl: XAI_GROK_OAUTH_BASE_URL,
    targetProviderProtocol: "openai_responses",
    providerRequiresCompatibilityRewrite: false,
  },
};
// The single gate for "which subscriptions route". Keys of ROUTABLE_OAUTH, reused
// by the live model catalog so it can never offer a model whose executor is unwired.
const ROUTABLE_OAUTH_IDS: ReadonlySet<string> = new Set(Object.keys(ROUTABLE_OAUTH));
// The prefix→protocol map the executor consults for native passthrough (issue
// #217). Derived from ROUTABLE_OAUTH so the two never drift; keyed by provider id
// (the OAuth alias prefix), the SAME key as ROUTABLE_OAUTH_IDS / the pool clients.
const ROUTABLE_OAUTH_PROTOCOLS = new Map(
  Object.entries(ROUTABLE_OAUTH).map(([providerId, spec]) => [
    providerId,
    {
      targetProviderProtocol: spec.targetProviderProtocol,
      providerRequiresCompatibilityRewrite: spec.providerRequiresCompatibilityRewrite,
    },
  ]),
);

function isAnthropicScopedWeeklyModel(model: string | null): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return (
    normalized.includes("claude-fable") ||
    normalized.includes("claude-sonnet") ||
    normalized.includes("claude-opus")
  );
}

function providerRawFromError(error: unknown): unknown {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  return (error as { providerRaw?: unknown }).providerRaw ?? null;
}

function resolveOAuthRateLimitScope(
  providerId: string,
  model: string | null,
  error: unknown,
): { scope: "account" } | { scope: "model"; model: string; limitId: string | null } {
  if (providerId === "openai-codex" && model !== null) {
    const activeLimitId = codexActiveLimitIdFromProviderRaw(providerRawFromError(error));
    if (activeLimitId !== null && activeLimitId !== "codex") {
      return { scope: "model", model, limitId: activeLimitId };
    }
  }
  if (providerId === "anthropic" && model !== null && isAnthropicScopedWeeklyModel(model)) {
    return { scope: "model", model, limitId: null };
  }
  return { scope: "account" };
}

// The synthesis result (issue #38, Stage 3): one synthetic provider config per
// routable subscription, plus the POOL client that serves ALL its accounts. The
// config carries the UNION of every schedulable account's enabled models as
// `<provider>/<model>` aliases (so Lanes sees the full exposure); the registry
// maps each alias to providerName === providerId, and `poolClients.get(providerId)`
// returns ONE pool client that round-robins across the accounts on every call.
export interface SynthesizedOAuth {
  providers: ProviderConfigShared[];
  // OAuthPoolClient (a ProviderClient + the `setUsageLimit` mutator) so the gateway
  // can park / un-park a single account in place on a usage-limit signal, without a
  // full pool rebuild.
  poolClients: Map<string, OAuthPoolClient>;
  // Account/version-scoped Codex catalog keys represented by this synthesis.
  codexKeys: CodexModelCacheKey[];
  /** Live first-party xAI catalog keyed by Helm alias; retained for conservative
   *  dynamic capability synthesis and id -> wire-model routing. */
  xaiModels: Map<string, XaiOAuthModel>;
  /** xAI aliases accepted by the live pool and the accounts backing each alias. */
  xaiModelAccounts: Map<string, string[]>;
}

export interface OAuthQuotaSeed {
  windows: OAuthQuotaWindow[];
  capturedAt: number;
  usageLimitedUntilMs: number | null;
  resetCredits?: number | null;
}

// Build a FRESH, standalone executor client for ONE oauth account: its token manager
// + egress proxy + executor type + stable anti-ban identity — exactly the per-account
// binding the routing pool uses, minus the pool/serial wrap. Shared by
// synthesizeOAuthProviders (production routing) AND the admin connectivity tester so
// the test path is FAITHFUL to production and the two never drift. Returns null when
// no credential can be built (fail-open). The raw client carries NO circuit breaker
// (that lives in the executor layer), so a one-off test client is fully isolated from
// the live pool's breaker/telemetry state.
function buildOAuthAccountClient(
  providerId: string,
  account: string,
  oauthCtx: OAuthRuntimeCtx,
  proxy: ProxyConfig | undefined,
  fastMode: boolean,
  base: { baseUrl: string; timeoutMs: number },
  onResponseMeta?: (headers: Headers) => void,
  codexRuntime?: CodexAccountRuntime,
  xaiRuntime?: XaiAccountRuntime,
): ProviderClient | null {
  const spec = ROUTABLE_OAUTH[providerId];
  if (!spec) return null;
  const accountConfig = {
    name: providerId,
    alias: providerId,
    type: spec.type,
    base_url: spec.baseUrl,
    oauth: { provider: providerId, account },
    models: [],
    targetProviderProtocol: spec.targetProviderProtocol,
    providerRequiresCompatibilityRewrite: spec.providerRequiresCompatibilityRewrite,
  } as unknown as ProviderConfigShared;
  const cred = buildCredential(accountConfig, oauthCtx, proxy, base.timeoutMs);
  if (!cred) return null;
  // Stable per-account anti-ban identity (never rotates): Anthropic gets a
  // metadata.user_id; Codex a stable session_id. Both deterministic from
  // (providerId, account) salted by the at-rest key — no DB write-back.
  const identity =
    providerId === "anthropic"
      ? { metadataUserId: anthropicMetadataUserId(providerId, account, oauthCtx.encKey) }
      : providerId === "openai-codex"
        ? { sessionId: stableSessionId(providerId, account, oauthCtx.encKey) }
        : undefined;
  return createProviderClient(
    accountConfig,
    { baseUrl: spec.baseUrl ?? base.baseUrl, timeoutMs: base.timeoutMs },
    cred,
    proxy,
    identity,
    onResponseMeta,
    fastMode,
    codexRuntime,
    xaiRuntime,
  );
}

// Turn bound subscription credentials into routable providers (issue #38, "connect
// = routable"): for each executor-ready provider NOT already declared in
// providers.yaml, build a POOL over ALL its SCHEDULABLE bound accounts. Each
// account gets its own per-account client (token manager + egress proxy + executor
// type); the pool selects one per request by priority (asc) then LRU round-robin
// (Stage 3). The synthetic provider config exposes the UNION of the accounts'
// enabled models to Lanes. Discovery is live where possible (Copilot /models),
// else curated. Fail-open (principle 3): a dead credential / empty model list skips
// THAT account (logged); a provider with no live account is skipped entirely;
// startup is never blocked.
export async function synthesizeOAuthProviders(
  configured: ReadonlyArray<ProviderConfigShared>,
  oauthCtx: OAuthRuntimeCtx | undefined,
  config: ConfigStore,
  fallbackBaseUrl: string,
  timeoutMs: number,
  log: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void,
  // Per-account upstream quota-header sink (providers page Tier 3). Bound per built
  // client so the Codex `x-codex-*` window scrape knows which subscription it came
  // from. Optional — absent in unit tests (no quota capture).
  onQuotaHeaders?: (providerId: string, account: string, headers: Headers) => void,
  // Per-account user-message serial queue (issue #93, feature B). One LONG-LIVED
  // gate shared across pool rebuilds (queue state survives an admin save) plus a
  // live-settings thunk; each member client is wrapped so user-message requests
  // to the SAME account serialize with the configured delay. Optional — absent
  // in unit tests and when the feature is unwired.
  userMessageQueue?: {
    gate: KeyedSerialGate;
    getConfig: () => { enabled: boolean; delayMs: number; timeoutMs: number };
  },
  // Persisted quota snapshots keyed `${providerId} ${account}` (from oauth_quota).
  // Cooldowns are hard scheduling gates; windows/capturedAt are soft scoring inputs
  // for quota-aware strategies and must fail open when missing/stale.
  quotaSeeds?: ReadonlyMap<string, OAuthQuotaSeed>,
  // Pool-local 429 handling can retry a sibling account and hide the failed account
  // from the executor. This hook persists the cooldown the pool already applied in
  // memory, so rebuilds/restarts keep routing around that account.
  onAccountRateLimit?: (providerId: string, account: string, untilMs: number) => void,
  // Pool-local credential failures are permanent until reconnect. Persist the
  // auto-disabled state so admin status, rebuilds, and restarts agree with the live pool.
  onAccountCredentialFailure?: (providerId: string, account: string, error: unknown) => void,
  // Shared account-scoped Codex model catalog. When present, Codex synthesis uses
  // complete ModelInfo snapshots instead of reducing discovery to static slugs.
  codex?: CodexOAuthRuntime,
  // Shared account-scoped cache for non-Codex live discovery. The composition
  // root also gives this instance to Admin so status reads and pool rebuilds do
  // not independently call the provider's models endpoint.
  modelDiscoveryCache?: OAuthModelDiscoveryCache,
): Promise<SynthesizedOAuth> {
  if (!oauthCtx) {
    return {
      providers: [],
      poolClients: new Map(),
      codexKeys: [],
      xaiModels: new Map(),
      xaiModelAccounts: new Map(),
    };
  }
  const declared = new Set<string>(
    configured.flatMap((p) => (p.oauth && isOAuthPreset(p.oauth) ? [p.oauth.provider] : [])),
  );
  // Group every bound account by routable provider (skip providers without a wired
  // executor and any provider already declared in providers.yaml).
  const accountsByProvider = new Map<string, string[]>();
  for (const b of await oauthCtx.store.list()) {
    if (!ROUTABLE_OAUTH[b.providerId] || declared.has(b.providerId)) continue;
    const list = accountsByProvider.get(b.providerId) ?? [];
    list.push(b.account);
    accountsByProvider.set(b.providerId, list);
  }
  // Per-account settings: enabledModels curation + priority + schedulable.
  // Loaded once (fail-open to {}).
  const accountSettings = await loadAccountSettings(config, oauthCtx.encKey);
  const globalSettings = await loadGlobalOAuthSettings(config, oauthCtx.encKey);
  const selectionStrategy: OAuthSelectionStrategy = globalSettings.selectionStrategy ?? "balanced";
  const providers: ProviderConfigShared[] = [];
  const poolClients = new Map<string, OAuthPoolClient>();
  const codexKeys: CodexModelCacheKey[] = [];
  const xaiModels = new Map<string, XaiOAuthModel>();
  const xaiModelAccounts = new Map<string, string[]>();

  for (const [providerId, accounts] of accountsByProvider) {
    const spec = ROUTABLE_OAUTH[providerId];
    const provider = getOAuthProvider(providerId);
    if (!spec || !provider) continue;

    // Build a pool member per SCHEDULABLE account (a parked account stays connected
    // but never routes). Accumulate the UNION of enabled models across the members.
    const members: OAuthPoolMember[] = [];
    const unionModels = new Set<string>();
    const unionWireModels = new Map<string, string>();
    for (const account of accounts) {
      const s = getAccountSettings(accountSettings, providerId, account);
      if (typeof s.credentialFailedAt === "number") {
        log("warn", "oauth.autoroute.skip", {
          providerId,
          account,
          reason: "credential failed",
        });
        continue;
      }
      if (s.schedulable === false) {
        log("info", "oauth.autoroute.parked", { providerId, account });
        continue;
      }
      // The account's egress proxy gates EVERY leg from here on: token refresh,
      // model discovery, and (below) the executor client — so a proxied account
      // never leaks the real IP at any stage (issue #38).
      const proxy = resolveProviderProxy(
        { oauth: { provider: providerId, account } } as unknown as ProviderConfigShared,
        accountSettings,
      );
      const proxyFetch = proxy ? makeProxyFetch(proxy) : undefined;
      const tm = createTokenManager({
        oauth: { kind: "preset", providerId, account },
        tokenStore: oauthCtx.store,
        encKey: oauthCtx.encKey,
        oauthProvider: provider,
        fetch: proxyFetch,
        now: () => Date.now(),
        expirySkewMs: executionTokenExpirySkewMs(timeoutMs),
      });
      let accessToken: string;
      try {
        accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
      } catch {
        log("warn", "oauth.autoroute.skip", { providerId, account, reason: "refresh failed" });
        continue;
      }
      const modelsMode = resolveAccountModelsMode(providerId, s);
      let discovered: string[];
      let discoveredWireModels = new Map<string, string>();
      let discoveredXaiModels = new Map<string, XaiOAuthModel>();
      let accountCodexRuntime: CodexAccountRuntime | undefined;
      let accountXaiRuntime: XaiAccountRuntime | undefined;
      if (providerId === "xai") {
        // grok-build's catalog `id` is the directory key while `model` is the
        // inference slug. Only Responses entries are routable because that is the
        // sole xAI transport Helm implements today; every other backend stays visible
        // in listXaiOAuthModels metadata but fails closed here.
        let catalog: XaiOAuthModel[];
        let discoverySucceeded = false;
        try {
          const metadata = tm.currentMetadata();
          catalog = await listXaiOAuthModels(accessToken, proxyFetch, {
            identity: {
              userId: identityString(metadata.accountId),
              email: identityString(metadata.email),
            },
          });
          discoverySucceeded = true;
        } catch {
          // A validated account-scoped structured LKG preserves the catalog id,
          // wire model and request defaults. Never fall back to guessed public API
          // ids or the generic string discovery cache.
          catalog = s.xaiDiscoveredModels ?? [];
        }
        if (
          discoverySucceeded &&
          !(await saveAccountXaiDiscoveredModels(config, oauthCtx.encKey, account, catalog))
        ) {
          log("warn", "oauth.models.snapshot_write_failed", { providerId, account });
        }
        const routable = catalog.filter(isRoutableXaiOAuthModel);
        const enabled = modelsMode === "manual" ? new Set(s.enabledModels ?? []) : undefined;
        const selected = enabled ? routable.filter((model) => enabled.has(model.id)) : routable;
        const selectedMedia = enabled
          ? GROK_OAUTH_MEDIA_MODELS.filter((model) => enabled.has(model))
          : GROK_OAUTH_MEDIA_MODELS;
        discovered = selected.map((model) => model.id);
        discoveredWireModels = new Map(selected.map((model) => [model.id, model.model]));
        discoveredXaiModels = new Map(selected.map((model) => [model.id, model]));
        for (const model of selectedMedia) {
          if (!discovered.includes(model)) discovered.push(model);
          discoveredWireModels.set(model, model);
        }
        accountXaiRuntime = {
          modelsByWireModel: new Map(selected.map((model) => [model.model, model])),
        };
      } else if (providerId !== "openai-codex" && modelsMode === "manual") {
        discovered = s.enabledModels ?? [];
      } else if (providerId === "openai-codex" && codex) {
        const clientVersion = codex.clientVersion ?? DEFAULT_OPENAI_CODEX_CLIENT_VERSION;
        const loaded = await loadCodexAccountCatalog({
          account,
          tokenManager: tm,
          proxyFetch,
          clientVersion,
          catalog: codex.catalog,
          runInBackground: codex.runInBackground,
          onCatalogChanged: codex.onCatalogChanged,
        });
        discovered = loaded
          ? expandOpenAICodexModelAliases(
              [...loaded.snapshot.models]
                .sort((left, right) => left.priority - right.priority)
                .map((model) => model.slug),
            )
          : [];
        if (loaded) codexKeys.push(loaded.key);
        accountCodexRuntime = loaded?.runtime;
      } else {
        const discoverExact = () =>
          discoverOAuthModels(providerId, accessToken, proxyFetch, {
            fallbackToCurated: false,
          });
        const exact = modelDiscoveryCache
          ? await modelDiscoveryCache.load({ providerId, account }, discoverExact)
          : await discoverExact();
        const accepted = modelDiscoveryCache
          ? modelDiscoveryCache.snapshot({ providerId, account })
          : exact;
        if (
          accepted &&
          accepted.length > 0 &&
          !(await saveAccountDiscoveredModels(
            config,
            oauthCtx.encKey,
            providerId,
            account,
            accepted,
          ))
        ) {
          log("warn", "oauth.models.snapshot_write_failed", { providerId, account });
        }
        discovered = exact.length > 0 ? exact : (CURATED_OAUTH_MODELS[providerId] ?? []);
      }
      // Auto follows the authenticated account catalog. Manual is an explicit
      // allowlist and remains authoritative even for ids discovery did not report.
      if (modelsMode === "manual" && providerId === "openai-codex") {
        const enabled = new Set(s.enabledModels ?? []);
        discovered = discovered.filter((model) => enabled.has(model));
      }
      if (discovered.length === 0) {
        log("warn", "oauth.autoroute.no_models", { providerId, account });
        continue;
      }
      let memberModels = discovered;
      if (providerId === "xai") {
        const acceptedIds: string[] = [];
        const acceptedWireModels: string[] = [];
        for (const id of discovered) {
          const wireModel = discoveredWireModels.get(id);
          if (!wireModel) continue;
          const alias = `${providerId}/${id}`;
          const modelMetadata = discoveredXaiModels.get(id);
          const existingMetadata = xaiModels.get(alias);
          if (
            modelMetadata &&
            existingMetadata &&
            JSON.stringify(existingMetadata) !== JSON.stringify(modelMetadata)
          ) {
            log("warn", "oauth.autoroute.model_metadata_conflict", {
              providerId,
              account,
              model: id,
            });
            continue;
          }
          const existing = unionWireModels.get(id);
          if (existing !== undefined && existing !== wireModel) {
            log("warn", "oauth.autoroute.model_mapping_conflict", {
              providerId,
              account,
              model: id,
            });
            continue;
          }
          unionModels.add(id);
          unionWireModels.set(id, wireModel);
          if (modelMetadata) xaiModels.set(alias, modelMetadata);
          acceptedIds.push(id);
          acceptedWireModels.push(wireModel);
        }
        discovered = acceptedIds;
        memberModels = acceptedWireModels;
      } else {
        for (const model of discovered) {
          unionModels.add(model);
          unionWireModels.set(model, model);
        }
      }
      if (discovered.length === 0) {
        log("warn", "oauth.autoroute.no_models", { providerId, account });
        continue;
      }
      // Bind the quota-header scrape to THIS account (providers page Tier 3): the
      // Codex client invokes it with each reply's headers; synthesis closes over the
      // account so the snapshot is attributed correctly. undefined ⇒ no capture.
      const onResponseMeta = onQuotaHeaders
        ? (headers: Headers) => onQuotaHeaders(providerId, account, headers)
        : undefined;
      // Per-account executor client: type + oauth preset + base, threaded with the
      // egress proxy + stable anti-ban identity. Extracted to buildOAuthAccountClient
      // so the admin connectivity tester binds IDENTICALLY (it shares this builder).
      const client = buildOAuthAccountClient(
        providerId,
        account,
        oauthCtx,
        proxy,
        s.fastMode === true,
        { baseUrl: fallbackBaseUrl, timeoutMs },
        onResponseMeta,
        accountCodexRuntime,
        accountXaiRuntime,
      );
      if (!client) continue; // unreachable (token just refreshed) — fail-open guard
      // Serialize user-message requests per account (issue #93, feature B). The
      // wrap sits INSIDE the pool member so the gate key is the concrete account
      // the pool selected; non-user turns and a disabled setting pass through.
      const queueKey = `${providerId} ${account}`;
      const quotaSeed = quotaSeeds?.get(queueKey);
      const serialized = userMessageQueue
        ? createSerializingClient({
            inner: client,
            gate: userMessageQueue.gate,
            key: queueKey,
            getConfig: userMessageQueue.getConfig,
            isUserMessage: isUserMessageRequest,
            log: (lvl, msg, fields) => log(lvl, msg, fields),
          })
        : client;
      members.push({
        account,
        priority: s.priority ?? 50,
        schedulable: true,
        models: memberModels,
        client: serialized,
        isAtCapacity: userMessageQueue
          ? () => {
              const qc = userMessageQueue.getConfig();
              return (
                qc.enabled &&
                userMessageQueue.gate.wouldQueue({ key: queueKey, delayMs: qc.delayMs })
              );
            }
          : undefined,
        // Seed the auto-park cooldown from the persisted snapshot (survives restart /
        // rebuild). A past timestamp is harmless — select() treats now>=until as
        // eligible — so stale seeds self-clear.
        usageLimitedUntilMs: quotaSeed?.usageLimitedUntilMs ?? null,
        allowSpendRemainingCredits: s.allowSpendRemainingCredits === true,
        quotaWindows: quotaSeed?.windows,
        quotaCapturedAtMs: quotaSeed?.capturedAt,
        quotaResetCredits: quotaSeed?.resetCredits ?? null,
      });
      if (providerId === "xai") {
        for (const id of discovered) {
          const alias = `${providerId}/${id}`;
          const accounts = xaiModelAccounts.get(alias) ?? [];
          if (!accounts.includes(account)) accounts.push(account);
          xaiModelAccounts.set(alias, accounts);
        }
      }
    }

    if (members.length === 0 || unionModels.size === 0) {
      log("warn", "oauth.autoroute.empty", { providerId });
      continue;
    }
    // ONE pool client per provider, keyed by providerId. onSelect records the
    // serving account (Stage 3 telemetry) — a non-secret structured log line.
    const pool = createOAuthPoolClient({
      members,
      now: () => Date.now(),
      selectionStrategy,
      // grok-build treats only inference 401 as an invalid xAI credential. A 403 can
      // be a policy/content denial and must reach normal fallback without parking the
      // subscription account. Other OAuth providers keep the legacy 401/403 policy.
      upstreamCredentialFailureStatuses: providerId === "xai" ? [401] : undefined,
      onSelect: (account, selection) => {
        log("info", "oauth.pool.select", {
          providerId,
          account,
          selection_reason: selection.reason,
          selection_strategy: selection.strategy,
          affinity_key_source: selection.affinityKeySource,
          capacity_avoided: selection.capacityAvoided,
          all_candidates_at_capacity: selection.allCandidatesAtCapacity,
          busy_eligible_accounts: selection.busyEligibleAccounts,
          retry_attempt: selection.retryAttempt,
        });
        // Stamp the per-request holder so the route's settle path can attribute
        // today's usage to THIS subscription (providers page Tier 2). No-op when
        // not inside a capture scope (fail-open; never throws).
        markServingAccount(providerId, account);
      },
      accountRateLimitCooldownMs: DEFAULT_429_COOLDOWN_MS,
      onAccountRateLimit: (account, untilMs) => onAccountRateLimit?.(providerId, account, untilMs),
      onAccountCredentialFailure: (account, error) =>
        onAccountCredentialFailure?.(providerId, account, error),
      resolveRateLimitScope: ({ model, error }) =>
        resolveOAuthRateLimitScope(providerId, model, error),
      // Let the in-pool retry fail over across accounts on an IN-BAND pre-output failure
      // (200-then-`response.failed`/overloaded after only the preamble): wrap each member's
      // SSE with the protocol's pre-output guard so the doomed stream rotates to a sibling
      // instead of committing on the preamble. Native = the provider's own wire protocol;
      // translated requests always emit openai_chat frames.
      nativeStreamPreambleClassifier: preOutputClassifierFor(spec.targetProviderProtocol),
      chatStreamPreambleClassifier: preOutputClassifierFor("openai_chat"),
    });
    poolClients.set(providerId, pool);
    providers.push({
      name: providerId,
      alias: providerId,
      type: spec.type,
      base_url: spec.baseUrl,
      // The synthetic config keeps an oauth preset (informational); the pool
      // client below overrides any single-account client for this provider name.
      oauth: { provider: providerId, account: members[0]?.account ?? "default" },
      models: [...unionModels].map((model) => ({
        alias: `${providerId}/${model}`,
        provider_model: unionWireModels.get(model) ?? model,
      })),
      targetProviderProtocol: spec.targetProviderProtocol,
      providerRequiresCompatibilityRewrite: spec.providerRequiresCompatibilityRewrite,
    } as unknown as ProviderConfigShared);
    log("info", "oauth.autoroute", {
      providerId,
      accounts: members.length,
      models: unionModels.size,
      selection_strategy: selectionStrategy,
    });
  }
  return { providers, poolClients, codexKeys, xaiModels, xaiModelAccounts };
}

// Per-account egress proxy resolver (issue #38 follow-up). A preset OAuth provider
// MAY pin a proxy in its account settings so its upstream traffic leaves from a
// distinct IP. Returns the validated proxy for `p`'s bound account, or undefined
// (direct connection) when none is set / `p` is not a preset OAuth provider. The
// settings map is loaded once at the composition root; proxies are keyed by the
// SAME `${providerId} ${account}` composite as the rest of the per-account state.
export function resolveProviderProxy(
  p: ProviderConfigShared,
  accountSettings: AccountSettingsMap,
): ProxyConfig | undefined {
  if (!p.oauth || !isOAuthPreset(p.oauth)) return undefined;
  const proxy = getAccountSettings(accountSettings, p.oauth.provider, p.oauth.account).proxy;
  return proxy ? (proxy as ProxyConfig) : undefined;
}

function resolveProviderFastMode(
  p: ProviderConfigShared,
  accountSettings: AccountSettingsMap,
): boolean {
  if (!p.oauth || !isOAuthPreset(p.oauth)) return false;
  return getAccountSettings(accountSettings, p.oauth.provider, p.oauth.account).fastMode === true;
}

function isAnthropicPresetOAuth(p: ProviderConfigShared): boolean {
  return (
    p.type === "anthropic" &&
    p.oauth !== undefined &&
    isOAuthPreset(p.oauth) &&
    p.oauth.provider === "anthropic"
  );
}

export function resolveProviderTransportProfile(p: ProviderConfigShared): TransportProfile {
  if (p.transport_profile === "tls_chrome") return "tls_chrome";
  if (p.transport_profile === "default") return "default";
  return isAnthropicPresetOAuth(p) ? "tls_chrome" : "default";
}

// Names of every provider that resolves to the Chrome-TLS transport (Anthropic
// preset OAuth under transport_profile:auto, or an explicit tls_chrome). Used at
// startup to probe the optional wreq-js native transport ONCE and warn loudly if
// it cannot load — so the gap surfaces at deploy time, not silently on the first
// Anthropic OAuth request (see checkTlsTransportAvailable / buildServer).
export function tlsTransportProviders(cfgs: readonly ProviderConfigShared[]): string[] {
  return cfgs.filter((p) => resolveProviderTransportProfile(p) === "tls_chrome").map((p) => p.name);
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function makeProviderFetch(
  p: ProviderConfigShared,
  proxy?: ProxyConfig,
  env: Record<string, string | undefined> = process.env,
): typeof globalThis.fetch | undefined {
  const profile = resolveProviderTransportProfile(p);
  if (profile === "default") return proxy ? makeProxyFetch(proxy) : undefined;
  if (profile === "tls_chrome") {
    if (!isAnthropicPresetOAuth(p)) {
      throw new Error(
        "transport_profile=tls_chrome is only supported for Anthropic preset OAuth providers",
      );
    }
    return makeTlsImpersonationFetch({
      proxy,
      browser: env.HELM_TLS_BROWSER_PROFILE,
      os: env.HELM_TLS_OS_PROFILE,
      timeoutMs: optionalPositiveInt(env.HELM_TLS_TRANSPORT_TIMEOUT_MS),
    });
  }
  return undefined;
}

// Resolve a provider's credential from env / store (issue #38). Returns null when
// a required secret is unset / no credential is stored — the caller decides
// fail-open (skip a non-primary provider) vs fail-closed (throw for the primary).
// Each OAuth provider gets ONE process-level TokenManager (1:1 with its client),
// shared across requests — lazy refresh, no background timer.
// Exported for unit tests (server.oauth.test.ts); not part of the public API.
export function buildCredential(
  p: ProviderConfigShared,
  oauthCtx?: OAuthRuntimeCtx,
  // The account's egress proxy (preset OAuth only). Threaded into the token
  // manager so a proxied account's token REFRESH leaves through the same hop as its
  // execution traffic — never the real IP (issue #38). undefined ⇒ direct.
  proxy?: ProxyConfig,
  requestTimeoutMs?: number,
): ProviderCredential | null {
  const executionSkew =
    requestTimeoutMs === undefined
      ? {}
      : { expirySkewMs: executionTokenExpirySkewMs(requestTimeoutMs) };
  if (p.oauth) {
    const o = p.oauth;
    // ── PRESET subscription OAuth: credentials live in the OAuthTokenStore,
    //    populated by the admin login. Refresh is delegated to the provider.
    if (isOAuthPreset(o)) {
      // No enc key / store wired (HELM_OAUTH_ENC_KEY unset) → cannot build.
      if (!oauthCtx) return null;
      const provider = getOAuthProvider(o.provider);
      if (!provider) return null;
      const tm = createTokenManager({
        oauth: { kind: "preset", providerId: o.provider, account: o.account },
        tokenStore: oauthCtx.store,
        encKey: oauthCtx.encKey,
        oauthProvider: provider,
        fetch: proxy ? makeProxyFetch(proxy) : undefined,
        now: () => Date.now(),
        ...executionSkew,
      });
      return {
        getAuthHeader: () => tm.getAuthHeader(),
        onUnauthorized: () => tm.invalidate(),
        currentSecrets: () => tm.currentSecrets(),
        currentMetadata: () => tm.currentMetadata(),
      };
    }
    // ── CONFIDENTIAL-client OAuth (generic SSO / client_credentials): env secrets.
    const clientId = process.env[o.client_id_env];
    const clientSecret = process.env[o.client_secret_env];
    const refreshToken = o.refresh_token_env ? process.env[o.refresh_token_env] : undefined;
    // Any REQUIRED secret unset → cannot build (fail-open at the caller).
    if (!clientId || !clientSecret) return null;
    if (o.grant === "refresh_token" && !refreshToken) return null;
    const tm = createTokenManager({
      oauth: {
        grant: o.grant,
        tokenUrl: o.token_url,
        clientId,
        clientSecret,
        refreshToken,
        scopes: o.scopes,
        audience: o.audience,
      },
      now: () => Date.now(),
      ...executionSkew,
    });
    return {
      getAuthHeader: () => tm.getAuthHeader(),
      onUnauthorized: () => tm.invalidate(),
      currentSecrets: () => tm.currentSecrets(),
      currentMetadata: () => tm.currentMetadata(),
    };
  }
  // Static key path: env var NAME → plaintext key (or null when unset).
  const apiKey = p.api_key_env ? process.env[p.api_key_env] : undefined;
  if (!apiKey) return null;
  return { apiKey };
}

// Build one OpenAI-compatible client per configured provider, keyed by provider
// NAME, so the executor can dispatch each resolved candidate to the right
// upstream (cross-provider fallback). Credentials come ONLY from env (principle 7
// — never plaintext in config), resolved by buildCredential (static key OR OAuth
// token manager). A provider whose required credential env is unset is SKIPPED (it
// cannot be invoked); its aliases will fail open at resolve/execute time rather
// than blocking startup of the others. The PRIMARY provider's missing credential
// is still fatal (handled by the caller) since it backs the default path.
// Exported for unit tests (server.oauth.test.ts); not part of the public API.
export function buildProviderClients(
  providers: ReadonlyArray<ProviderConfigShared>,
  fallbackBaseUrl: string,
  timeoutMs: number,
  oauthCtx?: OAuthRuntimeCtx,
  // Per-account proxy settings (issue #38 follow-up). Optional so the existing
  // unit tests stay valid; when absent, every account egresses directly.
  accountSettings: AccountSettingsMap = {},
): Map<string, ProviderClient> {
  const clients = new Map<string, ProviderClient>();
  for (const p of providers) {
    const proxy = resolveProviderProxy(p, accountSettings);
    const fastMode = resolveProviderFastMode(p, accountSettings);
    const cred = buildCredential(p, oauthCtx, proxy, timeoutMs);
    if (!cred) continue; // no credential → cannot build a client; skip.
    const baseUrl = p.base_url ?? fallbackBaseUrl;
    clients.set(
      p.name,
      createProviderClient(p, { baseUrl, timeoutMs }, cred, proxy, undefined, undefined, fastMode),
    );
  }
  return clients;
}

// Dispatch on provider `type` (issue #38): a native Anthropic subscription
// provider (Claude Pro/Max via OAuth) speaks the Anthropic Messages API with
// Claude-Code identity headers; everything else is OpenAI-compatible. Copilot is
// OpenAI-shaped, so it reuses the OpenAI client (with its editor headers injected
// at wiring time via base_url derived from the token).
function createProviderClient(
  p: ProviderConfigShared,
  base: { baseUrl: string; timeoutMs: number },
  cred: ProviderCredential,
  // Per-account egress proxy (issue #38 follow-up). When set, ALL of this
  // provider's upstream traffic tunnels through it via the executor's injected
  // `fetch` seam — invisible to the protocol layer. undefined ⇒ direct connection.
  proxy?: ProxyConfig,
  // Stable per-account subscription identity (anti-ban, issue #38). Computed ONCE
  // per account by synthesis (deterministic, never per-request): Anthropic carries
  // it as metadata.user_id; Codex as a stable session_id / prompt_cache_key.
  identity?: { metadataUserId?: string; sessionId?: string },
  // Upstream response-header hook (providers page Tier 3 quota). Only the Codex
  // client uses it today (its `x-codex-*` rate-limit windows are PUSHed on every
  // reply); bound per-account by synthesis so the scrape knows which subscription.
  onResponseMeta?: (headers: Headers) => void,
  // Per-account Fast mode for OAuth subscription providers. The provider client
  // forces the corresponding upstream request field when this account serves a call.
  fastMode = false,
  // Account-scoped Codex catalog + identity contract. Present only for synthesized
  // ChatGPT subscription accounts; generic Responses providers do not consume it.
  codexRuntime?: CodexAccountRuntime,
  // Account-scoped xAI catalog metadata keyed by the actual inference wire model.
  // Omitted for static providers and connectivity probes that did no discovery.
  xaiRuntime?: XaiAccountRuntime,
): ProviderClient {
  // One proxy fetch per client (the executor keeps one client per account, so the
  // undici dispatcher is pooled per account). Built ONCE here, not per request.
  const providerFetch = makeProviderFetch(p, proxy);
  if (p.type === "anthropic") {
    return createAnthropicClient({
      config: {
        ...base,
        ...cred,
        metadataUserId: identity?.metadataUserId,
        claudeCliFingerprintMode: p.claude_cli_fingerprint_mode,
        fastMode,
      },
      fetch: providerFetch,
    });
  }
  // ChatGPT Codex subscription: the OpenAI *Responses* protocol (stream-only,
  // ChatGPT identity headers, account-id decoded from the access-token JWT). Needs
  // the dynamic OAuth header; a static key never drives this path.
  if (p.type === "openai-responses" && "getAuthHeader" in cred) {
    const client = createCodexResponsesClient({
      config: {
        ...base,
        ...cred,
        sessionId: identity?.sessionId,
        onResponseMeta,
        fastMode,
        userAgent: codexRuntime?.userAgent,
        getAccountIdentity: () => ({
          ...codexRuntime?.accountIdentity,
          ...codexIdentityFromMetadata(cred.currentMetadata()),
        }),
        resolveModelInfo: codexRuntime
          ? (model) => codexRuntime.catalog.resolve(codexRuntime.key, model)
          : undefined,
        onModelsEtag: codexRuntime
          ? (etag) => {
              codexRuntime.runInBackground(() =>
                codexRuntime.catalog.observeEtag(
                  codexRuntime.key,
                  etag,
                  codexRuntime.fetchModels,
                  codexRuntime.onCatalogChanged,
                ),
              );
            }
          : undefined,
        responsesWebSocketConnector: createCodexResponsesWebSocketConnector({
          proxy,
          timeoutMs: base.timeoutMs,
        }),
      },
      fetch: providerFetch,
    });
    const realtimeClient = createOpenAIClient({
      config: {
        ...base,
        ...cred,
        realtimeProxy: proxy,
        extraHeaders: (): Record<string, string> => {
          const identity = {
            ...codexRuntime?.accountIdentity,
            ...codexIdentityFromMetadata(cred.currentMetadata()),
          };
          return {
            ...(identity.accountId ? { "chatgpt-account-id": identity.accountId } : {}),
            ...(codexRuntime?.userAgent ? { "User-Agent": codexRuntime.userAgent } : {}),
          };
        },
      },
      fetch: providerFetch,
    });
    const prepareNative = (input: NativePassthroughInput): NativePassthroughInput => {
      const versionedInput = normalizeCodexNativeClientVersion(input);
      const body = nativePassthroughBody(versionedInput);
      const model = typeof body.model === "string" ? body.model : "";
      const modelInfo =
        codexRuntime && model.length > 0
          ? codexRuntime.catalog.resolve(codexRuntime.key, model)
          : undefined;
      const hoisted = hoistResponsesInstructions(body, {
        ...(isNativePassthroughCarrier(versionedInput) ? { headers: versionedInput.headers } : {}),
        modelInfo,
      });
      let nextBody = hoisted.body;
      let ultraMapped = false;
      const reasoning = nextBody.reasoning;
      if (
        reasoning !== null &&
        typeof reasoning === "object" &&
        !Array.isArray(reasoning) &&
        (reasoning as Record<string, unknown>).effort === "ultra"
      ) {
        nextBody = {
          ...nextBody,
          reasoning: { ...(reasoning as Record<string, unknown>), effort: "max" },
        };
        ultraMapped = true;
      }
      if (nextBody === body) return versionedInput;
      if (!isNativePassthroughCarrier(versionedInput)) return nextBody;
      if (hoisted.fix !== "none") {
        appendMutationList(versionedInput.mutations, "body_shims_applied", [
          hoisted.fix === "hoisted_from_input"
            ? "instructions_hoisted_from_input"
            : "instructions_defaulted",
        ]);
      }
      if (ultraMapped) {
        appendMutationList(versionedInput.mutations, "body_shims_applied", [
          "codex_ultra_reasoning_mapped_to_max",
        ]);
      }
      return cloneCarrierWithBody(versionedInput, nextBody);
    };
    return {
      ...client,
      realtimeCall: realtimeClient.realtimeCall,
      async nativePassthrough(body, opts) {
        if (!client.nativePassthrough) {
          throw new Error("Codex native passthrough is unavailable");
        }
        return await client.nativePassthrough(prepareNative(body), opts);
      },
      nativePassthroughStream(body, opts) {
        if (!client.nativePassthroughStream) {
          throw new Error("Codex native passthrough streaming is unavailable");
        }
        return client.nativePassthroughStream(prepareNative(body), opts);
      },
      async responsesCompact(body, opts) {
        if (!client.responsesCompact) {
          throw new Error("Codex Responses compact is unavailable");
        }
        return await client.responsesCompact(prepareNative(body), opts);
      },
    };
  }
  if (
    p.type === "openai-responses" ||
    p.type === "openai-responses-generic" ||
    p.type === "openai_responses_generic"
  ) {
    const isXaiOAuth =
      p.oauth !== undefined && isOAuthPreset(p.oauth) && p.oauth.provider === "xai";
    const responsesClient = createGenericOpenAIResponsesClient({
      config: { ...base, ...cred },
      ...(isXaiOAuth
        ? {
            requestContract: {
              forceSse: true,
              forceStoreFalse: true,
              ensureReasoningEncryptedContent: true,
              ensureInstructions: true,
              rejectPreviousResponseId: true,
              rejectObjectInput: true,
              resolveModelRequestDefaults: (model: string) => {
                const metadata = xaiRuntime?.modelsByWireModel.get(model);
                return metadata
                  ? {
                      ...(metadata.streamToolCalls !== undefined
                        ? { streamToolCalls: metadata.streamToolCalls }
                        : {}),
                      ...(metadata.maxCompletionTokens !== undefined
                        ? { maxCompletionTokens: metadata.maxCompletionTokens }
                        : {}),
                    }
                  : undefined;
              },
              requestHeaders: ({ model }: { model: string }) =>
                xaiGrokInferenceHeaders(model, process.env, {
                  userId:
                    "currentMetadata" in cred
                      ? identityString(cred.currentMetadata().accountId)
                      : undefined,
                }),
            },
          }
        : {}),
      fetch: providerFetch,
    });
    if (!isXaiOAuth) return responsesClient;
    const mediaClient = createOpenAIClient({
      config: { ...base, baseUrl: "https://api.x.ai/v1", ...cred },
      fetch: providerFetch,
    });
    return {
      ...responsesClient,
      imageGeneration: mediaClient.imageGeneration,
      imageEdit: mediaClient.imageEdit,
      videoGeneration: mediaClient.videoGeneration,
      videoRetrieve: mediaClient.videoRetrieve,
    };
  }
  if (p.type === "gemini") {
    return createGeminiClient({
      config: {
        ...base,
        ...cred,
        remoteMediaFetch:
          p.remote_media_fetch !== undefined
            ? {
                enabled: p.remote_media_fetch.enabled,
                maxBytes: p.remote_media_fetch.max_bytes,
                timeoutMs: p.remote_media_fetch.timeout_ms,
                maxRedirects: p.remote_media_fetch.max_redirects,
                allowedMimeTypes: p.remote_media_fetch.allowed_mime_types,
              }
            : undefined,
      },
      fetch: providerFetch,
    });
  }
  // GitHub Copilot is OpenAI-compatible, BUT: (1) it requires editor identity
  // headers on every call, and (2) its API host comes from the current token's
  // `proxy-ep` (the short-lived Copilot token rotates, so the host can change).
  // Inject both via the openai client's generic seams; the per-request base URL
  // resolver also forces getAuthHeader() — so a routed request re-mints the
  // Copilot token on demand (auto-refresh on use).
  if (
    p.oauth &&
    isOAuthPreset(p.oauth) &&
    p.oauth.provider === "github-copilot" &&
    "getAuthHeader" in cred
  ) {
    const getAuth = cred.getAuthHeader;
    return createOpenAIClient({
      config: {
        ...base,
        ...cred,
        extraHeaders: () => ({ ...COPILOT_HEADERS }),
        mapDeveloperRoleToSystem: p.map_developer_role_to_system,
        normalizeReasoningDeltaAlias: p.normalize_reasoning_delta_alias,
        resolveBaseUrl: async () =>
          getGitHubCopilotBaseUrl((await getAuth()).replace(/^Bearer /, "")),
      },
      fetch: providerFetch,
    });
  }
  return createOpenAIClient({
    config: {
      ...base,
      ...cred,
      realtimeProxy: proxy,
      mapDeveloperRoleToSystem: p.map_developer_role_to_system,
      normalizeReasoningDeltaAlias: p.normalize_reasoning_delta_alias,
    },
    fetch: providerFetch,
  });
}

// First-run connectivity probe for a static provider key. The key is injected
// directly into a short-lived client — never written to process.env, config, the
// Store, or logs. A one-token completion validates both authentication and actual
// model access (a public /models endpoint would not prove either for every provider).
export async function testStaticProviderKey(
  provider: ProviderConfigShared,
  apiKey: string,
): Promise<void> {
  if (provider.oauth) throw new Error("only static API-key providers can be tested here");
  const model = provider.models[0]?.provider_model;
  if (!model) throw new Error(`provider ${provider.name} has no model configured for testing`);
  const client = createProviderClient(
    provider,
    {
      baseUrl: provider.base_url ?? "https://api.openai.com/v1",
      timeoutMs: 15_000,
    },
    { apiKey },
  );
  await client.chatCompletion(
    {
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false,
    },
    { signal: AbortSignal.timeout(15_000) },
  );
}

// Auxiliary classifier/memory calls require a ProviderClient even before any
// upstream is configured. This explicit unavailable client makes those optional
// paths fail through their existing fail-open handlers without registering a fake
// routable provider or weakening request-time availability checks.
export function createUnavailableProviderClient(name: string): ProviderClient {
  const unavailable = (): Error => new Error(`provider ${name} is not configured`);
  return {
    async chatCompletion() {
      throw unavailable();
    },
    chatCompletionStream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw unavailable();
            },
          };
        },
      };
    },
  };
}

export function supportsAutomaticVacuum(driver: "sqlite" | "supabase"): boolean {
  return driver === "sqlite";
}

// Full wiring: config -> store -> bootstrap key -> provider -> routing pipeline.
// Fail-closed: an invalid config throws (caller exits non-zero). The HTTP listen
// is performed by the caller (index.ts) so this stays testable. Async because the
// Store factory may open a remote Postgres (supabase driver); the sqlite default
// resolves synchronously under the await.
export async function buildServer(
  opts: {
    logger?: Logger;
    configDir?: string;
    memoryCoordinator?: ReturnType<typeof runtimeMemoryCoordinator>;
    resourcePressure?: Pick<
      ReturnType<typeof createRuntimeResourcePressureGate>,
      "shouldRun" | "shouldRunHeavy"
    >;
  } = {},
): Promise<ServerHandle> {
  const logger = opts.logger ?? createJsonLogger();
  const responsesWebSocketSessionProof = randomUUID();
  const memoryBudget = runtimeMemoryBudget();
  const maintenanceActivityGate = createMaintenanceActivityGate();
  const backgroundTasks = createTrackedBackgroundTasks();
  const memoryCoordinator = opts.memoryCoordinator ?? runtimeMemoryCoordinator();
  const requestBodyMemoryAdmission = createBodyMemoryAdmission({
    activeRequestBytes: memoryBudget.activeRequestBytes,
    jsonAmplification: memoryBudget.jsonAmplification,
    minRequestChargeBytes: memoryBudget.minRequestChargeBytes,
    coordinator: memoryCoordinator,
  });
  const websocketIngressAdmission = createBodyMemoryAdmission({
    activeRequestBytes: memoryBudget.websocketIngressBytes,
    jsonAmplification: 1,
    minRequestChargeBytes: 1,
    coordinator: memoryCoordinator,
  });
  logger.log("info", "runtime.memory_budget", {
    heap_limit_bytes: memoryBudget.heapLimitBytes,
    process_limit_bytes: memoryBudget.processLimitBytes,
    request_admission_mode: "dynamic_safe_headroom",
    write_queue_bytes: memoryBudget.writeQueueBytes,
    session_cache_bytes: memoryBudget.sessionCacheBytes,
    response_capture_bytes: memoryBudget.responseCaptureBytes,
    sse_tail_chars: memoryBudget.sseTailChars,
    sqlite_page_cache_bytes: memoryBudget.sqlitePageCacheBytes,
    sqlite_maintenance_cache_bytes: memoryBudget.sqliteMaintenanceCacheBytes,
    websocket_max_payload_bytes: memoryBudget.responseCaptureBytes,
  });
  const config = loadConfig({ configDir: opts.configDir ?? "./config" });
  // Validate the optional Grok proxy protocol override before opening stores or
  // starting background work. Invalid runtime configuration must fail closed at
  // startup even when no xAI account is connected yet.
  resolveXaiGrokClientVersion(process.env);

  // Store adapter set, chosen by config (CLAUDE.md "DB abstraction layer"): sqlite (default,
  // local file) or supabase (hosted Postgres). The factory fails CLOSED on an
  // unknown driver / a missing supabase credential (principle 2). The supabase
  // connection string is referenced by env-var NAME (runtime.store.url_env) and
  // resolved HERE — never read from yaml, never logged (principle 7).
  const dataDir = process.env.HELM_DATA_DIR ?? "./data";
  const storeCfg = config.runtime.store;
  const connectionString =
    storeCfg.driver === "supabase" && storeCfg.url_env ? process.env[storeCfg.url_env] : undefined;
  if (storeCfg.driver === "supabase" && !connectionString) {
    throw new Error(
      `store.driver=supabase but no connection string: set runtime.store.url_env to an env var holding the Postgres DSN`,
    );
  }
  const store: StoreSet = await createStore({ store: storeCfg, dataDir, connectionString });
  // Auth-lookup cache (perf): getByHash runs synchronously on the event-loop thread
  // for EVERY request on all four AI faces (better-sqlite3 is sync). Wrap the shared
  // KeyStore once so repeat lookups of the same bearer key hit an in-process LRU
  // instead of the DB. Mutations flow through this SAME instance (auth + admin key
  // routes + the self-auth faces all use `keyStore`), so an admin create/revoke/edit
  // busts the cache automatically. TTL bounds cross-instance staleness (shared
  // Postgres) — a revoked key keeps serving on another instance for at most TTL.
  const authCacheTtlMs = Number(process.env.HELM_AUTH_CACHE_TTL_MS ?? 30_000);
  const keyStore = createCachedKeyStore(store.keys, {
    ttlMs: Number.isFinite(authCacheTtlMs) && authCacheTtlMs >= 0 ? authCacheTtlMs : 30_000,
    maxEntries: 5_000,
    now: () => Date.now(),
  });
  const telemetry = store.telemetry;
  // Deferred + batched write queue (perf): the four AI faces enqueue their fail-open
  // telemetry/payload/observe writes here so a synchronous better-sqlite3 commit never
  // sits on a request's critical path; batched flushes (N commits → 1) relieve the
  // single event-loop thread under concurrency. Drained on dispose() so a graceful
  // deploy loses nothing. Env knobs are optional (safe code defaults otherwise).
  const flushMsEnv = Number(process.env.HELM_WRITE_QUEUE_FLUSH_MS);
  const maxDepthEnv = Number(process.env.HELM_WRITE_QUEUE_MAX_DEPTH);
  // Late-bound bridge to the memory worker's wake(): the worker is created far below
  // (it needs the observer/reflector deps), but the write queue here must hand it the
  // wake trigger now. A no-op until the worker is wired, so a memory observe settling
  // before boot completes is harmless (the interval backstop still drains it).
  let wakeMemoryWorker: () => void = () => {};
  const writeQueue = createWriteQueue({
    telemetry,
    log: (message) => logger.log("warn", "writequeue", { message }),
    flushIntervalMs: Number.isFinite(flushMsEnv) && flushMsEnv > 0 ? flushMsEnv : 25,
    maxDepth: Number.isFinite(maxDepthEnv) && maxDepthEnv > 0 ? maxDepthEnv : 10_000,
    // After a memory observe task settles, nudge the worker to drain (debounced) so a
    // just-stated fact forms in ~coalesceMs instead of waiting a full interval. Off
    // the request's critical path — the response is already sent by the time tasks run.
    onTaskDrain: () => wakeMemoryWorker(),
  });

  // OAuth subscription runtime (issue #38). PRESET providers store their (rotating)
  // credentials encrypted at rest, so an at-rest key is REQUIRED when any preset is
  // configured (principle 2: fail-closed). HELM_OAUTH_ENC_KEY is resolved HERE
  // (composition root, principle 7) — core only ever sees the decoded key buffer.
  const usesPresetOAuth = config.providers.some((p) => p.oauth && isOAuthPreset(p.oauth));
  const oauthEncKey = loadEncKeyFromEnv();
  if (usesPresetOAuth && !oauthEncKey) {
    throw new Error(
      "a subscription OAuth provider is configured but HELM_OAUTH_ENC_KEY is unset: set a 32-byte key (base64 or 64 hex chars) to encrypt stored tokens",
    );
  }
  // The runtime context threaded into buildCredential (preset token managers) and
  // the admin login surface. Present only when an enc key is available.
  const oauthCtx: OAuthRuntimeCtx | undefined = oauthEncKey
    ? { store: store.oauthTokens, encKey: oauthEncKey }
    : undefined;
  let rebuildOAuthPool: (() => Promise<{ applied: boolean }>) | undefined;
  const codexModelsEtagTracker = createCodexModelsEtagTracker();
  const oauthModelDiscoveryCache = createOAuthModelDiscoveryCache();
  const codexModelTokenManagers = new Map<string, ReturnType<typeof createTokenManager>>();
  const codexModelCatalog = oauthCtx
    ? createCodexModelCatalog({
        cache: createCodexModelCache(store.config, oauthCtx.encKey),
        bundledModels: loadBundledCodexModels(),
        onRefresh: () => codexModelsEtagTracker.invalidate(),
      })
    : undefined;
  const codexClientVersion = resolveOpenAICodexClientVersion(process.env);
  const codexUserAgent = buildOpenAICodexUserAgent(codexClientVersion);
  const codexRuntime: CodexOAuthRuntime | undefined = codexModelCatalog
    ? {
        catalog: codexModelCatalog,
        runInBackground: backgroundTasks.run,
        clientVersion: codexClientVersion,
        userAgent: codexUserAgent,
        onCatalogChanged: () => {
          backgroundTasks.run(
            async () => {
              await rebuildOAuthPool?.();
            },
            (error) =>
              logger.log("warn", "oauth.codex_catalog.rebuild_failed", {
                line: error instanceof Error ? error.message : String(error),
              }),
          );
        },
      }
    : undefined;
  const rebuildAfterOAuthCredentialFailure = async (
    providerId: string,
    account: string,
  ): Promise<void> => {
    const rebuilt = await rebuildOAuthPool?.();
    if (rebuilt?.applied === false) {
      logger.log("warn", "oauth.credential_failure.rebuild_not_applied", {
        provider_id: providerId,
        account,
      });
    }
  };

  // The admin OAuth-login surface, built ONCE here (was inlined into AdminApiDeps
  // below) so the execution-path quota hook can reuse its `consumeCodexResetCredit`
  // for weekly-limit auto-reset. Present only when an enc key is wired (oauthCtx).
  const oauthAdmin = oauthCtx
    ? createOAuthAdmin({
        store: oauthCtx.store,
        encKey: oauthCtx.encKey,
        config: store.config,
        log: (lvl, msg, fields) => logger.log(lvl, msg, fields),
        onCredentialFailure: rebuildAfterOAuthCredentialFailure,
        codexCatalog: codexModelCatalog,
        codexClientVersion,
        codexUserAgent,
        modelDiscoveryCache: oauthModelDiscoveryCache,
      })
    : undefined;

  // Per-account settings blob (issue #38 follow-up): proxy / curation / pool state,
  // loaded ONCE here (fail-open to {}) and threaded into client building so each
  // preset OAuth account egresses through its pinned proxy (if any). Empty when no
  // enc key is wired — then every account connects directly.
  const accountSettings: AccountSettingsMap = oauthCtx
    ? await loadAccountSettings(store.config, oauthCtx.encKey)
    : {};

  // Runtime-mutable settings (admin "System Settings"): persisted overrides for
  // the operator-facing subset that can change WITHOUT a restart (capture_payloads,
  // payload_retention_days, rate_limit_enabled, log_level). Loaded from the
  // config_kv store, seeded from yaml/env defaults; fail-OPEN on a corrupt blob
  // (it is convenience state, not a security boundary). `let` so the admin PUT can
  // re-bind the live value through applySettings below — read by getters injected
  // into the chat route, the rate limiter, and the logger.
  let settings = await loadRuntimeSettings(store.config, config, (lvl, msg, fields) =>
    logger.log(lvl, msg, fields),
  );
  let captureGeneration = 0;
  logger.setLevel?.(settings.log_level);
  // A MUTABLE copy of the rate-limit config: the limiter reads `.enabled` and
  // `.default` fresh on every check(), so flipping the master switch OR retuning
  // the system-default quota applies live without a restart (seeded from settings,
  // which seeded from yaml/env). Per-key overrides ride in on the request probe
  // (Auth → identity.caps.rateLimit), so they never need a re-bind here.
  const rateLimitConfig = {
    ...config.runtime.rate_limit,
    enabled: settings.rate_limit_enabled,
    default: {
      rpm: settings.rate_limit_default_rpm,
      tpm: settings.rate_limit_default_tpm,
    },
  };
  let cleanupScheduler: ReturnType<typeof startCleanupScheduler> | null = null;
  let vacuumScheduler: ReturnType<typeof startCleanupScheduler> | null = null;
  let signalScheduler: ReturnType<typeof startSignalScheduler> | null = null;
  let memoryWorker: ReturnType<typeof startMemoryWorker> | null = null;
  const resourcePressure =
    opts.resourcePressure ??
    createRuntimeResourcePressureGate((message, fields) => logger.log("info", message, fields));
  // Apply a new settings object live: re-bind `settings`, push the log level into
  // the logger, flip the rate-limit master switch, and retune the system-default
  // quota. Cleanup cadence is also rescheduled live so the admin setting is not
  // restart-only. Called by the admin settings route after it validates + persists.
  const applySettings = (next: RuntimeSettings): void => {
    if (
      settings.capture_payloads !== next.capture_payloads ||
      settings.capture_sessions !== next.capture_sessions
    ) {
      captureGeneration++;
    }
    settings = next;
    logger.setLevel?.(next.log_level);
    rateLimitConfig.enabled = next.rate_limit_enabled;
    rateLimitConfig.default = {
      rpm: next.rate_limit_default_rpm,
      tpm: next.rate_limit_default_tpm,
    };
    cleanupScheduler?.reschedule(next.cleanup_interval_hours * 3_600_000);
  };
  // Data cleanup / archival composition (admin "Data cleanup" + the scheduled sweep
  // below). The archive sink writes verified gzip-JSONL under HELM_ARCHIVE_DIR
  // (default <dataDir>/archive); runCleanupPassNow is the SINGLE pass shared by the
  // manual "Clean Now" button and the scheduled tick. Defined here (outer scope) so
  // both the admin route wiring AND the scheduler can reach it.
  const archiveDir = process.env.HELM_ARCHIVE_DIR ?? `${dataDir}/archive`;
  const archiveSink = new LocalVolumeSink(archiveDir);
  const archiveFs = createArchiveFsAccess(archiveDir);
  const maintenanceQueue = createSerializedMaintenanceQueue();
  const executeCleanupPass = async (trigger: "scheduled" | "manual") => {
    const report = await runCleanupPass({
      settings,
      telemetry,
      memory: store.memory,
      oauthUsage: store.oauthUsage,
      config: store.config,
      archiveSink,
      runId: randomUUID(),
      now: () => Date.now(),
      trigger,
      log: (line, meta) => logger.log("info", line, meta as Record<string, unknown> | undefined),
    });
    clearSessionCaptureCache(telemetry);
    return report;
  };
  const runCleanupPassNow = (trigger: "scheduled" | "manual") =>
    maintenanceQueue.run(() => executeCleanupPass(trigger));
  const executeVacuum = async (
    options: { httpAlreadyPaused?: boolean; shouldProceed?: () => Promise<boolean> } = {},
  ) => {
    const activities: PausableActivity[] = [
      ...(options.httpAlreadyPaused ? [] : [maintenanceActivityGate]),
      {
        pauseAndWait: async () => {
          requestBodyMemoryAdmission.pause();
          await requestBodyMemoryAdmission.waitForIdle();
        },
        resume: requestBodyMemoryAdmission.resume,
      },
      {
        pauseAndWait: async () => await memoryWorker?.pauseAndWait(),
        resume: () => memoryWorker?.resume(),
      },
      {
        pauseAndWait: async () => await signalScheduler?.pauseAndWait(),
        resume: () => signalScheduler?.resume(),
      },
      backgroundTasks,
      { pauseAndWait: writeQueue.pauseAndFlush, resume: writeQueue.resume },
    ];
    return withPausedActivities(
      activities,
      async () => {
        clearSessionCaptureCache(telemetry);
        if (options.shouldProceed && !(await options.shouldProceed())) return false;
        await store.vacuum();
        return true;
      },
      { pauseTimeoutMs: maintenanceDrainTimeoutMs(config.runtime.request_timeout_ms) },
    );
  };
  const runVacuumNow = async (): Promise<void> => {
    maintenanceActivityGate.releaseCurrent();
    await maintenanceQueue.run(executeVacuum);
  };
  // Agentic Signals (docs/02). The collector consumes ALREADY-persisted telemetry
  // and writes aggregated, REDACTED signals in the background. The optional
  // routing feedback consumer below reads only those aggregates and remains
  // fail-open, so signal storage never becomes a request-path availability risk.
  const signalCollector = createSignalCollector({
    telemetry,
    signals: store.signals,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Per-key rate limiter (docs/06). Default OFF (config.runtime.rate_limit.enabled)
  // -> zero-overhead pass-through. Counters persist in the SAME store so windows
  // survive restarts / span instances. Sits AFTER auth, BEFORE routing.
  const rateLimiter = createRateLimiter({
    config: rateLimitConfig,
    store: store.rateLimit,
  });

  // Memory observe-phase deps (docs/08 Phase 1), built ONCE process-wide and shared
  // by every request surface (chat / messages / responses). store.memory is the
  // live MemoryStore createStore already returns for both sqlite + postgres — no
  // extra adapter wiring. estimateTokens is a deterministic chars/4 heuristic (NOT
  // estimateRequestTokens, which reads a Content-Length header — wrong shape for a
  // raw string). The logger is redaction-safe: observe core only ever logs ids /
  // counts / mode, never memory content or keys (principle 7).
  const observe: ObserveDeps = {
    memoryStore: store.memory,
    enqueueObserverJob: (scope) => store.memory.enqueueJob({ type: "observer", scope }),
    now: () => new Date(),
    estimateTokens: (text) => Math.ceil(text.length / 4),
    log: (line, meta) => logger.log("info", line, meta as Record<string, unknown> | undefined),
  };

  // Memory deps shared by inject (request path) + the background worker (D10): ONE
  // estimateTokens closure (chars/4) so the hydrate / observer / reflector cost
  // buckets are comparable, and a redaction-safe logger (ids/counts only).
  const estimateMemoryTokens = (text: string): number => Math.ceil(text.length / 4);
  const memoryLog = (line: string, meta?: object): void =>
    logger.log("info", line, meta as Record<string, unknown> | undefined);

  // Inject-phase deps (docs/08 Phase 2). enqueueObserverJob bridges inject's
  // best-effort write-back to the queue (type:"observer"); hydrate tokens land in
  // their OWN cost bucket (principle 7). D9: there is no config.memory subtree yet,
  // so the injected token budget rides an env tunable (fail-safe default + guard).
  // docs/12 P3/P4 — forgetting wiring for the inject path, GATED behind
  // config.memory.forgetting.enabled (default false ⇒ this dep is inert and inject
  // behaves byte-identically to today). When enabled it carries the score-trim
  // tunables (drop_order + the score curve) and a fail-open bumpReferences bound to
  // the live store (the port method is optional; the `?? noop` keeps the dep total).
  const forgettingCfg = config.memory.forgetting;
  const injectForgetting: InjectDeps["forgetting"] = {
    enabled: forgettingCfg.enabled,
    dropOrder: forgettingCfg.inject.drop_order,
    scoreConfig: forgettingCfg.score,
    bumpReferences: (bumpInput) => store.memory.bumpReferences?.(bumpInput) ?? Promise.resolve(),
  };

  const injectDeps: InjectDeps = {
    memoryStore: store.memory,
    estimateTokens: estimateMemoryTokens,
    enqueueObserverJob: (scope) => store.memory.enqueueJob({ type: "observer", scope }),
    costSink: () => {},
    now: () => new Date(),
    log: memoryLog,
    forgetting: injectForgetting,
  };
  const injectTokenBudgetRaw = Number(process.env.HELM_MEMORY_INJECT_TOKEN_BUDGET ?? 4000);
  const injectTokenBudget =
    Number.isFinite(injectTokenBudgetRaw) && injectTokenBudgetRaw > 0 ? injectTokenBudgetRaw : 4000;
  // Salient-fact fast path (salient-fact-memory-spec): the `## Known facts` inject
  // section + the raw-message eager extractor turn on together via
  // config.memory.forgetting.consolidate.eager_facts (config-gated to require
  // llm.enabled). Off ⇒ both halves inert (byte-identical to today).
  const eagerFactsOn = config.memory.forgetting.consolidate.eager_facts === true;
  const maxFactsInjected = config.memory.forgetting.consolidate.max_facts_injected;
  const inject = {
    deps: injectDeps,
    tokenBudget: injectTokenBudget,
    ...(eagerFactsOn ? { injectKnownFacts: true } : {}),
    ...(eagerFactsOn && maxFactsInjected !== undefined ? { maxFactsInjected } : {}),
  };

  // Decay-sweep deps (docs/12 P5). The whole forgetting config drives the pure score +
  // archive threshold + the bounded-loop limits; gated behind forgetting.enabled so the
  // worker only ever receives a 'decay' job (and only ever triggers one) when the flag
  // is on (default off ⇒ inert). Same injected clock as the rest of the memory pipeline.
  const decayDeps: DecayDeps = {
    memoryStore: store.memory,
    config: forgettingCfg,
    now: () => new Date(),
    log: memoryLog,
  };

  // Bootstrap root key on first start (idempotent; prints once). AWAITED before
  // buildServer returns: a store-read failure here MUST reject buildServer so
  // main()'s try/catch exits non-zero (fail-CLOSED, principle 2). Fire-and-forget
  // would both swallow that failure and race the HTTP listen (a request could be
  // served before the root key exists). Cheap on the happy path (one keyed read).
  await bootstrapRootKey({
    keyStore,
    generateKey,
    now: () => new Date(),
    log: (line) => logger.log("warn", "bootstrap.root_key", { line }),
    // Honor the bootstrap knobs (review H1 — previously ignored): generate_if_missing
    // gates auto-minting, print_once gates the log line, persist_to writes the freshly
    // minted plaintext to the operator's file (0600, plaintext is the whole point).
    generateIfMissing: config.auth.bootstrap.generate_if_missing,
    printOnce: config.auth.bootstrap.print_once,
    persist: async (plaintext) => {
      await writeFile(config.auth.bootstrap.persist_to, `${plaintext}\n`, { mode: 0o600 });
    },
  });

  // Internal LLM routing (ALWAYS ON): route memory + Layer-2 eval LLM calls BACK THROUGH
  // helm's own /v1 gateway so they (a) appear in /admin/requests with full request/response
  // payloads and (b) can name a LANE as their model — the /v1 lane-as-model router expands
  // the lane's fallback chain, which a direct provider call cannot. Mint a dedicated
  // internal key (fixed id k_internal, re-minted each boot since the plaintext is
  // unrecoverable) and hold its plaintext ONLY in-process. role:user + allow_custom_model
  // is the minimal privilege (explicit model/lane passthrough); memory_mode:off prevents
  // the self-call from being observed; per-key rate limits are explicitly unlimited so
  // memory/eval background calls do not consume user-facing RPM/TPM. Fail-open: a mint
  // failure leaves selfHttpClient null → direct provider calls (byte-identical to the
  // pre-self-http path), so a broken key store degrades internal LLM but never blocks boot.
  let internalApiKey: string | null = null;
  try {
    if ((await keyStore.list()).some((k) => k.key_id === INTERNAL_API_KEY_ID)) {
      await keyStore.disable(INTERNAL_API_KEY_ID);
      await keyStore.deleteKey(INTERNAL_API_KEY_ID);
    }
    const k = generateKey();
    await keyStore.createKey(buildInternalLlmKeyInput(k));
    internalApiKey = k.plaintext;
    logger.log("info", "internal_llm.key_minted", { key_id: INTERNAL_API_KEY_ID });
  } catch (err) {
    logger.log("warn", "internal_llm.key_mint_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Provider(s): the configured upstreams (providers-multi). The PRIMARY provider
  // (providers[0]) backs the default/eval path and the Phase-0 passthrough when it
  // has a credential. Additional providers each get their own
  // OpenAI-compatible client so a fallback chain can CROSS providers. Credentials
  // come ONLY from the env var each api_key_env names (principle 7). The e2e/test
  // harness points every provider at the mock via HELM_PROVIDER_BASE_URL (used as
  // the shared fallback base_url when a provider omits one).
  const first = config.providers[0];
  if (!first) throw new Error("no provider configured");
  // A primary credential is optional on a new install: configured candidates with
  // no client are skipped by the executor, while an OAuth subscription connected
  // later becomes routable through the hot pool. Invalid PRESENT credentials still
  // fail closed in their own loaders; only an absent secret enters this state.
  // Resolve the primary's egress proxy ONCE and thread it into BOTH the credential
  // (so token refresh tunnels through it) and the client (so chat execution does) —
  // a preset-OAuth primary must not leak the real IP on the eval/default/401 path
  // (issue #38). Reused at the createProviderClient call below.
  const primaryProxy = resolveProviderProxy(first, accountSettings);
  const timeoutMs = config.runtime.request_timeout_ms;
  const primaryCred = buildCredential(first, oauthCtx, primaryProxy, timeoutMs);
  // HELM_PROVIDER_BASE_URL (test/e2e) overrides EVERY provider's base_url so the
  // mock upstream serves all of them; otherwise each provider uses its own.
  const baseUrlOverride = process.env.HELM_PROVIDER_BASE_URL;
  const fallbackBaseUrl = baseUrlOverride ?? "https://api.openai.com/v1";
  const baseUrl = baseUrlOverride ?? first.base_url ?? fallbackBaseUrl;

  // Bound subscriptions become routable providers (issue #38, Stage 3). For each
  // routable subscription NOT declared in providers.yaml, synthesize a provider
  // exposing the UNION of its schedulable accounts' enabled models, backed by a
  // POOL client that round-robins across those accounts (priority asc, then LRU).
  // Built HERE (after fallbackBaseUrl/timeoutMs) so each per-account client is
  // wired with the same base/timeout + its own proxy. The pool clients override any
  // single-name client for the same providerId in providerClients below.
  const synthBaseUrl = baseUrlOverride ?? fallbackBaseUrl;

  // ── OAuth account auto-park (usage limit) ──────────────────────────────────────
  // Live handle to the CURRENT OAuth pool clients (empty until synthesized below;
  // reassigned on every rebuild). The park/reset closures read it so a usage-limit
  // flip targets the live members IN PLACE — no pool rebuild on a single 429.
  let oauthPoolClients: Map<string, OAuthPoolClient> = new Map();

  // Read persisted quota snapshots (oauth_quota) keyed `${providerId} ${account}`.
  // Cooldowns seed hard scheduling; windows/capturedAt seed quota-aware strategies.
  // Fail-open to empty — a read error just means every member starts un-parked and
  // quota-aware strategies fall back to balanced behavior.
  const readQuotaSeeds = async (): Promise<Map<string, OAuthQuotaSeed>> => {
    const seeds = new Map<string, OAuthQuotaSeed>();
    try {
      for (const snap of await store.oauthQuota.getAll()) {
        seeds.set(`${snap.providerId} ${snap.account}`, {
          windows:
            snap.providerId === "openai-codex"
              ? filterRetiredOpenAICodexLimits(snap.windows)
              : snap.windows,
          capturedAt: snap.capturedAt,
          usageLimitedUntilMs: snap.usageLimitedUntilMs ?? null,
          resetCredits: snap.resetCredits ?? null,
        });
      }
    } catch {
      /* fail-open: no seeds */
    }
    return seeds;
  };

  // Apply (untilMs) / clear (null) an account's cooldown to BOTH the live pool member
  // (in place) and the persisted snapshot. Awaitable for the admin reset path.
  const applyUsageLimit = async (
    providerId: string,
    account: string,
    untilMs: number | null,
    mode: "extend" | "replace" = "extend",
  ): Promise<void> => {
    const pool = oauthPoolClients.get(providerId);
    // A park (non-null) is EXTEND-ONLY: a precise quota reset (e.g. a Codex weekly limit,
    // captured from headers before the 429) must not be pulled back in by the generic 60s
    // 429 fallback, whichever park fires last. null = clear (admin "Reset usage" / weekly
    // auto-reset) always wins. The live member holds the authoritative cooldown — max it.
    let effective = untilMs;
    if (untilMs !== null && mode === "extend") {
      const current = pool?.getUsageLimit(account) ?? null;
      if (current !== null && current > untilMs) effective = current;
    }
    pool?.setUsageLimit(account, effective);
    await store.oauthQuota.setUsageLimit(providerId, account, effective);
  };

  // Fire-and-forget park (detection hot path): never blocks / fails a served request.
  const parkAccountOnLimit = (providerId: string, account: string, untilMs: number): void => {
    backgroundTasks.run(
      () => applyUsageLimit(providerId, account, untilMs),
      (e) =>
        logger.log("error", "oauth.usage_limit.park_failed", {
          provider_id: providerId,
          line: e instanceof Error ? e.message : String(e),
        }),
    );
  };
  const markOAuthCredentialFailure = async (
    providerId: string,
    account: string,
    reason: string,
  ): Promise<void> => {
    if (!oauthCtx) return;
    await markAccountCredentialFailure(store.config, oauthCtx.encKey, providerId, account, {
      at: Date.now(),
      reason,
    });
    await rebuildAfterOAuthCredentialFailure(providerId, account);
  };
  const markOAuthCredentialFailureLater = (
    providerId: string,
    account: string,
    error: unknown,
  ): void => {
    const reason = error instanceof Error ? error.message : "oauth credential failed";
    backgroundTasks.run(
      () => markOAuthCredentialFailure(providerId, account, reason),
      (e) =>
        logger.log("error", "oauth.credential_failure.persist_failed", {
          provider_id: providerId,
          account,
          line: e instanceof Error ? e.message : String(e),
        }),
    );
  };
  // Executor hook: an account-wide 429 on a subscription alias means the SERVED account
  // hit its limit. Resolve the provider from the alias prefix + the served account from
  // the ALS holder (set by the pool's onSelect for THIS attempt), then park it for a
  // short re-probe window. Scoped Anthropic model caps are not account-wide. The precise
  // long cooldown for Codex/Anthropic arrives via the quota-window capture path; this is
  // the backstop (and the ONLY signal for Copilot).
  const onOAuthSubscription429 = (alias: string, error: unknown): void => {
    const acct = servingAccountStore.getStore()?.selected;
    if (!acct) return;
    const slash = alias.indexOf("/");
    const providerId = slash > 0 ? alias.slice(0, slash) : alias;
    const model = slash > 0 ? alias.slice(slash + 1) : null;
    if (acct.providerId !== providerId) return; // stale holder guard (different provider)
    if (resolveOAuthRateLimitScope(providerId, model, error).scope === "model") return;
    parkAccountOnLimit(providerId, acct.account, Date.now() + DEFAULT_429_COOLDOWN_MS);
  };

  // Weekly-limit auto-reset (Codex): when an account opted in (per-account `autoReset`)
  // and its WEEKLY window just saturated, spend ONE rate-limit reset credit to restore
  // it, then unpark.
  //
  // Reset credits are SCARCE and the grant is keyed by the upstream ChatGPT account
  // (chatgpt_account_id), which can back SEVERAL connected helm labels — so the spend
  // guard MUST key on that shared id, not the helm label, or two sibling labels both
  // saturating would each spend a credit for the one shared window. `autoResetInFlight`
  // (keyed by the cheap helm label) only collapses a same-label burst before async
  // work, to avoid a token-read stampede. Fire-and-forget + fail-open: any failure
  // leaves parked state.
  const autoResetInFlight = new Map<string, Promise<boolean>>(); // helm label -> joined evaluation

  // Resolve the SHARED reset-credit key for a Codex helm account from the persisted
  // ChatGPT account identity. Metadata is authoritative because token refresh can leave
  // an opaque/non-JWT access token while retaining the durable accountId discovered at
  // login. Not memoized: reconnect can re-point a label at a different login.
  const resolveCodexAccountKey = async (providerId: string, account: string): Promise<string> => {
    const helmKey = `${providerId} ${account}`;
    if (!oauthEncKey) return helmKey;
    try {
      const rec = await store.oauthTokens.get(providerId, account);
      if (!rec) return helmKey;
      let metadata: Readonly<Record<string, unknown>> = {};
      if (rec.meta !== null) {
        try {
          const parsed: unknown = JSON.parse(rec.meta);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          /* invalid metadata falls through to the token claim */
        }
      }
      return codexResetCreditSharedKey({
        providerId,
        account,
        accessToken: rec.accessEnc === null ? null : decryptSecret(rec.accessEnc, oauthEncKey),
        metadata,
      });
    } catch {
      /* fail-safe: per-label key */
    }
    return helmKey;
  };

  const resetCreditGuard = createResetCreditGuard({
    config: store.config,
    resolveSharedKey: ({ providerId, account }) => resolveCodexAccountKey(providerId, account),
    log: (lvl, msg, fields) => logger.log(lvl, msg, fields),
  });

  const maybeAutoReset = (
    providerId: "openai-codex",
    account: string,
    windows: OAuthQuotaWindow[],
    rateLimitReachedType: CodexRateLimitReachedType | null,
    nowMs: number,
  ): Promise<boolean> => {
    const consumeCodexResetCredit = oauthAdmin?.consumeCodexResetCredit;
    if (!consumeCodexResetCredit || !oauthEncKey) return Promise.resolve(false);
    const helmKey = `${providerId} ${account}`;
    const existing = autoResetInFlight.get(helmKey);
    if (existing) return existing; // collapse + join a same-label burst (cheap, sync)
    const task = (async () => {
      try {
        const s = getAccountSettings(
          await loadAccountSettings(store.config, oauthEncKey),
          providerId,
          account,
        );
        if (!s.autoReset) return false; // opted out → never spend a credit
        const reservation = await resetCreditGuard.reserve({
          providerId,
          account,
          windows,
          mode: "auto",
          rateLimitReachedType,
          nowMs,
        });
        if (!reservation.ok) {
          logger.log(reservation.status === 429 ? "info" : "warn", "oauth.auto_reset.blocked", {
            provider_id: providerId,
            code: reservation.code,
            retry_after_ms: reservation.retryAfterMs ?? null,
          });
          return false;
        }
        const sharedKey = reservation.sharedKey;
        const guardHash = resetCreditGuardHash(sharedKey).slice(0, 12);
        let consumeFailed = false;
        try {
          const attempt = await runResetCreditAttempt({
            reservation,
            consume: async () => {
              try {
                return await consumeCodexResetCredit({
                  account,
                  idempotencyKey: reservation.idempotencyKey,
                });
              } catch (e) {
                consumeFailed = true;
                logger.log("error", "oauth.auto_reset.failed", {
                  provider_id: providerId,
                  account,
                  guard: guardHash,
                  stage: "consume",
                  line: e instanceof Error ? e.message : String(e),
                });
                throw e;
              }
            },
            onConsumed: async (r) => {
              logger.log("info", "oauth.auto_reset.consumed", {
                provider_id: providerId,
                account,
                guard: guardHash,
                redeem_request_id: r.redeemRequestId ?? null,
                code: r.code ?? null,
                windows_reset: r.windowsReset ?? null,
              });
              await onCodexQuotaResetConsumed(
                providerId,
                account,
                windows,
                "auto",
                r.outcome === "reset" ? Date.now() : null,
              );
            },
          });
          if (!attempt.consumed) {
            logger.log("info", "oauth.auto_reset.not_consumed", {
              provider_id: providerId,
              account,
              guard: guardHash,
              redeem_request_id: attempt.result.redeemRequestId ?? null,
              code: attempt.result.code ?? null,
              outcome: attempt.result.outcome,
              windows_reset: attempt.result.windowsReset ?? null,
            });
          }
          return attempt.consumed;
        } catch (e) {
          if (!consumeFailed) {
            logger.log("error", "oauth.auto_reset.failed", {
              provider_id: providerId,
              account,
              guard: guardHash,
              stage: "post_consume",
              line: e instanceof Error ? e.message : String(e),
            });
          }
          return false;
        }
      } catch (e) {
        logger.log("error", "oauth.auto_reset.failed", {
          provider_id: providerId,
          account,
          stage: "post_consume",
          line: e instanceof Error ? e.message : String(e),
        });
        return false;
      } finally {
        autoResetInFlight.delete(helmKey);
      }
    })();
    autoResetInFlight.set(helmKey, task);
    return task;
  };

  const applyQuotaSnapshot = (
    providerId: string,
    account: string,
    windows: OAuthQuotaWindow[],
    capturedAtMs: number,
    resetCredits?: number | null,
  ): void => {
    oauthPoolClients
      .get(providerId)
      ?.setQuotaSnapshot(account, windows, capturedAtMs, resetCredits);
  };

  async function onCodexQuotaResetConsumed(
    providerId: "openai-codex",
    account: string,
    windows: OAuthQuotaWindow[],
    mode: "manual" | "auto",
    occurredAtMs: number | null,
  ): Promise<void> {
    const sharedKey = await resolveCodexAccountKey(providerId, account);
    const connected = (await store.oauthTokens.list().catch(() => [])).filter(
      (token) => token.providerId === providerId,
    );
    const siblings = new Set<string>([account]);
    await Promise.all(
      connected.map(async (token) => {
        if ((await resolveCodexAccountKey(providerId, token.account)) === sharedKey) {
          siblings.add(token.account);
        }
      }),
    );

    const results = await Promise.allSettled(
      [...siblings].map(async (sibling) => {
        const previous = await store.oauthQuota.get(providerId, sibling).catch(() => null);
        if (occurredAtMs !== null) {
          await recordQuotaResetCreditPeriods({
            periodStore: store.oauthResetPeriod,
            providerId,
            account: sibling,
            windows: previous?.windows.length
              ? previous.windows
              : sibling === account
                ? windows
                : [],
            occurredAtMs,
          });
        }
        await applyUsageLimit(providerId, sibling, null).catch(() => {});

        const fresh = await oauthAdmin?.fetchCodexQuota?.({ account: sibling, force: true });
        if (!fresh) return;
        const freshWindows = filterRetiredOpenAICodexLimits(fresh.windows);
        const capturedAt = Date.now();
        await recordObservedQuotaResetPeriods({
          quotaStore: store.oauthQuota,
          periodStore: store.oauthResetPeriod,
          providerId,
          account: sibling,
          windows: freshWindows,
          observedAtMs: capturedAt,
        });
        await store.oauthQuota.upsert({
          providerId,
          account: sibling,
          windows: freshWindows,
          capturedAt,
          source: "codex",
          resetCredits: fresh.resetCredits,
          planType: fresh.planType,
          credits: fresh.credits,
          resetCreditDetails: fresh.resetCreditDetails,
          individualLimit: fresh.individualLimit,
          additionalLimits: filterRetiredOpenAICodexLimits(fresh.additionalLimits),
          rateLimitReachedType: fresh.rateLimitReachedType,
        });
        applyQuotaSnapshot(providerId, sibling, freshWindows, capturedAt, fresh.resetCredits);
      }),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      logger.log("warn", "oauth.reset_credit.post_consume_failed", {
        provider_id: providerId,
        account,
        mode,
        failed_accounts: failed,
      });
    }
  }

  // Every AUTHORITATIVE fresh Codex snapshot must feed the same auto-reset path.
  // Header PUSHes and explicit upstream PULL refreshes are both fresh truth;
  // cache-only admin reads never call this hook. Without the PULL trigger, a 100%
  // snapshot can park the account before another response header arrives, leaving
  // an opted-in account unable to trigger its own reset.
  const onCodexQuotaSaturated = (
    providerId: "openai-codex",
    account: string,
    windows: OAuthQuotaWindow[],
    capturedAtMs: number,
    rateLimitReachedType: CodexRateLimitReachedType | null,
  ): Promise<boolean> =>
    maybeAutoReset(providerId, account, windows, rateLimitReachedType, capturedAtMs);

  // Codex quota-window scrape (providers page Tier 3): parse the `x-codex-*` headers
  // off each Codex reply and snapshot them per account. FAIL-OPEN — a parse/store
  // failure is swallowed (an observability scrape never breaks a served request).
  // At most one persistence worker per account. Header snapshots may arrive much
  // faster than SQLite/Postgres can write; retain only the newest authoritative
  // window instead of one promise closure per served request.
  const quotaObservationInFlight = new Map<string, Promise<void>>();
  const pendingQuotaObservations = new Map<
    string,
    { providerId: string; account: string; windows: OAuthQuotaWindow[]; observedAtMs: number }
  >();
  const captureCodexQuota = (providerId: string, account: string, headers: Headers): void => {
    const nowMs = Date.now();
    const details = parseCodexQuotaHeaderDetails(headers, nowMs);
    const windows = details.windows;
    if (windows.length === 0) return; // no quota headers on this reply → nothing to store
    applyQuotaSnapshot(providerId, account, windows, nowMs);
    const observationKey = `${providerId}\u0000${account}`;
    pendingQuotaObservations.set(observationKey, {
      providerId,
      account,
      windows,
      observedAtMs: nowMs,
    });
    if (!quotaObservationInFlight.has(observationKey)) {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      quotaObservationInFlight.set(observationKey, done);
      const started = backgroundTasks.run(
        async () => {
          try {
            for (;;) {
              const snapshot = pendingQuotaObservations.get(observationKey);
              if (snapshot === undefined) break;
              pendingQuotaObservations.delete(observationKey);
              await recordObservedQuotaResetPeriods({
                quotaStore: store.oauthQuota,
                periodStore: store.oauthResetPeriod,
                providerId: snapshot.providerId,
                account: snapshot.account,
                windows: snapshot.windows,
                observedAtMs: snapshot.observedAtMs,
              });
              await store.oauthQuota.upsert({
                providerId: snapshot.providerId,
                account: snapshot.account,
                windows: snapshot.windows,
                capturedAt: snapshot.observedAtMs,
                source: "codex-headers",
              });
            }
          } finally {
            resolveDone();
            if (quotaObservationInFlight.get(observationKey) === done) {
              quotaObservationInFlight.delete(observationKey);
            }
          }
        },
        () => logger.log("error", "oauth.quota.capture_failed", { provider_id: providerId }),
      );
      if (!started) {
        pendingQuotaObservations.delete(observationKey);
        resolveDone();
        quotaObservationInFlight.delete(observationKey);
      }
    }
    // Auto-park when a window is saturated (≥100% with a future reset): the precise
    // long cooldown the 429 backstop can't know. Fire-and-forget (fail-open).
    const until = windowsToUsageLimit(windows, nowMs);
    if (until !== null) parkAccountOnLimit(providerId, account, until);
    if (weeklySaturated(windows)) {
      backgroundTasks.run(() =>
        onCodexQuotaSaturated(
          "openai-codex",
          account,
          windows,
          nowMs,
          details.rateLimitReachedType,
        ),
      );
    }
  };
  // Per-account user-message serial queue (issue #93, feature B). ONE long-lived
  // gate for the whole process: it must survive pool rebuilds so queued requests
  // and completion stamps are never dropped by an admin save. The config thunk
  // closes over the live `settings` binding — an admin toggle applies to the
  // NEXT acquire with no rebuild.
  const userMsgGate = createKeyedSerialGate();
  const userMessageQueue = {
    gate: userMsgGate,
    getConfig: () => ({
      enabled: settings.user_message_queue_enabled,
      delayMs: settings.user_message_queue_delay_ms,
      timeoutMs: settings.user_message_queue_wait_timeout_ms,
    }),
  };
  const synthesizedOAuth = await synthesizeOAuthProviders(
    config.providers,
    oauthCtx,
    store.config,
    synthBaseUrl,
    timeoutMs,
    (lvl, msg, f) => logger.log(lvl, msg, f),
    captureCodexQuota,
    userMessageQueue,
    await readQuotaSeeds(),
    parkAccountOnLimit,
    markOAuthCredentialFailureLater,
    codexRuntime,
    oauthModelDiscoveryCache,
  );
  const routableProviders: ProviderConfigShared[] = [
    ...config.providers,
    ...synthesizedOAuth.providers,
  ];

  // Chrome-TLS transport startup probe (#306). Any routable provider on
  // transport_profile:tls_chrome (Anthropic preset OAuth under the `auto` default,
  // or explicit) executes through the OPTIONAL wreq-js native transport — and the
  // ones that matter here are usually the SYNTHESIZED OAuth pool providers, not
  // config.providers, so probe the full routable set. If the native binary cannot
  // load, the first Anthropic request throws TlsTransportUnavailableError — counted
  // as a provider failure that trips the breaker and silently degrades to the lane
  // fallback chain. Probe ONCE so the gap is loud at deploy time. Non-fatal
  // (principle 3): the gateway still serves; operators can set
  // transport_profile:default to force the proven undici path.
  const tlsProviders = tlsTransportProviders(routableProviders);
  if (tlsProviders.length > 0) {
    const probe = await checkTlsTransportAvailable({
      browser: process.env.HELM_TLS_BROWSER_PROFILE,
      os: process.env.HELM_TLS_OS_PROFILE,
    });
    if (probe.ok) {
      logger.log("info", "tls_transport.ready", { providers: tlsProviders });
    } else {
      logger.log("warn", "tls_transport.unavailable", {
        providers: tlsProviders,
        error: probe.error,
        hint: "Anthropic OAuth execution will fail over to the lane fallback chain; set transport_profile:default on these providers to force undici, or install a wreq-js build for this platform",
      });
    }
  }

  // The default/primary client (eval + passthrough + back-fill aliases), dispatched
  // by type (anthropic native vs OpenAI-compatible). When the primary is OAuth this
  // SAME dynamic-header client backs the eval/classify path below, so eval auth
  // never silently fails (acceptance criterion 9).
  const provider = primaryCred
    ? createProviderClient(first, { baseUrl, timeoutMs }, primaryCred, primaryProxy)
    : createUnavailableProviderClient(first.name);
  // Per-provider clients keyed by provider NAME. Only the CONFIGURED providers go
  // through buildProviderClients (one static/OAuth client each). When
  // HELM_PROVIDER_BASE_URL is set (test/e2e), force the override so cross-provider
  // candidates still hit the mock; in production each provider keeps its own base_url.
  // CONFIGURED providers (config/providers.yaml) + the primary client. These come
  // from immutable config — NOT editable via the admin UI — so they are built ONCE.
  const configuredClients = buildProviderClients(
    baseUrlOverride
      ? config.providers.map((p) => ({ ...p, base_url: baseUrlOverride }))
      : config.providers,
    fallbackBaseUrl,
    timeoutMs,
    oauthCtx,
    accountSettings,
  );
  // Register the primary only when it has a real credential. Leaving it out makes
  // its configured aliases explicitly unavailable, so lane fallback can continue
  // to another static or connected OAuth provider.
  if (primaryCred) configuredClients.set(first.name, provider);

  // The synthesized OAuth subscription POOL clients (Stage 3): each subscription
  // provider is keyed by its providerId and served by ONE pool that rotates across
  // its bound accounts (priority asc, then LRU). They OVERRIDE any same-named
  // configured client. Unlike configured providers, the pool is HOT-RELOADABLE —
  // proxy / priority / schedulable / connect / disconnect are admin-editable, so it
  // is re-synthesized on demand (rebuildOAuthPool) instead of frozen at startup.
  // `providerClients` is the LIVE merge the per-request `route` closure reads;
  // reassigning it swaps the pool for the NEXT request with no restart and no
  // per-request cost (mirrors the RuleStore re-bind for lanes/policies/classifier).
  // `oauthAliasSet` is the matching LIVE set of currently-exposed (curated)
  // `<provider>/<model>` aliases — execute.ts uses it as the AUTHORITATIVE allow-list
  // for subscription aliases so a de-curated / disconnected model fails closed
  // (provider_unavailable) instead of routing stale via the startup registry or
  // crossing to defaultProvider. The registry is intentionally NOT rebuilt: OAuth
  // aliases bypass it entirely (the prefix is in ROUTABLE_OAUTH_IDS), gated by this
  // set + the live pool.
  const aliasSetOf = (synth: SynthesizedOAuth): Set<string> =>
    new Set(synth.providers.flatMap((p) => p.models.map((m) => m.alias)));
  const wireModelsOf = (synth: SynthesizedOAuth): Map<string, string> =>
    new Map(
      synth.providers.flatMap((provider) =>
        provider.models.map((model) => [model.alias, model.provider_model] as const),
      ),
    );
  // Publish the synthesized pool into the live handle declared above (the park/reset
  // closures read it). Reassigned, not redeclared — same binding the rebuild swaps.
  oauthPoolClients = synthesizedOAuth.poolClients;
  let oauthAliasSet = aliasSetOf(synthesizedOAuth);
  let oauthWireModelMap = wireModelsOf(synthesizedOAuth);
  let xaiOAuthModelMap = synthesizedOAuth.xaiModels;
  let xaiOAuthModelAccounts = synthesizedOAuth.xaiModelAccounts;
  let providerClients = new Map<string, ProviderClient>([
    ...configuredClients,
    ...oauthPoolClients,
  ]);
  // Serialize rebuilds onto a chain so two rapid admin saves can't interleave a stale
  // read with a fresh assign — each link re-reads the CURRENT account settings + bound
  // credentials, re-synthesizes, and swaps the map + alias set. The chain itself never
  // rejects (so it stays alive); each call reports whether ITS rebuild applied, so the
  // admin route can return an honest "saved but not applied" (503) on failure instead
  // of a false 204 (the persisted change still wins on the next rebuild / restart).
  let rebuildChain: Promise<void> = Promise.resolve();
  rebuildOAuthPool = async (): Promise<{ applied: boolean }> => {
    let applied = true;
    rebuildChain = rebuildChain.then(async () => {
      try {
        const next = await synthesizeOAuthProviders(
          config.providers,
          oauthCtx,
          store.config,
          synthBaseUrl,
          timeoutMs,
          (lvl, msg, f) => logger.log(lvl, msg, f),
          captureCodexQuota,
          userMessageQueue, // SAME gate instance — queue state survives rebuilds
          await readQuotaSeeds(), // re-seed cooldowns + quota windows for strategy scoring
          parkAccountOnLimit,
          markOAuthCredentialFailureLater,
          codexRuntime,
          oauthModelDiscoveryCache,
        );
        oauthPoolClients = next.poolClients;
        oauthAliasSet = aliasSetOf(next);
        oauthWireModelMap = wireModelsOf(next);
        xaiOAuthModelMap = next.xaiModels;
        xaiOAuthModelAccounts = next.xaiModelAccounts;
        providerClients = new Map<string, ProviderClient>([
          ...configuredClients,
          ...oauthPoolClients,
        ]);
        codexModelTokenManagers.clear();
        codexModelsEtagTracker.invalidate();
        logger.log("info", "oauth.pool.rebuilt", {
          providers: [...oauthPoolClients.keys()],
        });
      } catch (err) {
        applied = false;
        logger.log("warn", "oauth.pool.rebuild_failed", {
          line: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await rebuildChain;
    return { applied };
  };

  // Routing pipeline building blocks (framework-agnostic core). `let` so admin
  // rule edits (via the runtime RuleStore below) re-bind the live config the
  // `route` closure reads — changes apply without a restart.
  //
  // Lanes/policies come from the Zod-validated config (config/lanes.yaml +
  // config/policies.yaml). config.lanes is undefined only when lanes.yaml is
  // absent; in that case fall back to core's DEFAULT_LANES so the lane
  // abstraction is always present (principle 6, config-as-code principle 2 —
  // an invalid lanes.yaml already failed the load above). policies default to []
  // via the schema, so an absent policies.yaml is a no-op.
  let lanes: LanesConfig = config.lanes ?? parseLanesConfig(DEFAULT_LANES);
  if (!(settings.default_lane in lanes)) {
    throw new Error(
      `invalid runtime.default_lane '${settings.default_lane}': no matching lane is configured`,
    );
  }
  let policies: PoliciesConfig = config.policies;
  // Virtual model aliases (docs/04 compatibility shim): a fixed-model client
  // (Claude CLI, an SDK pinned to a vendor id like "claude-opus-4-8") has its
  // `model` rewritten onto a lane/"auto" before routing, so it no longer 400s.
  // Validate every target against the EFFECTIVE lane set (config.lanes or
  // DEFAULT_LANES) — fail-closed (principle 2) so a typo'd target refuses to boot
  // rather than 400ing per request. Static config (not admin-editable), so it is
  // captured once; an admin lane deletion that orphans an alias degrades to a
  // request-time 400 for that one vendor id, never a crash.
  const modelAliases = config.model_aliases;
  const aliasErrors = validateModelAliasTargets(modelAliases, Object.keys(lanes));
  if (aliasErrors.length > 0) {
    throw new Error(
      `invalid model-aliases.yaml:\n${aliasErrors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  // Live classifier config. `let` so an admin edit (via the runtime RuleStore's
  // onClassifier callback below) re-binds the value the classify adapter reads
  // per request — classifier changes hot-apply WITHOUT a restart (closes the
  // admin.api TODO: "admin classifier edits do not hot-apply"). The adapter rebuilds its eval
  // cache when this value changes, so a verdict from the old config is never served.
  let classifierConfig: ClassifierConfig = config.classifier;
  // Session-momentum soft-state. Instantiated ONCE here (process-wide singleton,
  // NEVER per request) so the Layer-1 classifier's history survives across
  // requests under the same x-session-key (→ metadata.conversation_id). This is
  // the composition-root wiring that makes momentum live: core defines the port +
  // ships this in-memory Map impl, server.ts injects it. Best-effort SOFT STATE
  // (principle 3): a stateless gateway may lose it on restart, which only degrades
  // to "no momentum", never an error; no session key → the engine no-ops. TTL
  // (30 min) + last-5 window are applied at read time from config.classifier.rules
  // .momentum (principle 2: config-driven). Holds only complexity/rawScore/at —
  // never plaintext message content (principle 7).
  const momentumStore = createMemoryMomentumStore();
  // Capability/pricing catalog: the checked-in GENERATED catalog (supply-chain
  // input, never fetched at runtime) merged with the manual capabilities.yaml /
  // pricing.yaml overrides (manual wins per-field). This is what makes the
  // capability filter LIVE: the executor looks up each candidate's resolved
  // providerModel here and prunes known-incompatible candidates (needs_json /
  // needs_vision / needs_tools / context) with explicit skip reasons; a model
  // with NO entry stays fail-open (not over-pruned). It is ALSO the pricing
  // source for cost conversion (cost-wire, docs/07): the executor converts each
  // served attempt's usage → cost_usd, and the classify adapter converts the
  // eval call's usage → eval_usd. An invalid override yaml fails closed
  // (principle 2) — loadRuntimeCatalog throws, the process exits.
  const catalog: Map<string, CatalogEntry> = loadRuntimeCatalog({
    configDir: opts.configDir ?? "./config",
  });
  // Price streamed completions (#6): the executor can't know token usage at
  // stream-peek time, so the chat route parses the trailing usage chunk and asks
  // this to convert it to USD at the served alias's pricing. Routed through
  // resolveCostUsd so an upstream-BILLED cost in that usage chunk (`cost_usd` /
  // OpenRouter `cost`) OVERRIDES the catalog estimate, matching the non-stream
  // path. Null when neither a billed cost nor pricing is available — the record
  // then keeps an honest "not measured" null, never a misleading 0.
  const costOf = (alias: string, usage: { prompt_tokens?: number; completion_tokens?: number }) =>
    resolveCostUsd(catalog.get(alias)?.pricing, { usage });

  // Per-key usage budgets (docs/06). No global on/off — a key with no caps is a
  // zero-touch fast path (the gate reads nothing). `defaultWindowSeconds` (30d)
  // applies only when a key sets a cap but no window; `defaultDegradeLane` is the
  // fallback when a key degrades without naming a target lane. The CHECK is
  // fail-CLOSED (a peek error propagates → 5xx); SETTLE is fail-OPEN (the route
  // swallows store failures). Shared by all four faces: chat reads the gate/settle
  // directly; the three pipeline faces get them via `pipelineBudget`.
  const budgetConfig = { defaultWindowSeconds: 2_592_000, defaultDegradeLane: "economy" };
  const budgetGate = createBudgetGate({ store: store.budget, config: budgetConfig });
  const settleKeyBudget = (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ): Promise<void> =>
    settleBudget({ store: store.budget, config: budgetConfig }, keyId, caps, usage, nowMs);
  // Budget deps the shared messages-pipeline (messages/responses/gemini) consumes:
  // the gate, the settle closure, costOf (to price the streamed usage tail), and a
  // clock. The streamed-cost backfill it does ALSO fills the decision's total_usd
  // on these faces (which previously never settled streamed cost).
  const pipelineBudget = {
    gate: budgetGate,
    settle: settleKeyBudget,
    costOf,
    now: () => Date.now(),
  };
  // Three-layer cascade classify adapter: Layer-1 rules + Layer-2 eval (OFF by
  // default; per-request override threaded from the chat route) + Layer-3
  // balanced fail-open. The eval small-model is invoked via the same provider
  // (eval alias). Reads the CURRENT classifier config per request via the getter.
  // The catalog is injected so the eval call's usage becomes eval_usd (docs/07).
  // Self-HTTP client for internal LLM calls (memory + Layer-2 eval) — built only when
  // routing-through-gateway is on AND the internal key minted. providerPrefix = the
  // primary provider name so a BARE eval model ("deepseek-v4-flash") becomes a routable
  // explicit alias ("deepseek/deepseek-v4-flash"); memory's already-prefixed model is
  // left unchanged. Loopback only (never config.server.host, which may be 0.0.0.0).
  const selfHttpClient =
    internalApiKey !== null
      ? createSelfHttpClient({
          baseUrl: `http://127.0.0.1:${config.server.port}`,
          apiKey: internalApiKey,
          providerPrefix: first.name,
          // Live lane lookup: a configured internal model (memory / eval) may be a LANE
          // name (e.g. "economy") — forward it verbatim so /v1 routes it as an explicit
          // lane instead of mangling it into "${first.name}/economy". Reads the current
          // `lanes` binding so an admin lane edit is reflected without a rebuild.
          isLane: (m) => Object.hasOwn(lanes, m),
        })
      : null;
  const classify = buildClassifyAdapter({
    getClassifierConfig: () => classifierConfig,
    lanes,
    // Live getter so an admin change to the terminal fallback lane keeps the eval
    // cascade's internal lane consistent with the real router (read per resolve).
    defaultLane: () => settings.default_lane,
    // When routing internal LLM calls through the gateway, the eval model goes via the
    // self-HTTP client (visible in /admin/requests); else straight to the primary provider.
    provider: selfHttpClient ?? provider,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level as "info", msg, fields),
    momentum: { store: momentumStore },
    catalog,
  });
  const registry = buildRegistry(
    routableProviders,
    first.name,
    baseUrl,
    first.api_key_env,
    lanes,
    fallbackBaseUrl,
  );
  const resolveMemoryLlmModel = (alias: string): MemoryModelResolution | null => {
    // Observability: route memory LLM calls (summarize/merge/extractFacts) back through
    // helm's own /v1 gateway so they appear in /admin/requests. The task's model `alias`
    // (e.g. "deepseek/deepseek-v4-flash") is forwarded as an EXPLICIT model → the internal
    // key's allow_custom_model passthrough skips classify/eval, so the self-call never nests.
    if (selfHttpClient) {
      return { client: selfHttpClient, providerModel: alias };
    }
    const slash = alias.indexOf("/");
    const prefix = slash > 0 ? alias.slice(0, slash) : "";
    if (prefix && ROUTABLE_OAUTH_IDS.has(prefix)) {
      if (!oauthAliasSet.has(alias)) return null;
      const client = providerClients.get(prefix);
      return client
        ? { client, providerModel: oauthWireModelMap.get(alias) ?? alias.slice(slash + 1) }
        : null;
    }

    const resolved = registry.resolve(alias);
    if (resolved.ok) {
      const client = providerClients.get(resolved.value.providerName);
      return client ? { client, providerModel: resolved.value.providerModel } : null;
    }
    if (prefix && providerClients.has(prefix)) {
      const client = providerClients.get(prefix);
      return client ? { client, providerModel: alias.slice(slash + 1) } : null;
    }
    return { client: provider, providerModel: alias };
  };
  const memoryLlm = createMemoryLlmRuntime({
    config: config.memory.llm,
    resolveModel: resolveMemoryLlmModel,
    estimateTokens: estimateMemoryTokens,
    log: memoryLog,
  });
  // docs/14 — embedder for hybrid recall's vector leg, built from
  // memory.llm.embedding_model (absent ⇒ undefined ⇒ FTS+score). Used by memory_recall
  // (query embedding) and the background embedding job (fact embedding).
  const memoryEmbedder = createMemoryEmbedder({
    embeddingModel: config.memory.llm.embedding_model,
    providers: config.providers,
    timeoutMs: config.memory.llm.timeout_ms,
    responseWorkAdmission: runtimeResponseWorkAdmission(),
  });
  const embeddingModel = config.memory.llm.embedding_model;
  const embeddingDim = config.memory.llm.embedding_dimensions;

  // Observer/Reflector deps (docs/08 Phase 2). The LLM path is opt-in via
  // config.memory.llm and runs ONLY in these background jobs; disabled or failed
  // model calls use the deterministic stubs in memory-llm.ts.
  const observerDeps: ObserverDeps = {
    memoryStore: store.memory,
    summarize: memoryLlm.summarize,
    costSink: () => {},
    // Auto-compaction price resolution: resolve the thread's stamped model alias
    // against the runtime catalog. Unknown aliases fall back to deterministic
    // heuristics inside resolveCompactionPricing.
    resolvePricing: (alias) => resolveCompactionPricing(catalog, alias),
    compaction: config.memory.compaction,
    now: () => new Date(),
    log: memoryLog,
    // Salient-fact fast path (Change A): wire the raw-message eager extractor ONLY
    // when eager_facts is on (which the config gate ties to llm.enabled). Off ⇒ the
    // Observer never eager-extracts (byte-identical to today).
    ...(eagerFactsOn
      ? {
          extractFactsFromMessages: memoryLlm.extractFactsFromMessages,
          maxFactsPerSubject: config.memory.forgetting.consolidate.max_facts_per_subject,
        }
      : {}),
  };
  const reflectorDeps: ReflectorDeps = {
    memoryStore: store.memory,
    merge: memoryLlm.merge,
    costSink: () => {},
    now: () => new Date(),
    log: memoryLog,
    forgetting: forgettingCfg,
    extractFacts: memoryLlm.extractFacts,
    estimateTokens: estimateMemoryTokens,
  };
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 5, cooldownMs: 30_000 },
    now: () => Date.now(),
  });
  const app = createApp({
    logger,
    maintenanceGate: maintenanceActivityGate,
    health: {
      checkReadiness: async () => ({ ready: true, checks: { store: "ok" } }),
      buildInfo: readBuildInfo(),
    },
    limits: {
      requestTimeoutMs: config.runtime.request_timeout_ms,
    },
  });

  // Mandatory auth for the OpenAI chat surface (Hono middleware -> HelmError on
  // failure). Includes LiteLLM-compatible chat aliases; Anthropic /v1/messages
  // self-authenticates so its errors are translated to the Anthropic envelope
  // (docs/07) — see registerMessagesRoute.
  const chatRoutePatterns = [
    "/v1/chat/*",
    "/chat/*",
    "/engines/*",
    "/openai/deployments/*",
  ] as const;
  for (const pattern of chatRoutePatterns) {
    app.use(
      pattern,
      authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
    );
  }
  // Rate limit AFTER auth (needs the resolved key_id) and BEFORE classify/route
  // (cut off cost before classification/eval). No-op when disabled (docs/06).
  for (const pattern of chatRoutePatterns) {
    app.use(
      pattern,
      rateLimitMiddleware({ limiter: rateLimiter, estimateTokens: estimateRequestTokens }),
    );
  }
  // Per-key concurrency overflow queue (issue #93, feature A): AFTER rate-limit
  // (a hard-rejected request must not hold a queue slot), BEFORE classify/route.
  // ONE process-wide gate shared with the self-auth routes (messages / responses
  // / gemini) so a key's in-flight count spans every entrypoint. No-op while
  // concurrency_queue_enabled is OFF or for keys without a concurrency_limit.
  const distributedSemaphore = store.concurrencyLeases
    ? createDistributedKeyedSemaphore({
        store: store.concurrencyLeases,
        ownerId: `${process.env.HOSTNAME ?? "gateway"}:${process.pid}:${randomUUID()}`,
        log: (lvl, msg, fields) => logger.log(lvl, msg, fields),
      })
    : null;
  const concurrencyGate = createConcurrencyGate({
    semaphore:
      distributedSemaphore ??
      createKeyedSemaphore({
        log: (lvl, msg, fields) => logger.log(lvl, msg, fields),
      }),
    getConfig: () => ({
      enabled: settings.concurrency_queue_enabled,
      minSize: settings.concurrency_queue_min_size,
      multiplier: settings.concurrency_queue_size_multiplier,
      waitTimeoutMs: settings.concurrency_queue_wait_timeout_ms,
    }),
  });
  for (const pattern of chatRoutePatterns) {
    app.use(pattern, concurrencyMiddleware(concurrencyGate));
  }

  // Model discovery (GET /v1/models) is key-aware: it requires the SAME mandatory
  // key auth as the chat surface so the listing reflects the authenticated key's
  // caps (allow_custom_model / allowed_lanes). Read-only, so no rate-limit gate.
  app.use(
    "/v1/models",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  app.use(
    "/v1/models/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  registerModelsRoute(app, {
    lanes: () => lanes,
    catalog,
    providerAliases: config.providers.flatMap((p) => p.models.map((m) => m.alias)),
    // Live curated subscription aliases — the SAME hot-reloadable set the executor
    // routes by (rebound on OAuth curation/connect/disconnect), so discovery and
    // routability never disagree.
    oauthAliases: () => oauthAliasSet,
    codexModels: async ({
      clientVersion,
      allowCustomModel,
      allowedLanes,
      blockedModels,
      signal,
    }) => {
      if (!oauthCtx || !codexModelCatalog) return null;
      const versionCatalog = await loadCodexCatalogForClientVersion({
        configured: config.providers,
        oauthCtx,
        config: store.config,
        catalog: codexModelCatalog,
        clientVersion,
        signal,
        tokenManagers: codexModelTokenManagers,
      });
      const versionOAuthAliases = new Set(
        versionCatalog.models.map((model) => `openai-codex/${model}`),
      );
      const models = versionCatalog.models.filter(
        (slug) =>
          resolveCodexCompactModel({
            requestedModel: slug,
            lanes,
            modelAliases,
            oauthAliases: versionOAuthAliases,
            allowCustomModel,
            allowedLanes,
            blockedModels,
          }) !== null,
      );
      return (
        codexModelCatalog?.listRoutable(models, {
          keys: versionCatalog.keys,
        }) ?? null
      );
    },
    onCodexModelsListed: (keyId, clientVersion, etag) => {
      codexModelsEtagTracker.record(keyId, clientVersion, etag);
    },
  });

  // Machine-readable usage stats for API-key owners. Read-only and scoped by the
  // authenticated key id; unlike /admin/api/stats this is not Basic Auth and does
  // not accept a caller-supplied key_id.
  app.use(
    "/v1/usage/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  registerUsageStatsRoute(app, { telemetry });

  // Self-service portal REST (docs/12). Bearer-scoped like /v1/usage — NOT Basic
  // Auth, never accepts a caller-supplied key_id/account_id (every handler
  // write-forces identity). Mounted unconditionally (independent of the admin
  // surface); the SPA shell is mounted separately below.
  app.use(
    "/portal/api/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  // Reverse map wire provider_model -> PUBLIC alias, so the portal usage doughnut
  // shows the lane-visible model name instead of leaking the provider's wire id
  // (原则 6 / R7). Built once from config.providers[].models[]; unmapped → "other".
  const wireToAlias = new Map<string, string>();
  for (const p of config.providers) {
    for (const m of p.models)
      if (!wireToAlias.has(m.provider_model)) wireToAlias.set(m.provider_model, m.alias);
  }
  registerPortalApi(app, {
    keyStore,
    telemetry,
    resolveModelLabel: (wire) => wireToAlias.get(wire) ?? null,
  });

  // Memory MCP server (docs/13): POST /mcp exposes fact/reflection CRUD to
  // external agents, authed by the SAME API key as /v1 (so a tool call is scoped
  // to the key's account + default project — tenant-isolated). Fail-closed: only
  // mounted when memory.mcp.enabled AND the store implements the management
  // surface; otherwise /mcp stays 404. Auth runs BEFORE the route so identity is
  // resolved (mirrors /v1/models).
  if (config.memory.mcp.enabled) {
    if (supportsMemoryAdmin(store.memory)) {
      const mcpOAuth = config.memory.mcp.oauth;
      if (mcpOAuth.enabled) {
        // ChatGPT-style connectors can't send a raw key — front /mcp with an
        // OAuth 2.1 shim (authorize/token + RFC 9728 discovery). Tokens are
        // signed HS256 JWTs keyed off the existing at-rest OAuth secret, so the
        // feature adds NO new secret but REQUIRES one to exist (fail-closed).
        if (!oauthEncKey) {
          throw new Error(
            "memory.mcp.oauth.enabled requires HELM_OAUTH_ENC_KEY (used to sign MCP OAuth tokens): set a 32-byte key (base64 or 64 hex chars)",
          );
        }
        const oauthDeps = {
          keyStore,
          signingKey: deriveMcpSigningKey(oauthEncKey),
          accessTtlSeconds: mcpOAuth.access_token_ttl_seconds,
          issuer: mcpOAuth.issuer,
          allowedRedirectPrefixes: mcpOAuth.allowed_redirect_prefixes,
          now: () => Date.now(),
          log: (line: string) => logger.log("warn", "mcp.oauth", { line }),
        };
        registerMcpOAuth(app, oauthDeps);
        // Accepts EITHER an issued access token OR a raw API key (back-compat).
        app.use("/mcp", mcpAuth(oauthDeps));
      } else {
        app.use(
          "/mcp",
          authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
        );
      }
      registerMcpServer(app, {
        memoryStore: store.memory,
        now: () => new Date(),
        estimateTokens: estimateMemoryTokens,
        runInBackground: backgroundTasks.run,
        log: (line) => logger.log("warn", "mcp", { line }),
        // docs/14 — hybrid recall config for memory_recall. The embedder (vector leg)
        // is wired just below from memory.llm.embedding_model; absent ⇒ FTS+score only.
        scoreConfig: config.memory.forgetting.score,
        recall: {
          enabled: config.memory.forgetting.facts_retrieval.enabled,
          topK: config.memory.forgetting.facts_retrieval.top_k,
        },
        ...(memoryEmbedder !== undefined ? { embedder: memoryEmbedder } : {}),
      });
    } else {
      logger.log("warn", "mcp", {
        line: "memory.mcp.enabled but the store lacks the management surface; /mcp not mounted",
      });
    }
  }

  // The per-request `route`: bind a fresh `execute` to the request's abort
  // signal (client disconnect), then run the framework-agnostic orchestrator.
  // `evalEnabled` is the per-request Layer-2 toggle (default OFF); it is bound
  // into the classify closure here so the orchestrator's `classify(req)` contract
  // stays single-arg and core remains unaware of the eval knob.
  const route = async (
    req: InternalRequest,
    routeOpts: RouteOptions,
    signal: AbortSignal,
    classifyOverrides?: { evalEnabled?: boolean; rulesThreshold?: number },
  ) => {
    // Capture which OAuth subscription served this request: the pool's onSelect
    // fires synchronously inside routeRequest (selection + execute's first-chunk
    // peek), so the ALS holder is populated by the time routeRequest resolves. We
    // then thread the plain value out on the result — token recording in the route's
    // settle path never relies on ALS surviving into Hono's deferred stream callback.
    const { result, servingAccount } = await withServingAccountCapture(() =>
      routeRequest(
        req,
        {
          classify: (r) => classify(r, classifyOverrides),
          policies,
          lanes,
          // Live-binding read of the operator-chosen terminal fallback lane (admin
          // System Settings), SAME pattern as nativeProtocolPassthroughEnabled — an
          // admin change applies on the next request with no restart. The resolver
          // honours it only if the lane exists, else falls back to "balanced".
          defaultLane: settings.default_lane,
          modelAliases,
          execute: createExecute({
            defaultProvider: provider,
            providers: providerClients,
            hasUsableProviders: () => providerClients.size > 0,
            // Subscription aliases are gated authoritatively by the LIVE curation set +
            // pool (fail-closed), bypassing the startup registry — so de-curation /
            // disconnect take effect immediately and never cross provider boundaries.
            knownOAuthPrefixes: ROUTABLE_OAUTH_IDS,
            oauthAliases: () => oauthAliasSet,
            oauthWireModels: () => oauthWireModelMap,
            xaiOAuthModels: () => xaiOAuthModelMap,
            // Native protocol passthrough (issue #217): the OAuth pool aliases never
            // reach the registry, so hand the executor the prefix→wire-protocol map
            // so it knows an Anthropic-subscription alias forwards on the
            // `anthropic_messages` wire (and thus may passthrough a same-protocol body).
            oauthProviderProtocols: ROUTABLE_OAUTH_PROTOCOLS,
            registry,
            breaker,
            catalog,
            now: () => Date.now(),
            signal,
            log: (level, msg, fields) => logger.log(level as "info", msg, fields),
            // Live-binding read of the runtime flag (default OFF), SAME pattern as
            // capturePayloads: () => settings.capture_payloads — an admin toggle
            // applies on the next request with no restart. The messages-pipeline
            // route is the SAME `route` closure as chat.ts, so this one wiring edit
            // covers BOTH the OpenAI chat and Anthropic /v1/messages surfaces.
            nativeProtocolPassthroughEnabled: () => settings.native_protocol_passthrough,
            toolCallXmlRecoveryEnabled: () => settings.tool_call_xml_recovery,
            visualContextCompressionMode: () => settings.visual_context_compression,
            // Auto-park: a genuine 429 on a subscription alias parks the served account
            // so the pool routes around it (account read from the serving-account ALS).
            onOAuthSubscription429,
          }),
          now: () => new Date(),
          log: (record) => logger.log("info", "route.decision", routeDecisionLogFields(record)),
          // Strict explicit-model validation (docs/04): mirrors the executor's
          // resolvability rules so plan-time acceptance == execute-time routability.
          // Reads the LIVE oauthAliasSet/providerClients bindings (reassigned on
          // OAuth curation changes), exactly like the executor's oauthAliases thunk.
          isKnownModel: (alias) => {
            if (oauthAliasSet.has(alias)) return true; // live curated OAuth set
            const slash = alias.indexOf("/");
            const prefix = slash > 0 ? alias.slice(0, slash) : "";
            // Un-curated subscription alias: fail closed (executor would skip it).
            if (prefix && ROUTABLE_OAUTH_IDS.has(prefix)) return false;
            if (registry.resolve(alias).ok) return true; // providers.yaml alias
            // Structural `provider/...` fallback: the named client forwards the bare id.
            if (prefix && providerClients.has(prefix)) return true;
            return false; // bare unknown name: rejected (no Phase-0 silent fallback)
          },
          // Image-generation models (catalog capabilities.outputImage) are model-pinned
          // for ANY key (route-request §0pre), so a native-Gemini image request reaches
          // its provider via native passthrough instead of a `gemini-*flash*` glob.
          isImageModel: (model) => {
            const r = registry.resolve(model);
            if (!r.ok) return false;
            return catalog.get(r.value.alias)?.capabilities.outputImage === true;
          },
          signalFeedback: {
            enabled: config.runtime.signal_feedback.enabled,
            minSamples: config.runtime.signal_feedback.min_samples,
            maxErrorRate: config.runtime.signal_feedback.max_error_rate,
            maxFallbackRate: config.runtime.signal_feedback.max_fallback_rate,
            minSuccessRateDelta: config.runtime.signal_feedback.min_success_rate_delta,
            getSignal: (taskType, lane) => store.signals.getSignal(taskType, lane),
          },
        },
        routeOpts,
      ),
    );
    return Object.assign(result, { servingAccount });
  };

  // Per-account OAuth subscription usage recorder (providers page Tier 2). Called
  // from the route settle paths with the account captured on the result + the served
  // alias + tokens/cost. FAIL-OPEN (principle 3): swallowed + logged, never 5xx's a
  // served request. No-op for a non-OAuth request. `servedByAccount` guards against
  // mis-attribution after a fallback: the pool marks the account at SELECTION time,
  // so a stale OAuth account is dropped unless the FINAL served alias is actually
  // that provider's (`<providerId>/<model>`). `bucketMs` is the UTC-HOUR floor (epoch
  // ms is UTC, so `ms - ms % 3_600_000` floors to the hour) — finer than a day so the
  // providers page can roll usage up by the ADMIN's local day at read time.
  const recordOAuthUsage = (
    servingAccount: ServingAccount | null,
    servedAlias: string | null,
    usage: { tokens: number; costUsd: number | null },
  ): void => {
    if (!servingAccount || !servedByAccount(servingAccount, servedAlias)) return;
    const nowMs = Date.now();
    backgroundTasks.run(
      async () => {
        await quotaObservationInFlight
          .get(`${servingAccount.providerId}\u0000${servingAccount.account}`)
          ?.catch(() => {});
        const resetAt = await store.oauthResetPeriod
          .latestResetAt(servingAccount.providerId, servingAccount.account, nowMs)
          .catch(() => null);
        await store.oauthUsage.record({
          providerId: servingAccount.providerId,
          account: servingAccount.account,
          bucketMs: Math.max(nowMs - (nowMs % 3_600_000), resetAt ?? 0),
          tokens: usage.tokens,
          costUsd: usage.costUsd,
          nowMs,
        });
      },
      () =>
        logger.log("error", "oauth.usage.record_failed", {
          provider_id: servingAccount.providerId,
        }),
    );
  };

  registerChatRoutes(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    route,
    telemetry,
    writes: writeQueue,
    redact: (payload) => redact(payload),
    now: () => Date.now(),
    // SSE keep-alive cadence (runtime.sse_heartbeat_ms / HELM_SSE_HEARTBEAT_MS); 0 = off.
    sseHeartbeatMs: () => config.runtime.sse_heartbeat_ms,
    recordOAuthUsage,
    // Full request/response capture + streamed-cost backfill. The getter reads the
    // LIVE runtime setting so the admin toggle applies without a restart. Payload
    // retention is owned by the scheduled cleanup runner, not the capture path.
    capturePayloads: () => settings.capture_payloads,
    captureSessions: () => settings.capture_sessions,
    captureGeneration: () => captureGeneration,
    costOf,
    // Per-key usage budgets (docs/06): the pre-route gate (degrade/reject) + the
    // post-served settle, threaded from the composition root.
    budgetGate,
    settleBudget: settleKeyBudget,
    responseModelPolicy: first.response_model_policy,
    // e2e-only: allow the `x-helm-eval` header to toggle Layer-2 eval per request
    // so the eval cascade can be black-boxed without a config reload. Production
    // leaves HELM_E2E unset → eval stays config-driven (fail-closed, principle 2).
    evalHeaderOverride: process.env.HELM_E2E === "1",
    // Memory observe-phase wiring (docs/08): the process-wide ObserveDeps. The
    // route self-gates on the resolved x-memory-mode (off = pure no-op).
    memory: { observe, inject },
  });

  // Anthropic Messages route (/v1/messages). It reuses the SAME routing core via
  // `route`, behind a pipeline adapter that bridges IR ↔ the OpenAI executor and
  // produces the native Anthropic response / SSE events (docs/05). Self-auth so a
  // missing key is rejected as an Anthropic error envelope (docs/07).
  // Admin API (/admin/api/*) behind the signed browser session or pre-emptive HTTP
  // Basic (admin.auth). DELIBERATELY separate
  // from API-key auth (different credential source, no RBAC). Rule edits go through
  // a runtime RuleStore that re-binds the live `lanes`/`policies` the router reads;
  // keys/requests go to the Store. The plaintext of a freshly minted key is the
  // ONLY secret ever returned, once (Principle 7).
  const adminAuth = resolveAdminAuth(config as { admin?: Record<string, unknown> }, process.env);
  warnIfAdminUnconfigured(adminAuth, (line) => logger.log("warn", "admin.auth", { line }));
  // SECURITY: only mount the admin surface (API + SPA) when admin is enabled — i.e.
  // when credentials are configured (auto-enable) or HELM_ADMIN_ENABLED is set.
  // Otherwise it is NOT mounted at all (/admin and /admin/api → 404), so the
  // key-management + telemetry endpoints can never be reached unauthenticated.
  if (adminAuth.enabled) {
    // Register the standalone login/logout routes before the protected catch-alls.
    // The full Admin SPA bundle stays private until authentication succeeds.
    app.route("/admin", mountAdminLogin(adminAuth));
    // Rule edits write back to the canonical config/*.yaml FIRST (comment-
    // preserving, atomic, fail-closed — see yaml-writeback.ts), THEN rebind the
    // live config. A failed write 500s with nothing changed, so the file always
    // equals the running config and a restart re-loads exactly what was saved.
    const yamlPersister = createYamlRulePersister(opts.configDir ?? "./config");
    const ruleStore = createRuntimeRuleStore({
      lanes: lanes as Record<string, Lane>,
      policies,
      classifier: classifierConfig,
      persistLanes: yamlPersister.persistLanes,
      persistPolicies: yamlPersister.persistPolicies,
      persistClassifier: yamlPersister.persistClassifier,
      onLanes: (next) => {
        lanes = next as LanesConfig;
      },
      onPolicies: (next) => {
        policies = next;
      },
      // Re-bind the live classifier config so the classify adapter (which reads it
      // per request) observes the admin edit on the very next classification — no
      // restart, no stale eval verdict (the adapter drops its cache on change).
      onClassifier: (next) => {
        classifierConfig = next;
      },
    });
    app.use("/admin/api/*", basicAuth(adminAuth, { allowSession: true }));
    // Routable model catalog for the Lanes admin combobox: each alias + the
    // subscription account(s) exposing it (so the picker can show the account under
    // each model). CONFIGURED-provider aliases are static (config is immutable) and
    // carry no account; the OAuth-subscription options are computed LIVE per read
    // (effectiveOAuthModelOptions) so a Manage-dialog curation edit is reflected here
    // WITHOUT a restart — one source of truth shared with the structural router
    // (execute.ts). Network-free; deduped by alias, sorted.
    const configuredAliases = config.providers.flatMap((p) => p.models.map((m) => m.alias));
    const modelAliases = async (): Promise<ModelOption[]> => {
      const oauthOptions = oauthCtx
        ? await effectiveOAuthModelOptions(oauthCtx, store.config, ROUTABLE_OAUTH_IDS, {
            codexCatalog: codexModelCatalog,
            codexClientVersion,
            modelDiscoveryCache: oauthModelDiscoveryCache,
            xaiRuntimeModelOptions: () =>
              [...xaiOAuthModelAccounts.entries()].map(([alias, accounts]) => ({
                alias,
                accounts,
              })),
          })
        : [];
      const byAlias = new Map<string, ModelOption>();
      for (const alias of configuredAliases) byAlias.set(alias, { alias, accounts: [] });
      // OAuth options win on a clash (they carry the exposing accounts).
      for (const opt of oauthOptions) byAlias.set(opt.alias, opt);
      return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
    };
    // Per-account connectivity tester for the providers page "Test" button. Builds a
    // FRESH, isolated client per test (its own token + CURRENT proxy + executor type)
    // via buildOAuthAccountClient — the same binding synthesis uses — so a test is
    // faithful to production yet records no telemetry and never perturbs the routing
    // pool. Account settings are reloaded per call so a just-saved proxy edit applies
    // without a restart. Present only when OAuth is configured (mirrors `oauth`).
    let oauthTester: OAuthTester | undefined;
    if (oauthCtx) {
      const ctx = oauthCtx;
      oauthTester = createOAuthAccountTester({
        buildClient: async (providerId, account) => {
          const acctSettings = await loadAccountSettings(store.config, ctx.encKey);
          const proxy = resolveProviderProxy(
            { oauth: { provider: providerId, account } } as unknown as ProviderConfigShared,
            acctSettings,
          );
          const fastMode = getAccountSettings(acctSettings, providerId, account).fastMode === true;
          return buildOAuthAccountClient(providerId, account, ctx, proxy, fastMode, {
            baseUrl: synthBaseUrl,
            timeoutMs,
          });
        },
      });
    }
    registerAdminApi(app, {
      rules: ruleStore,
      keyStore,
      telemetry,
      responseWorkAdmission: runtimeResponseWorkAdmission(),
      runInBackground: backgroundTasks.run,
      // Data cleanup / retention / archival surface (admin "Data cleanup").
      cleanup: {
        runNow: () => runCleanupPassNow("manual"),
        lastReport: () => readLastCleanupReport(store.config),
        vacuum: runVacuumNow,
        listArchives: archiveFs.listArchives,
        resolveArchive: archiveFs.resolveArchive,
      },
      // Memory management (docs/13): the admin "Memory" page reads/edits/deletes
      // facts + reflections through store.memory. estimateTokens recomputes a
      // reflection's token_estimate on an in-place edit (same chars/4 heuristic).
      memoryStore: store.memory,
      estimateTokens: estimateMemoryTokens,
      // Admin "Retry" replay (isolated debug re-run). Reuses the SAME core `route`
      // + redactor + streamed-cost pricer + capture getters as the chat route, so a
      // re-issued request routes faithfully; a fresh UUID mints the new trace id.
      replay: {
        route,
        redact: (payload) => redact(payload),
        now: () => Date.now(),
        genTraceId: () => randomUUID(),
        capturePayloads: () => settings.capture_payloads,
        costOf,
      },
      modelAliases,
      genKey: () => {
        const k = generateKey();
        return { plaintext: k.plaintext, hash: k.hash, prefix: k.prefix };
      },
      genKeyId: () => randomUUID(),
      keySecrets: oauthEncKey
        ? {
            encrypt: (plaintext) => encryptSecret(plaintext, oauthEncKey),
            decrypt: (blob) => decryptSecret(blob, oauthEncKey),
          }
        : undefined,
      accountId: "default",
      // System Settings: read the live value; on save, validate+persist to the
      // config_kv store then apply live (logger level, rate-limit switch). The
      // route layer (admin/settings.ts) validates against RuntimeSettingsSchema.
      settings: {
        get: () => settings,
        save: async (next) => {
          const saved = await saveRuntimeSettings(store.config, next);
          applySettings(saved);
          return saved;
        },
      },
      // Admin OAuth-login surface (issue #38). Present only when an enc key is
      // configured (oauthCtx); otherwise the /admin/api/oauth routes 503 — login
      // is disabled rather than storing tokens in plaintext (principle 7).
      // Built once near oauthCtx above (shared with the auto-reset quota hook). The
      // (fail-open) quota PULL failures surface in the JSON log — a silently-swallowed
      // parse failure once froze a providers-page snapshot for ~a day with no evidence.
      oauth: oauthAdmin,
      // Per-account OAuth subscription observability stores (providers page): today's
      // usage aggregate (Tier 2) + latest quota window snapshot (Tier 3). Read by the
      // /oauth/usage + /oauth/quota admin routes (fail-open to empty when absent).
      oauthUsage: store.oauthUsage,
      oauthQuota: store.oauthQuota,
      // Append-only reset-period boundaries; refreshQuota records them, and the
      // /oauth/usage/periods read slices history on the real ones where present.
      oauthResetPeriod: store.oauthResetPeriod,
      resetCreditGuard,
      // Per-account connectivity tester (providers page "Test" button); see above.
      oauthTester,
      // Hot-reload the routable OAuth pool after any admin mutation (proxy /
      // priority / schedulable / curation / connect / disconnect) so it applies on
      // the next request without a restart.
      onOAuthMutation: rebuildOAuthPool,
      // Auto-park control: the "Reset usage" route clears a cooldown (null) and the
      // /quota PULL parks a saturated account — both flip the live member in place +
      // persist, no rebuild. Never touches schedulable.
      applyUsageLimit,
      applyQuotaSnapshot,
      onCodexQuotaSaturated,
      onCodexQuotaResetConsumed,
      onOAuthCredentialFailure: markOAuthCredentialFailure,
    });

    // Admin SPA static hosting (/admin). MUST be mounted AFTER registerAdminApi so
    // the more-specific /admin/api/* routes win (Hono matches in registration
    // order); the static catch-all would otherwise return index.html for them. The
    // sub-app accepts signed sessions or pre-emptive Basic so the page + assets are
    // still gated. We never run
    // SvelteKit here — just serve the adapter-static build (CLAUDE.md Principle 1).
    if (!existsSync(ADMIN_BUILD_ROOT)) {
      logger.log("warn", "admin.static_missing", {
        dir: ADMIN_BUILD_ROOT,
        line: `admin SPA build not found at ${ADMIN_BUILD_ROOT}; /admin will 404 until 'pnpm build' produces it`,
      });
    }
    app.route("/admin", mountAdminStatic(adminAuth));
  } else {
    logger.log("info", "admin.disabled", {
      line: "admin surface not mounted (no credentials / not enabled); set HELM_ADMIN_USER + HELM_ADMIN_PASSWORD to enable",
    });
  }

  // Self-service portal SPA static hosting (/portal, docs/12). UNCONDITIONAL and
  // independent of the admin surface: the shell is public (no Basic Auth); auth
  // happens per-request when the SPA calls /portal/api/* with a Bearer key. MUST be
  // mounted AFTER registerPortalApi so /portal/api/* wins (Hono registration order).
  // A strong CSP is applied in the sub-app (sessionStorage key → XSS is the threat).
  if (!existsSync(PORTAL_BUILD_ROOT)) {
    logger.log("warn", "portal.static_missing", {
      dir: PORTAL_BUILD_ROOT,
      line: `portal SPA build not found at ${PORTAL_BUILD_ROOT}; /portal will 404 until 'pnpm build' produces it`,
    });
  }
  app.route("/portal", mountPortalStatic());

  // Both Anthropic /v1/messages and OpenAI /v1/responses share this pipeline
  // shape; each gets the SAME observe deps so memory observe fires on every
  // surface (the pipeline self-gates on the scope it reads off ir.metadata).
  const messagesPipeline = createMessagesPipeline(
    route,
    "anthropic_messages",
    { observe, inject },
    pipelineBudget,
    recordOAuthUsage,
    writeQueue,
    { toolCallXmlRecoveryEnabled: () => settings.tool_call_xml_recovery },
  );
  const anthropicCountClient = (): ProviderClient | null => {
    for (const client of providerClients.values()) {
      if (
        client.nativeProtocolProfile === "anthropic_messages" &&
        typeof client.countTokens === "function"
      ) {
        return client;
      }
    }
    return null;
  };
  const anthropicCountProvider = anthropicCountClient();
  // Inject the SAME per-key limiter instance the chat surface uses so the
  // Anthropic /v1/messages handler can meter per-key AFTER its self-auth (closes
  // the rate-limit bypass on /v1/messages + /v1/responses). The Wave2 handlers
  // read `deps.rateLimiter`; the field is not yet on MessagesRouteDeps /
  // ResponsesRouteDeps (those files are owned by Wave2), so the limiter is
  // attached via an intersection cast here. CONTRACT: deps key === `rateLimiter`,
  // shape === RateLimiterPort (limiter.check(probe)). Wave2 adds the field to the
  // interfaces and the cast becomes a no-op at the final gate.
  registerMessagesRoute(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    // See note above: attached via cast until Wave2 adds `rateLimiter` to the deps
    // interface (the cast then becomes a no-op).
    rateLimiter,
    // SAME process-wide gate as the chat middleware (issue #93): a key's
    // in-flight count spans every surface.
    concurrencyGate,
    ...(anthropicCountProvider?.countTokens
      ? {
          countTokens: async (body, _identity, signal) => {
            const client = anthropicCountClient();
            if (!client?.countTokens) throw new Error("Anthropic countTokens provider unavailable");
            return await client.countTokens(body, { signal });
          },
        }
      : {}),
    auth: {
      resolve: async (credential): Promise<MessagesIdentity | null> => {
        if (credential === null) return null;
        const record = await keyStore.getByHash(hashKey(credential));
        if (record === null || record.disabled) return null;
        return {
          keyId: record.key_id,
          keyPrefix: record.prefix,
          accountId: record.account_id,
          orgId: null,
          userId: null,
          role: record.role,
          caps: capsFromRecord(record),
        };
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: (native) => anthropicTransformer.transformRequestOut(native),
        // `collect()` contractually returns an IRResponse; the route hands it back
        // as `unknown`, so narrow at this single boundary.
        transformResponseOut: (ir, options) =>
          anthropicTransformer.transformResponseOut(ir as IRResponse, options),
        // The pipeline already produced Anthropic SSE events; here we only
        // serialize ONE event into its wire event/data pair.
        transformStreamOut: (event) => {
          const ev = event as AnthropicSSEEvent & { type: string };
          return { event: ev.type, data: JSON.stringify(ev) };
        },
        transformErrorOut: (err: RouteError) =>
          makeAnthropicError({
            // Pass the precise error_class straight through. makeAnthropicError /
            // makeHelmError already map all 8 ErrorClass values to the right
            // status + Anthropic type (capability_unsatisfiable → 422,
            // rate_limited → 429, lane_unavailable → 503, …), so the old lossy
            // ternary that collapsed everything but auth/invalid_request into a
            // generic 502 only HID those classes. RouteError.error_class is a
            // plain string, so validate it against the schema; an unrecognized
            // value falls back to upstream_error (502) rather than throwing
            // (fail-open, principle 3).
            error_class: coerceErrorClass(err.error_class),
            message: err.message,
            trace_id: err.trace_id,
          }),
      },
    },
    pipeline: messagesPipeline,
    sseHeartbeatMs: () => config.runtime.sse_heartbeat_ms,
    toolCallXmlRecoveryEnabled: () => settings.tool_call_xml_recovery,
    // Telemetry + payload recorder (the /admin/requests fix): the SAME values the
    // chat route uses, so /v1/messages records served requests like /v1/chat does.
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
    },
  } as Parameters<typeof registerMessagesRoute>[1] & { rateLimiter: RateLimiterPort });

  // OpenAI Responses route (/v1/responses). Reuses the SAME routing core via a
  // pipeline stamped with the openai_responses protocol, and the Responses
  // transformer for IR↔native translation. Streaming (stream:true) emits the
  // native response.* SSE event sequence via the second IR→SSE state machine.
  const responsesPipeline = createMessagesPipeline(
    route,
    "openai_responses",
    { observe, inject },
    pipelineBudget,
    recordOAuthUsage,
    writeQueue,
  );
  const responsesClientWith = (
    method:
      | "responsesRetrieve"
      | "responsesDelete"
      | "responsesCancel"
      | "responsesInputItems"
      | "responsesCompact"
      | "responsesInputTokens",
    providerName?: string | null,
  ): ProviderClient | null => {
    if (providerName !== undefined && providerName !== null) {
      const client = providerClients.get(providerName);
      return client !== undefined && typeof client[method] === "function" ? client : null;
    }
    for (const client of providerClients.values()) {
      if (typeof client[method] === "function") return client;
    }
    return null;
  };
  const responsesRegistry = createResponsesRegistry(store.responsesRegistry, store.config);
  const responsesLifecycleUnsupported = (operation: string): HelmHttpError =>
    new HelmHttpError(
      makeHelmError({
        error_class: "capability_unsatisfiable",
        message: `Responses ${operation} is not supported by the selected provider`,
        trace_id: "responses_lifecycle",
      }),
    );
  const executeCodexCompact = createHotCodexCompactExecutor(
    () => providerClients.get("openai-codex") ?? null,
    () => responsesLifecycleUnsupported("compact"),
  );
  const responsesLifecycle: ResponsesRouteDeps["lifecycle"] = {};
  responsesLifecycle.retrieve = async (responseId, _identity, signal, record) => {
    const client = responsesClientWith("responsesRetrieve", record?.providerName);
    if (!client?.responsesRetrieve) throw responsesLifecycleUnsupported("retrieve");
    return await client.responsesRetrieve(responseId, { signal });
  };
  responsesLifecycle.delete = async (responseId, _identity, signal, record) => {
    const client = responsesClientWith("responsesDelete", record?.providerName);
    if (!client?.responsesDelete) throw responsesLifecycleUnsupported("delete");
    return await client.responsesDelete(responseId, { signal });
  };
  responsesLifecycle.cancel = async (responseId, _identity, signal, record) => {
    const client = responsesClientWith("responsesCancel", record?.providerName);
    if (!client?.responsesCancel) throw responsesLifecycleUnsupported("cancel");
    return await client.responsesCancel(responseId, { signal });
  };
  responsesLifecycle.inputItems = async (responseId, _identity, signal, record) => {
    const client = responsesClientWith("responsesInputItems", record?.providerName);
    if (!client?.responsesInputItems) {
      throw responsesLifecycleUnsupported("input_items");
    }
    return await client.responsesInputItems(responseId, { signal });
  };
  responsesLifecycle.compact = async (body, identity, signal, onResponseMeta, onExecution) => {
    const requestedModel = typeof body.body.model === "string" ? body.body.model : "";
    const providerModel = resolveCodexCompactModel({
      requestedModel,
      lanes,
      modelAliases,
      oauthAliases: oauthAliasSet,
      allowCustomModel: identity.caps?.allowCustomModel === true,
      allowedLanes: identity.caps?.allowedLanes,
      blockedModels: identity.caps?.blockedModels,
    });
    if (providerModel === null) {
      throw new HelmHttpError(
        makeHelmError({
          error_class: "invalid_request",
          message: `Responses compact model '${requestedModel}' is not available to this key`,
          trace_id: "responses_compact",
        }),
      );
    }
    const upstreamBody =
      providerModel === requestedModel
        ? body
        : cloneCarrierWithBody(body, { ...body.body, model: providerModel });
    if (upstreamBody !== body) {
      upstreamBody.mutations.model_rewritten = {
        from: requestedModel || null,
        to: providerModel,
      };
      appendMutationList(upstreamBody.mutations, "body_shims_applied", [
        "codex_compact_model_resolved",
      ]);
    }
    return await runCodexCompactProviderCall({
      execute: (options) => executeCodexCompact(upstreamBody, options),
      signal,
      ...(onResponseMeta ? { onResponseMeta } : {}),
      ...(onExecution ? { onExecution } : {}),
      modelAlias: `openai-codex/${providerModel}`,
      providerModel,
      providerName: "openai-codex",
    });
  };
  if (responsesClientWith("responsesInputTokens")?.responsesInputTokens) {
    responsesLifecycle.inputTokens = async (body, _identity, signal) => {
      const client = responsesClientWith("responsesInputTokens");
      if (!client?.responsesInputTokens) {
        throw new Error("Responses input_tokens provider unavailable");
      }
      return await client.responsesInputTokens(body as Record<string, unknown>, { signal });
    };
  }
  registerResponsesRoute(app, {
    // Same per-key limiter, same cast rationale as the messages route above —
    // closes the rate-limit bypass on /v1/responses.
    rateLimiter,
    concurrencyGate,
    auth: {
      resolve: async (credential): Promise<MessagesIdentity | null> => {
        if (credential === null) return null;
        const record = await keyStore.getByHash(hashKey(credential));
        if (record === null || record.disabled) return null;
        return {
          keyId: record.key_id,
          keyPrefix: record.prefix,
          accountId: record.account_id,
          orgId: null,
          userId: null,
          role: record.role,
          caps: capsFromRecord(record),
        };
      },
    },
    transformer: {
      transformRequestOut: (native) =>
        responsesTransformer.transformRequestOut(native) as { metadata?: Record<string, unknown> },
      transformResponseOut: (ir) => responsesTransformer.transformResponseOut(ir as IRResponse),
      // The pipeline already produced Responses SSE events; here we only serialize
      // ONE event into its wire event/data pair (event = the response.* type).
      transformStreamOut: (event) => {
        const ev = event as ResponsesSSEEvent & { type: string };
        return { event: ev.type, data: JSON.stringify(ev) };
      },
    },
    pipeline: responsesPipeline,
    lifecycle: responsesLifecycle,
    budget: pipelineBudget,
    recordOAuthUsage,
    registry: responsesRegistry,
    sseHeartbeatMs: () => config.runtime.sse_heartbeat_ms,
    modelsEtagForKey: (keyId, clientVersion) =>
      clientVersion === null ? null : codexModelsEtagTracker.forResponse(keyId, clientVersion),
    responsesWebSocketSessionProof,
    memoryAdmission: requestBodyMemoryAdmission,
    // Telemetry + payload recorder (the /admin/requests fix): the SAME values the
    // chat route uses, so /v1/responses records served requests like /v1/chat does.
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
      costOf,
    },
  } as Parameters<typeof registerResponsesRoute>[1] & { rateLimiter: RateLimiterPort });

  // Gemini route (/v1beta/models/{model}:generateContent | :streamGenerateContent).
  // The FOURTH client surface. Reuses the SAME routing core via a pipeline stamped
  // with the `gemini` protocol (so streamIR yields Gemini delta events), and the
  // Gemini transformer for IR↔native translation + the Gemini error envelope. Self-
  // auth (x-goog-api-key preferred, Bearer fallback) so a missing key is rejected as
  // a Gemini error envelope (docs/05, docs/07).
  const geminiPipeline = createMessagesPipeline(
    route,
    "gemini",
    { observe, inject },
    pipelineBudget,
    recordOAuthUsage,
    writeQueue,
  );
  const geminiCountClient = (): ProviderClient | null => {
    for (const client of providerClients.values()) {
      if (client.nativeProtocolProfile === "gemini" && typeof client.countTokens === "function") {
        return client;
      }
    }
    return null;
  };
  const geminiCountProvider = geminiCountClient();
  // Shared identity resolver for the self-authenticating routes (gemini + images):
  // plaintext credential → full MessagesIdentity, or null when missing/invalid.
  const resolveIdentity = async (credential: string | null): Promise<MessagesIdentity | null> => {
    if (credential === null) return null;
    const record = await keyStore.getByHash(hashKey(credential));
    if (record === null || record.disabled) return null;
    return {
      keyId: record.key_id,
      keyPrefix: record.prefix,
      accountId: record.account_id,
      orgId: null,
      userId: null,
      role: record.role,
      caps: capsFromRecord(record),
    };
  };

  const realtimeCallRegistry = createRealtimeCallRegistry();
  const resolveRealtimeTarget = (
    requestedModel: string,
  ): { client: ProviderClient; providerModel: string; alias: string } | null => {
    const bareModel = requestedModel.includes("/")
      ? requestedModel.slice(requestedModel.indexOf("/") + 1)
      : requestedModel;
    if (!(bareModel.startsWith("gpt-realtime") || bareModel.startsWith("gpt-live-"))) return null;

    const oauthAlias = requestedModel.startsWith("openai-codex/")
      ? requestedModel
      : `openai-codex/${bareModel}`;
    const oauthClient = providerClients.get("openai-codex");
    if (oauthClient?.realtimeCall) {
      return {
        client: oauthClient,
        providerModel: oauthWireModelMap.get(oauthAlias) ?? bareModel,
        alias: oauthAlias,
      };
    }

    const staticAlias = requestedModel.startsWith("openai/")
      ? requestedModel
      : `openai/${bareModel}`;
    const resolved = registry.resolve(staticAlias);
    if (!resolved.ok) return null;
    const client = providerClients.get(resolved.value.providerName);
    return client?.realtimeCall
      ? { client, providerModel: resolved.value.providerModel, alias: resolved.value.alias }
      : null;
  };
  registerRealtimeRoutes(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    rateLimiter,
    concurrencyGate,
    registry: realtimeCallRegistry,
    resolve: resolveRealtimeTarget,
    auth: {
      resolve: async (credential) => {
        const identity = await resolveIdentity(credential);
        return identity
          ? {
              keyId: identity.keyId,
              blockedModels: identity.caps?.blockedModels,
              concurrencyLimit: identity.caps?.concurrencyLimit,
              rateLimit: identity.caps?.rateLimit,
            }
          : null;
      },
    },
  });

  registerGeminiRoute(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    rateLimiter,
    concurrencyGate,
    ...(geminiCountProvider?.countTokens
      ? {
          countTokens: async (body, _identity, signal) => {
            const client = geminiCountClient();
            if (!client?.countTokens) throw new Error("Gemini countTokens provider unavailable");
            return await client.countTokens(body, { signal });
          },
        }
      : {}),
    auth: { resolve: resolveIdentity },
    transformer: {
      transformRequestOut: (native) => geminiTransformer.transformRequestOut(native),
      transformResponseOut: (ir) =>
        geminiTransformer.transformResponseOut(ir as IRResponse) as GeminiGenerateContentResponse,
      transformErrorOut: (err: RouteError) =>
        makeGeminiError({
          // Pass the precise error_class straight through; makeGeminiError maps all
          // 8 ErrorClass values to the right status + Google canonical status. A
          // RouteError.error_class is a plain string, so validate it against the
          // schema; an unrecognized value falls back to upstream_error (502) rather
          // than throwing (fail-open, principle 3).
          error_class: coerceErrorClass(err.error_class),
          message: err.message,
          trace_id: err.trace_id,
        }),
    },
    pipeline: geminiPipeline,
    sseHeartbeatMs: () => config.runtime.sse_heartbeat_ms,
    // Telemetry + payload recorder (the /admin/requests fix): the SAME values the
    // chat route uses, so the gemini face records served requests like /v1/chat does.
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
    },
  } as Parameters<typeof registerGeminiRoute>[1] & { rateLimiter: RateLimiterPort });

  // POST /v1/images/generations — the OpenAI Images API surface (gpt-image-*). A
  // model-pinned endpoint that resolves the requested model to a provider whose
  // client implements imageGeneration (OpenAI-compat), forwards verbatim, and
  // records one telemetry row with cost. Bypasses the lane/classify pipeline.
  // Resolve a client-facing model id → provider client + wire model + alias + KIND.
  // SHARED by the OpenAI Images route and the Gemini Interactions route (both
  // model-pinned image surfaces). gemini-protocol providers serve images via
  // generateContent (nativePassthrough); everyone else via the OpenAI Images API.
  // Resolve ONE alias → an image target | {kind:"unavailable"} | null. gemini-protocol
  // providers serve images via generateContent (nativePassthrough); everyone else via
  // the OpenAI Images API. Only catalog `capabilities.outputImage` models qualify (a
  // TEXT gemini alias that merely has nativePassthrough is NOT an image model → null).
  const resolveImageTarget = (model: string): ImageChainTarget | { kind: "unavailable" } | null => {
    const slash = model.indexOf("/");
    const prefix = slash > 0 ? model.slice(0, slash) : "";
    if (prefix && ROUTABLE_OAUTH_IDS.has(prefix)) {
      if (!oauthAliasSet.has(model)) return null;
      if (catalog.get(model)?.capabilities.outputImage !== true) return null;
      const client = providerClients.get(prefix);
      if (!client?.imageGeneration) return { kind: "unavailable" };
      return {
        client,
        providerModel: oauthWireModelMap.get(model) ?? model.slice(slash + 1),
        alias: model,
        kind: "openai",
      };
    }
    const r = registry.resolve(model);
    if (!r.ok) return null; // unknown alias → 404
    if (catalog.get(r.value.alias)?.capabilities.outputImage !== true) return null;
    const kind: "openai" | "gemini" =
      r.value.targetProviderProtocol === "gemini" ? "gemini" : "openai";
    const client = providerClients.get(r.value.providerName);
    // Configured image model but credential/client missing → "unavailable" (503),
    // distinct from an unknown model id (404). An OAuth provider has no api_key_env.
    if (r.value.apiKeyEnv && process.env[r.value.apiKeyEnv] === undefined) {
      return { kind: "unavailable" as const };
    }
    if (client === undefined) return { kind: "unavailable" as const };
    // A provider that implements neither image method isn't an image model → null.
    const method = kind === "gemini" ? client.nativePassthrough : client.imageGeneration;
    if (typeof method !== "function") return null;
    return { client, providerModel: r.value.providerModel, alias: r.value.alias, kind };
  };

  // Resolve a client id (bare image model OR image LANE) → ordered local candidates.
  // A lane expands via expandLaneChain (the SAME flattener routing uses); each member
  // resolves through resolveImageTarget, with non-image / wrong-credential members
  // DROPPED before execution. Breaker-open candidates may also be skipped locally;
  // after any paid provider call begins, image-chain never advances. All-unavailable
  // → 503; nothing resolvable → 404. Shared by both model-pinned image routes; this is
  // keeps the existing 503/404 distinction without permitting paid POST replay.
  const resolveImageChain: ResolveImageChain = (model) => {
    const isLane = Object.hasOwn(lanes, model);
    const aliases = isLane ? expandLaneChain(model, lanes) : [model];
    const targets: ImageChainTarget[] = [];
    let sawUnavailable = false;
    for (const alias of aliases) {
      const t = resolveImageTarget(alias);
      if (t === null) continue; // not an image model → drop (lane hygiene)
      if (!("client" in t)) {
        sawUnavailable = true; // {kind:"unavailable"} → skip, try the next provider
        continue;
      }
      targets.push(t);
    }
    if (targets.length === 0) return { ok: false, status: sawUnavailable ? 503 : 404 };
    return {
      ok: true,
      laneName: isLane ? model : "image",
      candidateChain: targets.map((t) => t.alias),
      targets,
    };
  };

  registerImagesRoute(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    rateLimiter,
    concurrencyGate,
    auth: { resolve: resolveIdentity },
    resolveImageChain,
    breaker,
    costOf: (alias, body) => resolveCostUsd(catalog.get(alias)?.pricing, body),
    isPriced: (alias) => {
      const pricing = catalog.get(alias)?.pricing;
      return pricing?.inputPerMTokUsd != null || pricing?.outputPerMTokUsd != null;
    },
    captureServingAccount: withServingAccountCapture,
    recordOAuthUsage,
    // Per-key usage-budget enforcement — the SAME gate + settle the chat face uses, so
    // image spend is capped (reject) and counted (settle) like every other request.
    budgetGate,
    settleBudget: settleKeyBudget,
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
    },
  });

  const resolveVideoTarget = (model: string): VideoCreateTarget | null => {
    const aliases = Object.hasOwn(lanes, model) ? expandLaneChain(model, lanes) : [model];
    for (const alias of aliases) {
      const slash = alias.indexOf("/");
      const prefix = slash > 0 ? alias.slice(0, slash) : "";
      // Grok Imagine is deliberately subscription-only. Static API-key or generic
      // outputVideo providers must not become an implicit second credential path.
      if (prefix !== "xai" || !oauthAliasSet.has(alias)) continue;
      const providerAlias = alias;
      const providerName = prefix;
      const providerModel = oauthWireModelMap.get(alias) ?? alias.slice(slash + 1);
      if (catalog.get(providerAlias)?.capabilities.outputVideo !== true) continue;
      const client = providerClients.get(providerName);
      if (!client?.videoGeneration) continue;
      const target: VideoCreateTarget = {
        providerAlias,
        providerName,
        providerModel,
        providerAccount: null,
        client: {
          create: async (body, signal, onAccountSelected) => {
            const call = await withServingAccountCapture(
              () =>
                client.videoGeneration?.(body, { signal, onAccountSelected }) ??
                Promise.reject(new Error("video generation unavailable")),
            );
            if (call.servingAccount?.providerId === providerName) {
              target.providerAccount = call.servingAccount.account;
            }
            return call.result;
          },
        },
      };
      return target;
    }
    return null;
  };

  registerVideosRoute(app, {
    auth: { resolve: resolveIdentity },
    registry: responsesRegistry,
    rateLimiter,
    concurrencyGate,
    memoryAdmission: requestBodyMemoryAdmission,
    budgetGate,
    settleBudget: settleKeyBudget,
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
    },
    log: (event, fields) => logger.log("info", event, fields),
    resolver: {
      create: async (body) =>
        typeof body.model === "string" ? resolveVideoTarget(body.model) : null,
      poll: async (record) => {
        if (!record.providerName) return null;
        const client = providerClients.get(record.providerName);
        if (!client?.videoRetrieve) return null;
        return {
          retrieve: (requestId, signal) =>
            client.videoRetrieve?.(requestId, {
              signal,
              ...(record.providerAccount ? { providerAccount: record.providerAccount } : {}),
            }) ?? Promise.reject(new Error("video retrieval unavailable")),
        };
      },
    },
  });

  // POST /v1beta/interactions — Gemini Interactions API image gen (the SDK's
  // client.interactions.create). Same chain resolver + breaker + budget + telemetry as
  // the images route; translates the interactions request ↔ generateContent.
  registerInteractionsRoute(app, {
    memoryAdmission: requestBodyMemoryAdmission,
    rateLimiter,
    concurrencyGate,
    auth: { resolve: resolveIdentity },
    resolveImageChain,
    breaker,
    costOf: (alias, body) => resolveCostUsd(catalog.get(alias)?.pricing, body),
    budgetGate,
    settleBudget: settleKeyBudget,
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
      captureSessions: () => settings.capture_sessions,
      captureGeneration: () => captureGeneration,
    },
  });

  // Start the Agentic Signals background scheduler — the OFF-the-request-path
  // trigger. It periodically asks the collector to aggregate the just-elapsed
  // window. The timer is unref'd (never blocks exit) and fail-open (a tick error
  // is logged, never thrown). DELIBERATELY started here, OUTSIDE every middleware
  // / route registration, so no request ever touches signal code (zero added
  // latency). Disabled when HELM_SIGNALS_DISABLED is set (e.g. unit/e2e runs).
  if (process.env.HELM_SIGNALS_DISABLED !== "1") {
    const intervalMs = Number(process.env.HELM_SIGNALS_INTERVAL_MS ?? 60_000);
    signalScheduler = startSignalScheduler({
      collector: signalCollector,
      intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000,
      now: () => Date.now(),
      shouldRun: resourcePressure.shouldRun,
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });
  }

  // Start the memory background worker — the OFF-the-request-path drainer for the
  // memory_jobs queue (docs/08 Phase 2). It claims a batch each tick and dispatches
  // observer/reflector jobs; each job is fail-open and the tick swallows a single
  // bad job so the timer keeps firing (principle 3). DELIBERATELY started here,
  // outside every route, so no request touches it (zero added latency). Disabled
  // when HELM_MEMORY_WORKER_DISABLED=1 (tests default to OFF); interval is an
  // env tunable (fail-safe default + guard, mirroring the signals scheduler).
  if (process.env.HELM_MEMORY_WORKER_DISABLED !== "1") {
    const intervalRaw = Number(process.env.HELM_MEMORY_WORKER_INTERVAL_MS ?? 60_000);
    const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 60_000;
    const batchRaw = Number(process.env.HELM_MEMORY_WORKER_BATCH_SIZE ?? 50);
    const memoryWorkerBatchSize =
      Number.isFinite(batchRaw) && batchRaw > 0 ? Math.floor(batchRaw) : 50;
    const maxBatchesRaw = Number(process.env.HELM_MEMORY_WORKER_MAX_BATCHES_PER_DRAIN ?? 10);
    const memoryWorkerMaxBatches =
      Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0 ? Math.floor(maxBatchesRaw) : 10;
    const maxDrainRaw = Number(process.env.HELM_MEMORY_WORKER_MAX_DRAIN_MS ?? 30_000);
    const memoryWorkerMaxDrainMs =
      Number.isFinite(maxDrainRaw) && maxDrainRaw > 0 ? Math.floor(maxDrainRaw) : 30_000;
    const concurrencyRaw = Number(process.env.HELM_MEMORY_WORKER_CONCURRENCY ?? 3);
    const memoryWorkerConcurrency =
      Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
        ? Math.min(8, Math.floor(concurrencyRaw))
        : 3;
    // Debounce window for the request-driven wake() (see scheduler MemoryWorkerDeps).
    // Default 8s: a paused user's fact forms in ~8s while a burst of turns still
    // coalesces into one observer run. Clamped below the interval (the backstop must
    // remain the slower bound) and to a sane floor.
    const coalesceRaw = Number(process.env.HELM_MEMORY_WORKER_COALESCE_MS ?? 8_000);
    const coalesceMs =
      Number.isFinite(coalesceRaw) && coalesceRaw > 0 && coalesceRaw < intervalMs
        ? coalesceRaw
        : Math.min(8_000, intervalMs);
    memoryWorker = startMemoryWorker({
      memoryStore: store.memory,
      batchSize: memoryWorkerBatchSize,
      concurrency: memoryWorkerConcurrency,
      intervalMs,
      coalesceMs,
      maxBatchesPerDrain: memoryWorkerMaxBatches,
      maxDrainMs: memoryWorkerMaxDrainMs,
      yieldBetweenBatches: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      now: () => Date.now(),
      shouldRun: resourcePressure.shouldRun,
      log: memoryLog,
      runObserver: (job) => runObserverJob(job, observerDeps),
      runReflector: (job) => runReflectorJob(job, reflectorDeps),
      // docs/12 P5: dispatch decay rows to the sweep, and evaluate the buffer-flush
      // trigger each tick. Both are GATED — maybeEnqueueDecayJobs no-ops when
      // forgetting.enabled is false, so with the flag off no decay job is ever enqueued
      // and the worker behaves byte-identically to today.
      runDecay: (job) => runDecayJob(job, decayDeps),
      // docs/14 — dispatch embedding rows to fill the vector index. Wired ONLY when an
      // embedder + dimension are configured (memory.llm.embedding_model/_dimensions);
      // absent ⇒ no embedding rows are enqueued and the vector leg stays empty (recall
      // = FTS+score). Fail-open like every memory job.
      ...(memoryEmbedder !== undefined && embeddingModel !== undefined && embeddingDim !== undefined
        ? {
            runEmbedding: (job: EmbeddingJob) =>
              runEmbeddingJob(job, {
                memoryStore: store.memory,
                embedder: memoryEmbedder,
                model: embeddingModel,
                dim: embeddingDim,
                batchSize: 64,
                log: memoryLog,
              }),
          }
        : {}),
      onTick: async () => {
        await maybeEnqueueDecayJobs({
          memoryStore: store.memory,
          config: forgettingCfg,
          now: () => new Date(),
          log: memoryLog,
        });
        // docs/12 P7: the retention HARD-DELETE — account-agnostic, off the request path,
        // same cadence as the payload_retention_days prune. GATED (no-op with the flag
        // off) and fail-open (errors logged, never thrown), so a delete failure never
        // breaks the worker tick.
        await pruneRetainedMemory({
          memoryStore: store.memory,
          config: forgettingCfg,
          now: () => new Date(),
          log: memoryLog,
        });
        // Idle-flush memory-formation backstop: enqueue idle-flush observer jobs
        // for quiet threads with uncovered history. NOT gated behind forgetting
        // (memory formation is baseline); fail-open inside.
        await maybeEnqueueIdleObserverJobs({
          memoryStore: store.memory,
          now: () => new Date(),
          batchSize: memoryWorkerBatchSize * memoryWorkerMaxBatches,
          compaction: config.memory.compaction,
          log: memoryLog,
        });
      },
    });
    // Bind the late-bound bridge: from now on a memory observe settling in the write
    // queue debounce-wakes this worker (request-driven formation). Before this line it
    // was a no-op, so any observe during boot is covered by the interval backstop.
    wakeMemoryWorker = () => memoryWorker?.wake();
  }

  // Data-cleanup scheduler — the OFF-the-request-path retention/archival sweep
  // (telemetry/payload/memory pruning + archive). DELIBERATELY separate from the 60s
  // memory worker: cleanup is a heavier hour/day-cadence pass. The interval is seeded
  // from settings at boot and rescheduled by applySettings on admin save; the live
  // cleanup_enabled master switch is checked inside the tick, so toggling it off
  // freezes deletion without a restart. fail-open + unref'd.
  // Disabled wholesale by HELM_CLEANUP_DISABLED=1 (tests default to off).
  if (process.env.HELM_CLEANUP_DISABLED !== "1") {
    const hours = settings.cleanup_interval_hours;
    cleanupScheduler = startCleanupScheduler({
      intervalMs: hours * 3_600_000,
      runTick: async () => {
        if (!settings.cleanup_enabled) return; // live master switch
        await maintenanceQueue.run(async () => {
          if (!(await resourcePressure.shouldRunHeavy())) return;
          await executeCleanupPass("scheduled");
        });
      },
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });

    // Auto-VACUUM scheduler — reclaims the on-disk space cleanup's deletes leave on
    // SQLite's freelist (the file never shrinks on its own; auto_vacuum is off). A
    // plain HOURLY tick; the shouldAutoVacuum gate runs it at most once a day, only
    // at the operator's chosen low-traffic local hour, and only when vacuum_enabled
    // is on (default off — VACUUM holds an exclusive lock for the whole rewrite). The
    // live `settings` closure means a toggle/hour change takes effect without a
    // restart. PostgreSQL uses its native autovacuum, so this scheduler is installed
    // only for SQLite. The last successful day is in-memory: failures remain retryable if a
    // later tick is still eligible, while a restart may harmlessly run it once more.
    if (supportsAutomaticVacuum(storeCfg.driver)) {
      const autoVacuum = createAutoVacuumRunner();
      vacuumScheduler = startCleanupScheduler({
        intervalMs: AUTO_VACUUM_CHECK_INTERVAL_MS,
        runTick: async () => {
          await maintenanceQueue.run(async () => {
            if (!(await resourcePressure.shouldRunHeavy())) return;
            await autoVacuum.run(
              () => {
                const now = new Date();
                return {
                  enabled: settings.vacuum_enabled,
                  vacuumHour: settings.vacuum_hour,
                  currentHour: now.getHours(),
                  todayKey: now.toDateString(),
                };
              },
              async () => {
                if (!maintenanceActivityGate.tryPauseIfIdle()) {
                  logger.log("info", "vacuum.auto_skip_busy", { hour: settings.vacuum_hour });
                  return false;
                }
                try {
                  logger.log("info", "vacuum.auto_start", { hour: settings.vacuum_hour });
                  const completed = await executeVacuum({
                    httpAlreadyPaused: true,
                    shouldProceed: resourcePressure.shouldRunHeavy,
                  });
                  if (!completed) return false;
                  logger.log("info", "vacuum.auto_done", {});
                  return true;
                } finally {
                  maintenanceActivityGate.resume();
                }
              },
            );
          });
        },
        log: (level, msg, fields) => logger.log(level, msg, fields),
      });
    }
  }

  const runtimeStats = startRuntimeStatsLogger({
    logger,
    responsesPreflightPending: responsesWebSocketPreflightPending,
    oauthRefreshQueueDepth,
  });

  return {
    app,
    port: config.server.port,
    host: config.server.host,
    responsesWebSocketSessionProof,
    responsesMemoryAdmission: requestBodyMemoryAdmission,
    websocketIngressAdmission,
    realtimeCallRegistry,
    resolveRealtimeKey: async (credential) => (await resolveIdentity(credential))?.keyId ?? null,
    closeResponsesWebSocketSession: async (sessionId) => {
      await Promise.all(
        [...providerClients.values()].map(
          (client) => client.closeResponsesWebSocketSession?.(sessionId) ?? Promise.resolve(),
        ),
      );
    },
    dispose: async () => {
      runtimeStats.stop();
      const signalStopped = signalScheduler?.stop();
      const memoryStopped = memoryWorker?.stop();
      const backgroundStopped = backgroundTasks.closeAndWait();
      cleanupScheduler?.stop();
      vacuumScheduler?.stop();
      await maintenanceQueue.closeAndWait();
      await Promise.all([signalStopped, memoryStopped, backgroundStopped]);
      // Drain the deferred write queue BEFORE closing the DB so a graceful shutdown
      // persists every buffered telemetry/payload/observe write (no loss on deploy).
      await writeQueue.stop();
      await distributedSemaphore?.shutdown();
      // Close the underlying DB connection (sqlite file handle / pg pool). Best
      // effort: a close error must not mask a clean shutdown.
      await store.close().catch(() => {});
    },
  };
}
