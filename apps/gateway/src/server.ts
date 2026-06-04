import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  type BudgetCaps,
  bootstrapRootKey,
  COPILOT_HEADERS,
  type ConfigStore,
  createAnthropicClient,
  createBudgetGate,
  createCircuitBreaker,
  createCodexResponsesClient,
  createMemoryMomentumStore,
  createOAuthPoolClient,
  createOpenAIClient,
  createProviderRegistry,
  createRateLimiter,
  createSignalCollector,
  createStore,
  createTokenManager,
  DEFAULT_LANES,
  discoverOAuthModels,
  type GeminiGenerateContentResponse,
  geminiTransformer,
  generateKey,
  getGitHubCopilotBaseUrl,
  getOAuthProvider,
  hashKey,
  type InjectDeps,
  type IRResponse,
  type Lane,
  type LanesConfig,
  loadConfig,
  loadEncKeyFromEnv,
  loadRuntimeCatalog,
  loadRuntimeSettings,
  makeAnthropicError,
  makeGeminiError,
  makeProxyFetch,
  type OAuthPoolMember,
  type OAuthTokenStore,
  type ObserveDeps,
  type ObserverDeps,
  type PoliciesConfig,
  type ProviderClient,
  type ProxyConfig,
  parseCodexQuotaHeaders,
  parseLanesConfig,
  type ReflectorDeps,
  type ProviderRegistryConfig as RegistryProviderConfig,
  type ResponsesSSEEvent,
  type RouteOptions,
  redact,
  resolveCostUsd,
  responsesTransformer,
  routeRequest,
  runObserverJob,
  runReflectorJob,
  type StoreSet,
  saveRuntimeSettings,
  settleBudget,
  startMemoryWorker,
  startSignalScheduler,
  toRegistryProviders,
} from "@helm/core";
import type {
  CatalogEntry,
  ClassifierConfig,
  ErrorClass,
  InternalRequest,
  Observation,
  ProviderConfig as ProviderConfigShared,
  RawMessage,
  Reflection,
  RuntimeSettings,
} from "@helm/shared";
import { ErrorClassSchema, isOAuthPreset } from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { authMiddleware } from "./middleware/auth.js";
import { basicAuth, resolveAdminAuth, warnIfAdminUnconfigured } from "./middleware/basic-auth.js";
import { estimateRequestTokens } from "./middleware/estimate-tokens.js";
import { type RateLimiterPort, rateLimitMiddleware } from "./middleware/rate-limit.js";
import {
  type AccountSettingsMap,
  getAccountSettings,
  loadAccountSettings,
} from "./oauth/account-settings.js";
import { createOAuthAdmin } from "./oauth/admin-oauth.js";
import { anthropicMetadataUserId, stableSessionId } from "./oauth/device-identity.js";
import { effectiveOAuthModelOptions, type ModelOption } from "./oauth/effective-models.js";
import { registerAdminApi } from "./routes/admin/index.js";
import { createRuntimeRuleStore } from "./routes/admin/rule-store.js";
import { ADMIN_BUILD_ROOT, mountAdminStatic } from "./routes/admin-static.js";
import { registerChatRoutes } from "./routes/chat.js";
import { buildClassifyAdapter } from "./routes/classify.js";
import { createExecute } from "./routes/execute.js";
import { registerGeminiRoute } from "./routes/gemini.js";
import type { MessagesIdentity, RouteError } from "./routes/messages.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { createMessagesPipeline } from "./routes/messages-pipeline.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerResponsesRoute } from "./routes/responses.js";
import {
  markServingAccount,
  type ServingAccount,
  servedByAccount,
  withServingAccountCapture,
} from "./runtime/serving-account.js";

export interface ServerHandle {
  app: ReturnType<typeof createApp>;
  port: number;
  host: string;
  // Stop background workers (e.g. the Agentic Signals scheduler). Optional and
  // safe to skip — the timers are unref'd so they never block process exit.
  dispose?: () => void;
}

// D11 — DETERMINISTIC, non-LLM summarize/merge for the MVP memory background jobs.
// A real LLM path is a follow-up issue; until then these keep reflection text a
// pure function of its inputs so the Reflector only bumps a version on a genuine
// content change (cache-friendly, docs/08 "reflections should be stable and slow-changing").
const MEMORY_SUMMARY_MAX_CHARS = 2000;
const MEMORY_REFLECTION_MAX_CHARS = 4000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Compress a slice of raw messages into one observation: concatenate the turns in
// order (role-tagged), truncated to a cap. Deterministic — same input → same text.
function summarizeMessages(messages: readonly RawMessage[]): string {
  const body = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return truncate(body || "(no messages)", MEMORY_SUMMARY_MAX_CHARS);
}

// Merge a scope's observations (oldest-first) into one reflection text. Existing
// reflection text is NOT re-prepended (it was already derived from earlier
// observations) — we re-derive from the current observation set so the output is a
// stable function of inputs. previousReflection is accepted for signature parity.
function mergeObservations(
  observations: readonly Observation[],
  _previousReflection: Reflection | null,
): string {
  const body = observations.map((o) => `- ${o.observationText}`).join("\n");
  return truncate(body || "(no observations)", MEMORY_REFLECTION_MAX_CHARS);
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
function buildRegistry(
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
    cfgs.push({
      name: primaryName,
      base_url: primaryBaseUrl,
      api_key_env: primaryApiKeyEnv ?? "", // OAuth primary has none; registry never reads it
      models: [...backfill].map((alias) => ({ alias, provider_model: alias })),
    });
  }
  return createProviderRegistry(cfgs);
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
const ROUTABLE_OAUTH: Record<string, { type: string; baseUrl?: string }> = {
  anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com" },
  "github-copilot": { type: "openai" },
  // ChatGPT Codex via the native Responses executor (the endpoint is
  // baseUrl + /responses). No list-models API → hasLiveModelDiscovery stays false
  // (curated list only; the Manage dialog hides "Pull from provider").
  "openai-codex": { type: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
};
// The single gate for "which subscriptions route". Keys of ROUTABLE_OAUTH, reused
// by the live model catalog so it can never offer a model whose executor is unwired.
const ROUTABLE_OAUTH_IDS: ReadonlySet<string> = new Set(Object.keys(ROUTABLE_OAUTH));

// The synthesis result (issue #38, Stage 3): one synthetic provider config per
// routable subscription, plus the POOL client that serves ALL its accounts. The
// config carries the UNION of every schedulable account's enabled models as
// `<provider>/<model>` aliases (so Lanes sees the full exposure); the registry
// maps each alias to providerName === providerId, and `poolClients.get(providerId)`
// returns ONE pool client that round-robins across the accounts on every call.
export interface SynthesizedOAuth {
  providers: ProviderConfigShared[];
  poolClients: Map<string, ProviderClient>;
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
  const poolClients = new Map<string, ProviderClient>();

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
      let accessToken: string;
      try {
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId, account },
          tokenStore: oauthCtx.store,
          encKey: oauthCtx.encKey,
          oauthProvider: provider,
          now: () => Date.now(),
        });
        accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
      } catch {
        log("warn", "oauth.autoroute.skip", { providerId, account, reason: "refresh failed" });
        continue;
      }
      let discovered: string[];
      try {
        discovered = await discoverOAuthModels(providerId, accessToken);
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
      // The per-account config drives createProviderClient (type + oauth preset +
      // base). The per-account egress proxy is resolved from the same settings.
      const accountConfig = {
        name: providerId,
        alias: providerId,
        type: spec.type,
        base_url: spec.baseUrl,
        oauth: { provider: providerId, account },
        models: [],
      } as unknown as ProviderConfigShared;
      const cred = buildCredential(accountConfig, oauthCtx);
      if (!cred) continue; // unreachable (token just refreshed) — fail-open guard
      const proxy = resolveProviderProxy(accountConfig, accountSettings);
      // Stable per-account anti-ban identity (never rotates): Anthropic gets a
      // metadata.user_id; Codex a stable session_id. Both deterministic from
      // (providerId, account) salted by the at-rest key — no DB write-back.
      const identity =
        providerId === "anthropic"
          ? { metadataUserId: anthropicMetadataUserId(providerId, account, oauthCtx.encKey) }
          : providerId === "openai-codex"
            ? { sessionId: stableSessionId(providerId, account, oauthCtx.encKey) }
            : undefined;
      // Bind the quota-header scrape to THIS account (providers page Tier 3): the
      // Codex client invokes it with each reply's headers; synthesis closes over the
      // account so the snapshot is attributed correctly. undefined ⇒ no capture.
      const onResponseMeta = onQuotaHeaders
        ? (headers: Headers) => onQuotaHeaders(providerId, account, headers)
        : undefined;
      const client = createProviderClient(
        accountConfig,
        { baseUrl: spec.baseUrl ?? fallbackBaseUrl, timeoutMs },
        cred,
        proxy,
        identity,
        onResponseMeta,
      );
      members.push({ account, priority: s.priority ?? 50, schedulable: true, client });
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
    } as ProviderConfigShared);
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

// Resolve a provider's credential from env / store (issue #38). Returns null when
// a required secret is unset / no credential is stored — the caller decides
// fail-open (skip a non-primary provider) vs fail-closed (throw for the primary).
// Each OAuth provider gets ONE process-level TokenManager (1:1 with its client),
// shared across requests — lazy refresh, no background timer.
// Exported for unit tests (server.oauth.test.ts); not part of the public API.
export function buildCredential(
  p: ProviderConfigShared,
  oauthCtx?: OAuthRuntimeCtx,
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
    const cred = buildCredential(p, oauthCtx);
    if (!cred) continue; // no credential → cannot build a client; skip.
    const baseUrl = p.base_url ?? fallbackBaseUrl;
    const proxy = resolveProviderProxy(p, accountSettings);
    clients.set(p.name, createProviderClient(p, { baseUrl, timeoutMs }, cred, proxy));
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
): ProviderClient {
  // One proxy fetch per client (the executor keeps one client per account, so the
  // undici dispatcher is pooled per account). Built ONCE here, not per request.
  const proxyFetch = proxy ? makeProxyFetch(proxy) : undefined;
  if (p.type === "anthropic") {
    return createAnthropicClient({
      config: { ...base, ...cred, metadataUserId: identity?.metadataUserId },
      fetch: proxyFetch,
    });
  }
  // ChatGPT Codex subscription: the OpenAI *Responses* protocol (stream-only,
  // ChatGPT identity headers, account-id decoded from the access-token JWT). Needs
  // the dynamic OAuth header; a static key never drives this path.
  if (p.type === "openai-responses" && "getAuthHeader" in cred) {
    return createCodexResponsesClient({
      config: { ...base, ...cred, sessionId: identity?.sessionId, onResponseMeta },
      fetch: proxyFetch,
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
        resolveBaseUrl: async () =>
          getGitHubCopilotBaseUrl((await getAuth()).replace(/^Bearer /, "")),
      },
      fetch: proxyFetch,
    });
  }
  return createOpenAIClient({ config: { ...base, ...cred }, fetch: proxyFetch });
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
  const keyStore = store.keys;
  const telemetry = store.telemetry;

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
  // Apply a new settings object live: re-bind `settings`, push the log level into
  // the logger, flip the rate-limit master switch, and retune the system-default
  // quota. Called by the admin settings route after it validates + persists.
  const applySettings = (next: RuntimeSettings): void => {
    settings = next;
    logger.setLevel?.(next.log_level);
    rateLimitConfig.enabled = next.rate_limit_enabled;
    rateLimitConfig.default = {
      rpm: next.rate_limit_default_rpm,
      tpm: next.rate_limit_default_tpm,
    };
  };
  // Agentic Signals (POST-MVP feedback layer, docs/02). The collector consumes
  // ALREADY-persisted telemetry and writes aggregated, REDACTED signals — it is
  // started as a BACKGROUND interval below (NEVER on the request path), so it
  // adds zero latency to any served request. Observe-only this phase: nothing
  // reads these signals back into routing.
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
  const injectDeps: InjectDeps = {
    memoryStore: store.memory,
    estimateTokens: estimateMemoryTokens,
    enqueueObserverJob: (scope) => store.memory.enqueueJob({ type: "observer", scope }),
    costSink: () => {},
    now: () => new Date(),
    log: memoryLog,
  };
  const injectTokenBudgetRaw = Number(process.env.HELM_MEMORY_INJECT_TOKEN_BUDGET ?? 4000);
  const injectTokenBudget =
    Number.isFinite(injectTokenBudgetRaw) && injectTokenBudgetRaw > 0 ? injectTokenBudgetRaw : 4000;
  const inject = { deps: injectDeps, tokenBudget: injectTokenBudget };

  // Observer/Reflector deps (docs/08 Phase 2). D11: MVP uses DETERMINISTIC, non-LLM
  // summarize/merge (concatenate + truncate) so a reflection version only bumps on a
  // real content change (cache-friendly); a real LLM path is a follow-up issue.
  const observerDeps: ObserverDeps = {
    memoryStore: store.memory,
    summarize: async ({ messages }) => ({
      observationText: summarizeMessages(messages),
    }),
    costSink: () => {},
    now: () => new Date(),
    log: memoryLog,
  };
  const reflectorDeps: ReflectorDeps = {
    memoryStore: store.memory,
    merge: async ({ observations, previousReflection }) => {
      const reflectionText = mergeObservations(observations, previousReflection);
      return { reflectionText, tokenEstimate: estimateMemoryTokens(reflectionText) };
    },
    costSink: () => {},
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
  });

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
  const primaryCred = buildCredential(first, oauthCtx);
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
  };
  const synthesizedOAuth = await synthesizeOAuthProviders(
    config.providers,
    oauthCtx,
    store.config,
    synthBaseUrl,
    timeoutMs,
    (lvl, msg, f) => logger.log(lvl, msg, f),
    captureCodexQuota,
  );
  const routableProviders: ProviderConfigShared[] = [
    ...config.providers,
    ...synthesizedOAuth.providers,
  ];

  // The default/primary client (eval + passthrough + back-fill aliases), dispatched
  // by type (anthropic native vs OpenAI-compatible). When the primary is OAuth this
  // SAME dynamic-header client backs the eval/classify path below, so eval auth
  // never silently fails (acceptance criterion 9).
  const provider = createProviderClient(
    first,
    { baseUrl, timeoutMs },
    primaryCred,
    resolveProviderProxy(first, accountSettings),
  );
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
  let oauthPoolClients = synthesizedOAuth.poolClients;
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
  const classify = buildClassifyAdapter({
    getClassifierConfig: () => classifierConfig,
    lanes,
    provider,
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
  // failure). The Anthropic /v1/messages route self-authenticates so its errors
  // are translated to the Anthropic envelope (docs/07) — see registerMessagesRoute.
  app.use(
    "/v1/chat/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  // Rate limit AFTER auth (needs the resolved key_id) and BEFORE classify/route
  // (cut off cost before classification/eval). No-op when disabled (docs/06).
  app.use(
    "/v1/chat/*",
    rateLimitMiddleware({ limiter: rateLimiter, estimateTokens: estimateRequestTokens }),
  );

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
          execute: createExecute({
            defaultProvider: provider,
            providers: providerClients,
            // Subscription aliases are gated authoritatively by the LIVE curation set +
            // pool (fail-closed), bypassing the startup registry — so de-curation /
            // disconnect take effect immediately and never cross provider boundaries.
            knownOAuthPrefixes: ROUTABLE_OAUTH_IDS,
            oauthAliases: () => oauthAliasSet,
            registry,
            breaker,
            catalog,
            now: () => Date.now(),
            signal,
            log: (level, msg, fields) => logger.log(level as "info", msg, fields),
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
  // that provider's (`<providerId>/<model>`). `dayMs` is UTC midnight (epoch ms is
  // UTC, so `ms - ms % 86_400_000` floors to the day).
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
        dayMs: nowMs - (nowMs % 86_400_000),
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
    redact: (payload) => redact(payload),
    now: () => Date.now(),
    recordOAuthUsage,
    // Full request/response capture + streamed-cost backfill. The getters read the
    // LIVE runtime settings so the admin toggle/retention apply without a restart.
    capturePayloads: () => settings.capture_payloads,
    payloadRetentionMs: () => settings.payload_retention_days * 86_400_000,
    costOf,
    // Per-key usage budgets (docs/06): the pre-route gate (degrade/reject) + the
    // post-served settle, threaded from the composition root.
    budgetGate,
    settleBudget: settleKeyBudget,
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
    const ruleStore = createRuntimeRuleStore({
      lanes: lanes as Record<string, Lane>,
      policies,
      classifier: classifierConfig,
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
    registerAdminApi(app, {
      rules: ruleStore,
      keyStore,
      telemetry,
      modelAliases,
      genKey: () => {
        const k = generateKey();
        return { plaintext: k.plaintext, hash: k.hash, prefix: k.prefix };
      },
      genKeyId: () => randomUUID(),
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
      oauth: oauthCtx
        ? createOAuthAdmin({
            store: oauthCtx.store,
            encKey: oauthCtx.encKey,
            config: store.config,
          })
        : undefined,
      // Per-account OAuth subscription observability stores (providers page): today's
      // usage aggregate (Tier 2) + latest quota window snapshot (Tier 3). Read by the
      // /oauth/usage + /oauth/quota admin routes (fail-open to empty when absent).
      oauthUsage: store.oauthUsage,
      oauthQuota: store.oauthQuota,
      // Hot-reload the routable OAuth pool after any admin mutation (proxy /
      // priority / schedulable / curation / connect / disconnect) so it applies on
      // the next request without a restart.
      onOAuthMutation: rebuildOAuthPool,
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
  );
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
            // Per-key rate-limit override (docs/06): carried so the self-auth
            // /v1/messages + /v1/responses paths enforce per-key limits too, not
            // just the OpenAI chat middleware.
            rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
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
  );
  registerResponsesRoute(app, {
    // Same per-key limiter, same cast rationale as the messages route above —
    // closes the rate-limit bypass on /v1/responses.
    rateLimiter,
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
            // Per-key rate-limit override (docs/06): carried so the self-auth
            // /v1/messages + /v1/responses paths enforce per-key limits too, not
            // just the OpenAI chat middleware.
            rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
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
    { observe },
    pipelineBudget,
    recordOAuthUsage,
  );
  registerGeminiRoute(app, {
    rateLimiter,
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
            rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
            budget: {
              requests: record.budget_requests,
              tokens: record.budget_tokens,
              spendUsd: record.budget_spend_usd,
              windowSeconds: record.budget_window_seconds,
              behavior: record.over_budget_behavior,
              degradeLane: record.degrade_lane,
            },
          },
        };
      },
    },
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
  } as Parameters<typeof registerGeminiRoute>[1] & { rateLimiter: RateLimiterPort });

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
  let memoryWorker: { stop: () => void } | null = null;
  if (process.env.HELM_MEMORY_WORKER_DISABLED !== "1") {
    const intervalRaw = Number(process.env.HELM_MEMORY_WORKER_INTERVAL_MS ?? 60_000);
    memoryWorker = startMemoryWorker({
      memoryStore: store.memory,
      batchSize: 10,
      intervalMs: Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 60_000,
      now: () => Date.now(),
      log: memoryLog,
      runObserver: (job) => runObserverJob(job, observerDeps),
      runReflector: (job) => runReflectorJob(job, reflectorDeps),
    });
  }

  return {
    app,
    port: config.server.port,
    host: config.server.host,
    dispose: () => {
      signalScheduler?.stop();
      memoryWorker?.stop();
      // Close the underlying DB connection (sqlite file handle / pg pool). Best
      // effort: a close error must not mask a clean shutdown.
      void store.close().catch(() => {});
    },
  };
}
