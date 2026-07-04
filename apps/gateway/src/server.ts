import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  type BudgetCaps,
  bootstrapRootKey,
  COPILOT_HEADERS,
  type ConfigStore,
  type CreateKeyInput,
  checkTlsTransportAvailable,
  codexAccountIdFromToken,
  createAnthropicClient,
  createBudgetGate,
  createCachedKeyStore,
  createCircuitBreaker,
  createCodexResponsesClient,
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
  type DecayDeps,
  decryptSecret,
  discoverOAuthModels,
  type EmbeddingJob,
  encryptSecret,
  expandLaneChain,
  type GeminiGenerateContentResponse,
  type GeneratedKey,
  geminiTransformer,
  generateKey,
  getGitHubCopilotBaseUrl,
  getOAuthProvider,
  hashKey,
  type InjectDeps,
  type IRResponse,
  isUserMessageRequest,
  type KeyedSerialGate,
  type Lane,
  type LanesConfig,
  LocalVolumeSink,
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
  type OAuthTokenStore,
  type ObserveDeps,
  type ObserverDeps,
  type PoliciesConfig,
  type ProviderClient,
  type ProxyConfig,
  parseCodexQuotaHeaders,
  parseLanesConfig,
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
  responsesTransformer,
  routeRequest,
  runCleanupPass,
  runDecayJob,
  runEmbeddingJob,
  runObserverJob,
  runReflectorJob,
  type StoreSet,
  saveRuntimeSettings,
  settleBudget,
  shouldAutoVacuum,
  startCleanupScheduler,
  startMemoryWorker,
  startSignalScheduler,
  type TransportProfile,
  toRegistryProviders,
  validateModelAliasTargets,
  windowsToUsageLimit,
} from "@helm/core";
import type {
  CatalogEntry,
  ClassifierConfig,
  ErrorClass,
  InternalRequest,
  ProviderConfig as ProviderConfigShared,
  RuntimeSettings,
  TargetProviderProtocol,
} from "@helm/shared";
import {
  ErrorClassSchema,
  effectiveMemoryProjectId,
  isOAuthPreset,
  makeHelmError,
} from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
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
} from "./oauth/account-settings.js";
import { createOAuthAdmin } from "./oauth/admin-oauth.js";
import { cooldownPassed, weeklySaturated } from "./oauth/auto-reset.js";
import { anthropicMetadataUserId, stableSessionId } from "./oauth/device-identity.js";
import { effectiveOAuthModelOptions, type ModelOption } from "./oauth/effective-models.js";
import { createResponsesRegistry } from "./responses-registry.js";
import { createArchiveFsAccess } from "./routes/admin/cleanup-fs.js";
import { registerAdminApi } from "./routes/admin/index.js";
import { createOAuthAccountTester, type OAuthTester } from "./routes/admin/oauth-test.js";
import { createRuntimeRuleStore } from "./routes/admin/rule-store.js";
import { createYamlRulePersister } from "./routes/admin/yaml-writeback.js";
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
import { registerMessagesRoute } from "./routes/messages.js";
import { createMessagesPipeline } from "./routes/messages-pipeline.js";
import { registerModelsRoute } from "./routes/models.js";
import { type ResponsesRouteDeps, registerResponsesRoute } from "./routes/responses.js";
import { registerUsageStatsRoute } from "./routes/usage.js";
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
    };

// Runtime context for PRESET subscription OAuth (issue #38): the persistent
// credential store + the at-rest encryption key. Resolved once at the composition
// root (principle 7) and threaded into buildCredential so the preset token manager
// can read/decrypt the stored credential the admin login wrote.
export interface OAuthRuntimeCtx {
  store: OAuthTokenStore;
  encKey: Buffer;
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

function shouldParkOAuthRateLimit(providerId: string, model: string | null): boolean {
  return !(providerId === "anthropic" && isAnthropicScopedWeeklyModel(model));
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
  const cred = buildCredential(accountConfig, oauthCtx, proxy);
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
  // Persisted auto-park cooldowns keyed `${providerId} ${account}` (from oauth_quota).
  // Each freshly built member is seeded with its cooldown so a parked account stays
  // parked across a restart / pool rebuild until its reset time. Optional — absent in
  // unit tests and when no quota store is wired (every member starts un-parked).
  usageLimitSeeds?: ReadonlyMap<string, number | null>,
  // Pool-local 429 handling can retry a sibling account and hide the failed account
  // from the executor. This hook persists the cooldown the pool already applied in
  // memory, so rebuilds/restarts keep routing around that account.
  onAccountRateLimit?: (providerId: string, account: string, untilMs: number) => void,
): Promise<SynthesizedOAuth> {
  if (!oauthCtx) return { providers: [], poolClients: new Map() };
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
  const providers: ProviderConfigShared[] = [];
  const poolClients = new Map<string, OAuthPoolClient>();

  for (const [providerId, accounts] of accountsByProvider) {
    const spec = ROUTABLE_OAUTH[providerId];
    const provider = getOAuthProvider(providerId);
    if (!spec || !provider) continue;

    // Build a pool member per SCHEDULABLE account (a parked account stays connected
    // but never routes). Accumulate the UNION of enabled models across the members.
    const members: OAuthPoolMember[] = [];
    const unionModels = new Set<string>();
    for (const account of accounts) {
      const s = getAccountSettings(accountSettings, providerId, account);
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
      let accessToken: string;
      try {
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId, account },
          tokenStore: oauthCtx.store,
          encKey: oauthCtx.encKey,
          oauthProvider: provider,
          fetch: proxyFetch,
          now: () => Date.now(),
        });
        accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
      } catch {
        log("warn", "oauth.autoroute.skip", { providerId, account, reason: "refresh failed" });
        continue;
      }
      let discovered: string[];
      try {
        discovered = await discoverOAuthModels(providerId, accessToken, proxyFetch);
      } catch {
        discovered = [];
      }
      // The operator's edited list is AUTHORITATIVE (verbatim) — it may include
      // model ids that discovery missed (stale/incomplete catalogs). Unset ⇒ use
      // the discovered seed. An explicit empty list ⇒ expose nothing.
      if (s.enabledModels) discovered = s.enabledModels;
      if (discovered.length === 0) {
        log("warn", "oauth.autoroute.no_models", { providerId, account });
        continue;
      }
      for (const m of discovered) unionModels.add(m);
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
      );
      if (!client) continue; // unreachable (token just refreshed) — fail-open guard
      // Serialize user-message requests per account (issue #93, feature B). The
      // wrap sits INSIDE the pool member so the gate key is the concrete account
      // the pool selected; non-user turns and a disabled setting pass through.
      const serialized = userMessageQueue
        ? createSerializingClient({
            inner: client,
            gate: userMessageQueue.gate,
            key: `${providerId} ${account}`,
            getConfig: userMessageQueue.getConfig,
            isUserMessage: isUserMessageRequest,
            log: (lvl, msg, fields) => log(lvl, msg, fields),
          })
        : client;
      members.push({
        account,
        priority: s.priority ?? 50,
        schedulable: true,
        client: serialized,
        // Seed the auto-park cooldown from the persisted snapshot (survives restart /
        // rebuild). A past timestamp is harmless — select() treats now>=until as
        // eligible — so stale seeds self-clear.
        usageLimitedUntilMs: usageLimitSeeds?.get(`${providerId} ${account}`) ?? null,
      });
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
      onSelect: (account) => {
        log("info", "oauth.pool.select", { providerId, account });
        // Stamp the per-request holder so the route's settle path can attribute
        // today's usage to THIS subscription (providers page Tier 2). No-op when
        // not inside a capture scope (fail-open; never throws).
        markServingAccount(providerId, account);
      },
      accountRateLimitCooldownMs: DEFAULT_429_COOLDOWN_MS,
      onAccountRateLimit: (account, untilMs) => onAccountRateLimit?.(providerId, account, untilMs),
      shouldParkRateLimit: ({ model }) => shouldParkOAuthRateLimit(providerId, model),
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
      models: [...unionModels].map((m) => ({ alias: `${providerId}/${m}`, provider_model: m })),
      targetProviderProtocol: spec.targetProviderProtocol,
      providerRequiresCompatibilityRewrite: spec.providerRequiresCompatibilityRewrite,
    } as unknown as ProviderConfigShared);
    log("info", "oauth.autoroute", {
      providerId,
      accounts: members.length,
      models: unionModels.size,
    });
  }
  return { providers, poolClients };
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
): ProviderCredential | null {
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
      });
      return {
        getAuthHeader: () => tm.getAuthHeader(),
        onUnauthorized: () => tm.invalidate(),
        currentSecrets: () => tm.currentSecrets(),
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
    });
    return {
      getAuthHeader: () => tm.getAuthHeader(),
      onUnauthorized: () => tm.invalidate(),
      currentSecrets: () => tm.currentSecrets(),
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
    const cred = buildCredential(p, oauthCtx, proxy);
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
    return createCodexResponsesClient({
      config: { ...base, ...cred, sessionId: identity?.sessionId, onResponseMeta, fastMode },
      fetch: providerFetch,
    });
  }
  if (
    p.type === "openai-responses" ||
    p.type === "openai-responses-generic" ||
    p.type === "openai_responses_generic"
  ) {
    return createGenericOpenAIResponsesClient({
      config: { ...base, ...cred },
      fetch: providerFetch,
    });
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
      mapDeveloperRoleToSystem: p.map_developer_role_to_system,
      normalizeReasoningDeltaAlias: p.normalize_reasoning_delta_alias,
    },
    fetch: providerFetch,
  });
}

// Full wiring: config -> store -> bootstrap key -> provider -> routing pipeline.
// Fail-closed: an invalid config throws (caller exits non-zero). The HTTP listen
// is performed by the caller (index.ts) so this stays testable. Async because the
// Store factory may open a remote Postgres (supabase driver); the sqlite default
// resolves synchronously under the await.
export async function buildServer(
  opts: { logger?: Logger; configDir?: string } = {},
): Promise<ServerHandle> {
  const logger = opts.logger ?? createJsonLogger();
  const config = loadConfig({ configDir: opts.configDir ?? "./config" });

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

  // The admin OAuth-login surface, built ONCE here (was inlined into AdminApiDeps
  // below) so the execution-path quota hook can reuse its `consumeCodexResetCredit`
  // for weekly-limit auto-reset. Present only when an enc key is wired (oauthCtx).
  const oauthAdmin = oauthCtx
    ? createOAuthAdmin({
        store: oauthCtx.store,
        encKey: oauthCtx.encKey,
        config: store.config,
        log: (lvl, msg, fields) => logger.log(lvl, msg, fields),
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
  // Apply a new settings object live: re-bind `settings`, push the log level into
  // the logger, flip the rate-limit master switch, and retune the system-default
  // quota. Cleanup cadence is also rescheduled live so the admin setting is not
  // restart-only. Called by the admin settings route after it validates + persists.
  const applySettings = (next: RuntimeSettings): void => {
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
  const runCleanupPassNow = (trigger: "scheduled" | "manual") =>
    runCleanupPass({
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
  // (providers[0]) backs the default/eval path and the Phase-0 passthrough; its
  // credential is mandatory (fail-closed). Additional providers each get their own
  // OpenAI-compatible client so a fallback chain can CROSS providers. Credentials
  // come ONLY from the env var each api_key_env names (principle 7). The e2e/test
  // harness points every provider at the mock via HELM_PROVIDER_BASE_URL (used as
  // the shared fallback base_url when a provider omits one).
  const first = config.providers[0];
  if (!first) throw new Error("no provider configured");
  // Primary credential is MANDATORY (fail-closed, principle 2): it backs the
  // default/eval/passthrough path. Static key OR OAuth — buildCredential returns
  // null only when a required secret env is unset, which is fatal for the primary.
  // Resolve the primary's egress proxy ONCE and thread it into BOTH the credential
  // (so token refresh tunnels through it) and the client (so chat execution does) —
  // a preset-OAuth primary must not leak the real IP on the eval/default/401 path
  // (issue #38). Reused at the createProviderClient call below.
  const primaryProxy = resolveProviderProxy(first, accountSettings);
  const primaryCred = buildCredential(first, oauthCtx, primaryProxy);
  if (!primaryCred) {
    throw new Error(`missing provider credential for primary provider ${first.name}`);
  }
  // HELM_PROVIDER_BASE_URL (test/e2e) overrides EVERY provider's base_url so the
  // mock upstream serves all of them; otherwise each provider uses its own.
  const baseUrlOverride = process.env.HELM_PROVIDER_BASE_URL;
  const fallbackBaseUrl = baseUrlOverride ?? "https://api.openai.com/v1";
  const baseUrl = baseUrlOverride ?? first.base_url ?? fallbackBaseUrl;
  const timeoutMs = config.runtime.request_timeout_ms;

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

  // Read the persisted cooldowns (oauth_quota) keyed `${providerId} ${account}` so a
  // freshly (re)synthesized member is seeded with its cooldown (survives restart /
  // rebuild). Fail-open to empty — a read error just means every member starts un-parked.
  const readUsageLimitSeeds = async (): Promise<Map<string, number | null>> => {
    const seeds = new Map<string, number | null>();
    try {
      for (const snap of await store.oauthQuota.getAll()) {
        seeds.set(`${snap.providerId} ${snap.account}`, snap.usageLimitedUntilMs ?? null);
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
    void applyUsageLimit(providerId, account, untilMs).catch((e) =>
      logger.log("error", "oauth.usage_limit.park_failed", {
        provider_id: providerId,
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
  const onOAuthSubscription429 = (alias: string): void => {
    const acct = servingAccountStore.getStore()?.selected;
    if (!acct) return;
    const slash = alias.indexOf("/");
    const providerId = slash > 0 ? alias.slice(0, slash) : alias;
    const model = slash > 0 ? alias.slice(slash + 1) : null;
    if (acct.providerId !== providerId) return; // stale holder guard (different provider)
    if (!shouldParkOAuthRateLimit(providerId, model)) return;
    parkAccountOnLimit(providerId, acct.account, Date.now() + DEFAULT_429_COOLDOWN_MS);
  };

  // Weekly-limit auto-reset (Codex): when an account opted in (per-account `autoReset`)
  // and its WEEKLY window just saturated, spend ONE rate-limit reset credit to restore
  // it, then unpark.
  //
  // Reset credits are SCARCE and the grant is keyed by the upstream ChatGPT account
  // (chatgpt_account_id), which can back SEVERAL connected helm labels — so the spend
  // guard MUST key on that shared id, not the helm label, or two sibling labels both
  // saturating would each spend a credit for the one shared window. `autoResetLast`
  // (the ≥1h cooldown, keyed by the shared id) is the correctness guard: the check +
  // commit are adjacent and synchronous, so concurrent siblings serialize on it.
  // `autoResetInFlight` (keyed by the cheap helm label) only collapses a same-label
  // burst before the async work, to avoid a token-read stampede. Fire-and-forget +
  // fail-open: any failure (no credit, network, opted-out) leaves the account parked.
  const autoResetLast = new Map<string, number>(); // sharedKey -> last consume epoch-ms
  const autoResetInFlight = new Set<string>(); // helm label -> a reset is being evaluated
  // ponytail: cooldown is process memory — a restart clears it, but a just-reset weekly
  // window cannot re-saturate within an hour, so a second spend is physically impossible
  // before the cooldown would have expired anyway. No persistence needed.

  // Resolve the SHARED reset-credit key for a Codex helm account: its chatgpt_account_id
  // (`codex:<id>`), decoded from the STORED access token — no network/refresh, and the
  // claim is stable even on an expired token. Falls back to the helm label when it can't
  // be resolved (degrades to per-label guarding, never worse). Not memoized: a reconnect
  // could re-point a label at a different login, and this only runs on the rare
  // saturated-and-opted-in path.
  const resolveCodexAccountKey = async (providerId: string, account: string): Promise<string> => {
    const helmKey = `${providerId} ${account}`;
    if (!oauthEncKey) return helmKey;
    try {
      const rec = await store.oauthTokens.get(providerId, account);
      if (rec?.accessEnc) {
        const id = codexAccountIdFromToken(decryptSecret(rec.accessEnc, oauthEncKey));
        if (id) return `codex:${id}`;
      }
    } catch {
      /* fail-safe: per-label key */
    }
    return helmKey;
  };

  const maybeAutoReset = (providerId: string, account: string, nowMs: number): void => {
    if (!oauthAdmin?.consumeCodexResetCredit || !oauthEncKey) return;
    const helmKey = `${providerId} ${account}`;
    if (autoResetInFlight.has(helmKey)) return; // collapse a same-label burst (cheap, sync)
    autoResetInFlight.add(helmKey);
    void (async () => {
      try {
        const s = getAccountSettings(
          await loadAccountSettings(store.config, oauthEncKey),
          providerId,
          account,
        );
        if (!s.autoReset) return; // opted out → never spend a credit
        // Guard on the SHARED ChatGPT account: check + commit are adjacent (no await
        // between), so concurrent sibling labels serialize here and only one spends.
        const sharedKey = await resolveCodexAccountKey(providerId, account);
        if (!cooldownPassed(autoResetLast.get(sharedKey), nowMs)) return;
        autoResetLast.set(sharedKey, nowMs);
        const r = await oauthAdmin.consumeCodexResetCredit?.({ account });
        // The consume restored the shared window for EVERY sibling on this login — unpark
        // them all (the trigger account included), or a sibling parked by its own
        // saturated reply would stay out of rotation until its window's natural reset.
        const codexAccounts = (await store.oauthTokens.list()).filter(
          (t) => t.providerId === providerId,
        );
        await Promise.all(
          codexAccounts.map(async (t) => {
            if ((await resolveCodexAccountKey(t.providerId, t.account)) === sharedKey) {
              await applyUsageLimit(t.providerId, t.account, null);
            }
          }),
        );
        logger.log("info", "oauth.auto_reset.consumed", {
          provider_id: providerId,
          windows_reset: r?.windowsReset ?? null,
        });
      } catch (e) {
        logger.log("error", "oauth.auto_reset.failed", {
          provider_id: providerId,
          line: e instanceof Error ? e.message : String(e),
        });
      } finally {
        autoResetInFlight.delete(helmKey);
      }
    })();
  };

  // Codex quota-window scrape (providers page Tier 3): parse the `x-codex-*` headers
  // off each Codex reply and snapshot them per account. FAIL-OPEN — a parse/store
  // failure is swallowed (an observability scrape never breaks a served request).
  const captureCodexQuota = (providerId: string, account: string, headers: Headers): void => {
    const nowMs = Date.now();
    const windows = parseCodexQuotaHeaders(headers, nowMs);
    if (windows.length === 0) return; // no quota headers on this reply → nothing to store
    void store.oauthQuota
      .upsert({ providerId, account, windows, capturedAt: nowMs, source: "codex-headers" })
      .catch(() => logger.log("error", "oauth.quota.capture_failed", { provider_id: providerId }));
    // Auto-park when a window is saturated (≥100% with a future reset): the precise
    // long cooldown the 429 backstop can't know. Fire-and-forget (fail-open).
    const until = windowsToUsageLimit(windows, nowMs);
    if (until !== null) parkAccountOnLimit(providerId, account, until);
    // Then, if the WEEKLY window is the one that saturated and the account opted in,
    // auto-consume a reset credit to restore it (guarded by a ≥1h per-account cooldown).
    if (weeklySaturated(windows)) maybeAutoReset(providerId, account, nowMs);
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
    await readUsageLimitSeeds(),
    parkAccountOnLimit,
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
  const provider = createProviderClient(first, { baseUrl, timeoutMs }, primaryCred, primaryProxy);
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
  // Ensure the primary client is registered under its name (built above with the
  // resolved baseUrl, which already honors the override).
  configuredClients.set(first.name, provider);

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
  // Publish the synthesized pool into the live handle declared above (the park/reset
  // closures read it). Reassigned, not redeclared — same binding the rebuild swaps.
  oauthPoolClients = synthesizedOAuth.poolClients;
  let oauthAliasSet = aliasSetOf(synthesizedOAuth);
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
  const rebuildOAuthPool = async (): Promise<{ applied: boolean }> => {
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
          await readUsageLimitSeeds(), // re-seed cooldowns so a rebuild never un-parks
          parkAccountOnLimit,
        );
        oauthPoolClients = next.poolClients;
        oauthAliasSet = aliasSetOf(next);
        providerClients = new Map<string, ProviderClient>([
          ...configuredClients,
          ...oauthPoolClients,
        ]);
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
      return client ? { client, providerModel: alias.slice(slash + 1) } : null;
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
    health: {
      checkReadiness: async () => ({ ready: true, checks: { store: "ok" } }),
      buildInfo: readBuildInfo(),
    },
    limits: {
      maxBodyBytes: config.runtime.max_request_bytes,
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
  const concurrencyGate = createConcurrencyGate({
    semaphore: createKeyedSemaphore({
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
  });

  // Machine-readable usage stats for API-key owners. Read-only and scoped by the
  // authenticated key id; unlike /admin/api/stats this is not Basic Auth and does
  // not accept a caller-supplied key_id.
  app.use(
    "/v1/usage/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  registerUsageStatsRoute(app, { telemetry });

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
            // Subscription aliases are gated authoritatively by the LIVE curation set +
            // pool (fail-closed), bypassing the startup registry — so de-curation /
            // disconnect take effect immediately and never cross provider boundaries.
            knownOAuthPrefixes: ROUTABLE_OAUTH_IDS,
            oauthAliases: () => oauthAliasSet,
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
            // Auto-park: a genuine 429 on a subscription alias parks the served account
            // so the pool routes around it (account read from the serving-account ALS).
            onOAuthSubscription429,
          }),
          now: () => new Date(),
          log: (record) => logger.log("info", "route.decision", { trace_id: record.request_id }),
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
    void store.oauthUsage
      .record({
        providerId: servingAccount.providerId,
        account: servingAccount.account,
        bucketMs: nowMs - (nowMs % 3_600_000),
        tokens: usage.tokens,
        costUsd: usage.costUsd,
        nowMs,
      })
      .catch(() =>
        logger.log("error", "oauth.usage.record_failed", {
          provider_id: servingAccount.providerId,
        }),
      );
  };

  registerChatRoutes(app, {
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
  // Admin API (/admin/api/*) behind HTTP Basic (admin.auth). DELIBERATELY separate
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
    app.use("/admin/api/*", basicAuth(adminAuth));
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
        ? await effectiveOAuthModelOptions(oauthCtx, store.config, ROUTABLE_OAUTH_IDS)
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
      // Data cleanup / retention / archival surface (admin "Data cleanup").
      cleanup: {
        runNow: () => runCleanupPassNow("manual"),
        lastReport: () => readLastCleanupReport(store.config),
        vacuum: () => store.vacuum(),
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
    });

    // Admin SPA static hosting (/admin). MUST be mounted AFTER registerAdminApi so
    // the more-specific /admin/api/* routes win (Hono matches in registration
    // order); the static catch-all would otherwise return index.html for them. The
    // sub-app re-applies basicAuth so the page + assets are also gated. We never run
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
          caps: {
            allowedLanes: record.allowed_lanes,
            allowCustomModel: record.allow_custom_model,
            allowFastMode: record.allow_fast_mode,
            // Per-key rate-limit override (docs/06): carried so the self-auth
            // /v1/messages + /v1/responses paths enforce per-key limits too, not
            // just the OpenAI chat middleware.
            rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
            // Per-key max in-flight (issue #93): read by the concurrency gate.
            concurrencyLimit: record.concurrency_limit,
            // Per-key usage budgets (docs/06): carried so the pipeline's budget
            // gate/settle enforce on these self-auth faces too.
            budget: {
              requests: record.budget_requests,
              tokens: record.budget_tokens,
              spendUsd: record.budget_spend_usd,
              windowSeconds: record.budget_window_seconds,
              behavior: record.over_budget_behavior,
              degradeLane: record.degrade_lane,
            },
            // Per-key memory defaults (issue #97): read by the route's memory
            // scope resolver; explicit x-memory-* headers always override.
            memory: {
              mode: record.memory_mode,
              // null project => isolate by the key's own id; explicit value SHARES
              // a pool across keys (effectiveMemoryProjectId). Mirrors auth.ts.
              projectId: effectiveMemoryProjectId(record),
              threadSource: record.memory_thread_source,
            },
          },
        };
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: (native) => anthropicTransformer.transformRequestOut(native),
        // `collect()` contractually returns an IRResponse; the route hands it back
        // as `unknown`, so narrow at this single boundary.
        transformResponseOut: (ir) => anthropicTransformer.transformResponseOut(ir as IRResponse),
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
    // Telemetry + payload recorder (the /admin/requests fix): the SAME values the
    // chat route uses, so /v1/messages records served requests like /v1/chat does.
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
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
  const responsesRegistry: ResponsesRouteDeps["registry"] = createResponsesRegistry(store.config);
  const responsesLifecycleUnsupported = (operation: string): HelmHttpError =>
    new HelmHttpError(
      makeHelmError({
        error_class: "capability_unsatisfiable",
        message: `Responses ${operation} is not supported by the selected provider`,
        trace_id: "responses_lifecycle",
      }),
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
  if (responsesClientWith("responsesCompact")?.responsesCompact) {
    responsesLifecycle.compact = async (body, _identity, signal) => {
      const client = responsesClientWith("responsesCompact");
      if (!client?.responsesCompact) throw new Error("Responses compact provider unavailable");
      return await client.responsesCompact(body as Record<string, unknown>, { signal });
    };
  }
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
          caps: {
            allowedLanes: record.allowed_lanes,
            allowCustomModel: record.allow_custom_model,
            allowFastMode: record.allow_fast_mode,
            // Per-key rate-limit override (docs/06): carried so the self-auth
            // /v1/messages + /v1/responses paths enforce per-key limits too, not
            // just the OpenAI chat middleware.
            rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
            // Per-key max in-flight (issue #93): read by the concurrency gate.
            concurrencyLimit: record.concurrency_limit,
            // Per-key usage budgets (docs/06): carried so the pipeline's budget
            // gate/settle enforce on these self-auth faces too.
            budget: {
              requests: record.budget_requests,
              tokens: record.budget_tokens,
              spendUsd: record.budget_spend_usd,
              windowSeconds: record.budget_window_seconds,
              behavior: record.over_budget_behavior,
              degradeLane: record.degrade_lane,
            },
            // Per-key memory defaults (issue #97): read by the route's memory
            // scope resolver; explicit x-memory-* headers always override.
            memory: {
              mode: record.memory_mode,
              // null project => isolate by the key's own id; explicit value SHARES
              // a pool across keys (effectiveMemoryProjectId). Mirrors auth.ts.
              projectId: effectiveMemoryProjectId(record),
              threadSource: record.memory_thread_source,
            },
          },
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
    registry: responsesRegistry,
    sseHeartbeatMs: () => config.runtime.sse_heartbeat_ms,
    // Telemetry + payload recorder (the /admin/requests fix): the SAME values the
    // chat route uses, so /v1/responses records served requests like /v1/chat does.
    record: {
      telemetry,
      writes: writeQueue,
      redact: (payload) => redact(payload),
      now: () => Date.now(),
      capturePayloads: () => settings.capture_payloads,
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
      caps: {
        allowedLanes: record.allowed_lanes,
        allowCustomModel: record.allow_custom_model,
        allowFastMode: record.allow_fast_mode,
        rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
        // Per-key max in-flight (issue #93): read by the concurrency gate.
        concurrencyLimit: record.concurrency_limit,
        budget: {
          requests: record.budget_requests,
          tokens: record.budget_tokens,
          spendUsd: record.budget_spend_usd,
          windowSeconds: record.budget_window_seconds,
          behavior: record.over_budget_behavior,
          degradeLane: record.degrade_lane,
        },
        // Per-key memory defaults (issue #97): read by the route's memory
        // scope resolver; explicit x-memory-* headers always override.
        memory: {
          mode: record.memory_mode,
          // null project => isolate by the key's own id; explicit value SHARES
          // a pool across keys (effectiveMemoryProjectId). Mirrors auth.ts.
          projectId: effectiveMemoryProjectId(record),
          threadSource: record.memory_thread_source,
        },
      },
    };
  };

  registerGeminiRoute(app, {
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

  // Resolve a client id (bare image model OR image LANE) → the ordered provider chain.
  // A lane expands via expandLaneChain (the SAME flattener routing uses); each member
  // resolves through resolveImageTarget, with non-image / wrong-credential members
  // DROPPED (fallback semantics — the chain tries the next provider). All-unavailable
  // → 503; nothing resolvable → 404. Shared by both model-pinned image routes; this is
  // what makes image gen fail over across providers like a text lane (any key).
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
    rateLimiter,
    concurrencyGate,
    auth: { resolve: resolveIdentity },
    resolveImageChain,
    breaker,
    costOf: (alias, body) => resolveCostUsd(catalog.get(alias)?.pricing, body),
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
    },
  });

  // POST /v1beta/interactions — Gemini Interactions API image gen (the SDK's
  // client.interactions.create). Same chain resolver + breaker + budget + telemetry as
  // the images route; translates the interactions request ↔ generateContent.
  registerInteractionsRoute(app, {
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
    },
  });

  // Start the Agentic Signals background scheduler — the OFF-the-request-path
  // trigger. It periodically asks the collector to aggregate the just-elapsed
  // window. The timer is unref'd (never blocks exit) and fail-open (a tick error
  // is logged, never thrown). DELIBERATELY started here, OUTSIDE every middleware
  // / route registration, so no request ever touches signal code (zero added
  // latency). Disabled when HELM_SIGNALS_DISABLED is set (e.g. unit/e2e runs).
  let signalScheduler: { stop: () => void } | null = null;
  if (process.env.HELM_SIGNALS_DISABLED !== "1") {
    const intervalMs = Number(process.env.HELM_SIGNALS_INTERVAL_MS ?? 60_000);
    signalScheduler = startSignalScheduler({
      collector: signalCollector,
      intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000,
      now: () => Date.now(),
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
  let memoryWorker: { stop: () => void; wake: () => void } | null = null;
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
        await runCleanupPassNow("scheduled");
      },
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });

    // Auto-VACUUM scheduler — reclaims the on-disk space cleanup's deletes leave on
    // SQLite's freelist (the file never shrinks on its own; auto_vacuum is off). A
    // plain HOURLY tick; the shouldAutoVacuum gate runs it at most once a day, only
    // at the operator's chosen low-traffic local hour, and only when vacuum_enabled
    // is on (default off — VACUUM holds an exclusive lock for the whole rewrite). The
    // live `settings` closure means a toggle/hour change takes effect without a
    // restart. store.vacuum() is a no-op on postgres (autovacuum), so this is inert
    // there. lastRunDayKey is in-memory: a restart at the vacuum hour may run one
    // extra VACUUM (harmless — it just reclaims nothing the second time).
    let lastVacuumDayKey: string | null = null;
    vacuumScheduler = startCleanupScheduler({
      intervalMs: 3_600_000,
      runTick: async () => {
        const now = new Date();
        const todayKey = now.toDateString();
        if (
          !shouldAutoVacuum({
            enabled: settings.vacuum_enabled,
            vacuumHour: settings.vacuum_hour,
            currentHour: now.getHours(),
            lastRunDayKey: lastVacuumDayKey,
            todayKey,
          })
        ) {
          return;
        }
        lastVacuumDayKey = todayKey; // mark BEFORE the slow rewrite so a retry can't double-run
        logger.log("info", "vacuum.auto_start", { hour: settings.vacuum_hour });
        await store.vacuum();
        logger.log("info", "vacuum.auto_done", {});
      },
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });
  }

  return {
    app,
    port: config.server.port,
    host: config.server.host,
    dispose: async () => {
      signalScheduler?.stop();
      memoryWorker?.stop();
      cleanupScheduler?.stop();
      vacuumScheduler?.stop();
      // Drain the deferred write queue BEFORE closing the DB so a graceful shutdown
      // persists every buffered telemetry/payload/observe write (no loss on deploy).
      await writeQueue.stop();
      // Close the underlying DB connection (sqlite file handle / pg pool). Best
      // effort: a close error must not mask a clean shutdown.
      await store.close().catch(() => {});
    },
  };
}
