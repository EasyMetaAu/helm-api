import { randomUUID } from "node:crypto";
import {
  beginAnthropicLogin,
  beginCopilotDeviceLogin,
  beginOpenAICodexLogin,
  beginXaiDeviceLogin,
  buildOpenAICodexUserAgent,
  type ConfigStore,
  type CopilotDeviceStart,
  completeAnthropicLogin,
  completeOpenAICodexLogin,
  createTokenManager,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  decryptSecret,
  discoverOAuthModels,
  encryptSecret,
  expandOpenAICodexModelAliases,
  GROK_OAUTH_MEDIA_MODELS,
  getOAuthProvider,
  hasLiveModelDiscovery,
  isRoutableXaiOAuthModel,
  listOpenAICodexModels,
  listXaiOAuthModels,
  makeProxyFetch,
  type OAuthCredentials,
  type OAuthTokenStore,
  type OpenAICodexIdentity,
  openAICodexIdentityFingerprint,
  type ProxyConfig,
  parseAnthropicUsageBody,
  parseCodexQuotaDetails,
  parseCodexResetCredits,
  parseCodexResetResult,
  parseOpenAICodexIdentity,
  parseXaiGrokCreditsResponse,
  pollCopilotDeviceOnce,
  pollXaiDeviceOnce,
  refreshGitHubCopilotToken,
  resolveXaiGrokClientVersion,
  validateProxyConfig,
  XAI_GROK_OAUTH_BASE_URL,
  type XaiDeviceStart,
} from "@helm/core";
import { CodexOAuthUsageSchema, type OAuthQuotaWindow } from "@helm/shared";
import type {
  AccountPoolStrategyView,
  AccountProxyInput,
  AccountProxyView,
  AccountScheduleView,
  CodexAdditionalLimitView,
  CodexCreditsView,
  CodexIndividualLimitView,
  CodexQuotaResult,
  CodexRateLimitReachedType,
  CodexResetCreditDetailView,
  CodexResetCreditResult,
  OAuthAdminAccess,
  OAuthAdminStatusResponse,
} from "../routes/admin/deps.js";
import {
  type AccountSettings,
  clearAccountCredentialFailure,
  clearAccountDiscoveredModels,
  clearAccountSettings,
  getAccountSettings,
  loadAccountSettings,
  loadGlobalOAuthSettings,
  markAccountCredentialFailure,
  resolveAccountModelsMode,
  saveAccountDiscoveredModels,
  saveAccountXaiDiscoveredModels,
  selectAccountModels,
  setAccountSettings,
  setGlobalOAuthSettings,
} from "./account-settings.js";
import type { CodexModelCacheKey } from "./codex-model-cache.js";
import type { CodexModelCatalog } from "./codex-model-catalog.js";
import {
  isPermanentOAuthCredentialFailure,
  oauthCredentialFailureReason,
} from "./credential-failure.js";
import {
  createOAuthModelDiscoveryCache,
  type OAuthModelDiscoveryCache,
} from "./model-discovery-cache.js";

// Admin OAuth-login orchestration (issue #38) — the implementation behind the
// OAuthAdminAccess seam the /admin/api/oauth routes call. Owns the ephemeral
// per-login session state (PKCE verifier/state for manual flows; device code and
// provider endpoint metadata for Copilot/xAI), the upstream exchange, at-rest
// ENCRYPTION (token-cipher), and the OAuthTokenStore write-back.
//
// SECURITY (principle 7): the encryption key is resolved at the composition root
// and handed in as a Buffer (never an env name here). Sessions live in memory only
// and hold short-lived flow state, never a long-lived secret beyond the login.

const ANTHROPIC = "anthropic";
const COPILOT = "github-copilot";
const CODEX = "openai-codex";
const XAI = "xai";
const SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_PENDING_OAUTH_SESSIONS = 128;

// Anthropic OAuth usage endpoint (providers page Tier 3 quota PULL). Mirrors the
// claude-relay-service reference: the `oauth-2025-04-20` beta flag + a claude-cli
// User-Agent gate the endpoint (a generic UA is rejected). Cached per account for 5
// min so a page refresh never hammers it (the upstream itself rate-limits this).
const QUOTA_TTL_MS = 5 * 60 * 1000;
// Hard ceiling on the usage-endpoint fetch so a hung proxy/upstream never blocks the
// providers page (the route is fail-open; this bounds the worst case).
const QUOTA_FETCH_TIMEOUT_MS = 8_000;
const RESET_CREDIT_DETAILS_TIMEOUT_MS = 5_000;
const RESET_CREDIT_CONSUME_TIMEOUT_MS = 10_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const XAI_GROK_CREDITS_URL = `${XAI_GROK_OAUTH_BASE_URL}/billing?format=credits`;
const XAI_GROK_CREDITS_HEADERS = {
  accept: "application/json",
  "X-XAI-Token-Auth": "xai-grok-cli",
  // Helm is a non-interactive gateway process; this is the official Grok Build
  // process mode for headless requests.
  "x-grok-client-mode": "headless",
} as const;
const OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES = 1024 * 1024;
const ANTHROPIC_USAGE_HEADERS = {
  "anthropic-beta": "oauth-2025-04-20",
  "user-agent": "claude-cli/2.0.53 (external, cli)",
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
} as const;

// Codex usage endpoint (providers page Tier 3 quota PULL) — the same payload the
// Codex CLI's /status reads. The on-demand counterpart of the `x-codex-*` header
// PUSH (provider/oauth/codex-quota.ts): without it an account that has served no
// traffic yet renders "—" forever. Gated on a Codex-client originator/UA pair
// (verified live 2026-06-04) plus the per-account `chatgpt-account-id` header
// (decoded from the access-token JWT, same as the execution path).
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_HEADERS = {
  originator: "codex_cli_rs",
  "user-agent": "codex_cli_rs",
  accept: "application/json",
} as const;
// Codex "reset usage limit" CONSUME endpoint. Spends one rate-limit reset credit
// (surfaced as `available_count` on the usage PULL) to immediately restore the
// account's rate-limit windows. `redeem_request_id` is the upstream idempotency
// key; callers may reuse one across retries, otherwise Helm generates a UUID.
// Same auth + identity headers as the usage PULL.
const CODEX_RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CODEX_RESET_DETAILS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

interface CodexQuotaCacheValue {
  at: number;
  windows: OAuthQuotaWindow[] | null;
  additionalLimits?: CodexAdditionalLimitView[];
  resetCredits?: number | null;
  resetCreditDetails?: CodexResetCreditDetailView[] | null;
  credits?: CodexCreditsView | null;
  individualLimit?: CodexIndividualLimitView | null;
  planType?: string | null;
  rateLimitReachedType?: CodexRateLimitReachedType | null;
}

async function readBoundedBinaryResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`quota response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`quota response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBinaryResponse(response, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function codexResetCreditDetails(body: unknown): {
  availableCount: number;
  credits: CodexResetCreditDetailView[];
} | null {
  const parsed = CodexOAuthUsageSchema.safeParse({ rate_limit_reset_credits: body });
  if (!parsed.success) return null;
  const summary = parsed.data.rate_limit_reset_credits;
  if (
    !summary ||
    typeof summary.available_count !== "number" ||
    !Number.isFinite(summary.available_count) ||
    summary.available_count < 0 ||
    !Array.isArray(summary.credits)
  ) {
    return null;
  }
  const credits: CodexResetCreditDetailView[] = [];
  for (const credit of summary.credits) {
    const grantedAt = Date.parse(credit.granted_at) / 1000;
    const expiresAt =
      typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) / 1000 : null;
    if (!Number.isFinite(grantedAt) || (expiresAt !== null && !Number.isFinite(expiresAt))) {
      return null;
    }
    credits.push({
      id: credit.id,
      resetType: credit.reset_type === "codex_rate_limits" ? "codexRateLimits" : "unknown",
      status:
        credit.status === "available" ||
        credit.status === "redeeming" ||
        credit.status === "redeemed"
          ? credit.status
          : "unknown",
      grantedAt: Math.floor(grantedAt),
      expiresAt: expiresAt === null ? null : Math.floor(expiresAt),
      title: typeof credit.title === "string" ? credit.title : null,
      description: typeof credit.description === "string" ? credit.description : null,
    });
  }
  return {
    availableCount: Math.floor(summary.available_count),
    credits,
  };
}

// Manual-paste (authorization-code) providers and their begin/complete step-fns.
// `complete` takes the egress-proxy fetch so the token exchange leaves through the
// account's pinned hop (issue #38) — the bind-time call must not leak the real IP.
const MANUAL_FLOWS: Record<
  string,
  {
    begin: () => { authorizeUrl: string; verifier: string; state: string };
    complete: (
      input: {
        redirectInput: string;
        verifier: string;
        state: string;
      },
      fetchImpl?: typeof globalThis.fetch,
    ) => Promise<OAuthCredentials>;
  }
> = {
  [ANTHROPIC]: { begin: beginAnthropicLogin, complete: completeAnthropicLogin },
  [CODEX]: { begin: beginOpenAICodexLogin, complete: completeOpenAICodexLogin },
};

// Each login session pins its egress proxy (when the operator entered one in the
// connect dialog's first step) so EVERY network call of the flow — and the persisted
// account settings — use it (issue #38). `proxy` undefined ⇒ direct connection.
type Session =
  | {
      kind: "manual";
      providerId: string;
      verifier: string;
      state: string;
      proxy?: ProxyConfig;
      createdAt: number;
    }
  | {
      kind: "device";
      providerId: string;
      deviceCode: string;
      domain?: string;
      tokenEndpoint?: string;
      enterpriseDomain?: string;
      proxy?: ProxyConfig;
      createdAt: number;
      expiresAt: number;
    };

export interface OAuthAdminDeps {
  store: OAuthTokenStore;
  encKey: Buffer;
  // Per-account SETTINGS live in the ConfigStore (config_kv), NOT in the token
  // store's `meta` (a token refresh overwrites meta). Same enc key encrypts the
  // settings blob. Threaded in from the composition root (server.ts store.config).
  config: ConfigStore;
  now?: () => number;
  genSessionId?: () => string;
  // Build the drop-in fetch for an (optional) egress proxy. Injected so a unit test
  // can assert the proxy fetch — not the real-IP global — serves the binding calls.
  // Default: makeProxyFetch when a proxy is set, else the global fetch.
  makeFetch?: (proxy?: ProxyConfig) => typeof globalThis.fetch;
  // Structured diagnostics sink (server.ts wires the JSON logger). The quota PULLs
  // are fail-open by design, which previously meant their failures were swallowed
  // SILENTLY — a body the schema rejected parsed to [] and froze the providers page
  // on a stale snapshot for ~a day with zero log evidence. Optional so the many
  // existing unit harnesses stay untouched. Ids/labels/status only — never a body
  // or token (principle 7).
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  // Called after listStatus discovers and persists a durable credential failure.
  // server.ts uses this to rebuild the live OAuth pool so admin status and routing
  // agree immediately. Optional for unit tests and disabled deployments.
  onCredentialFailure?: (
    providerId: string,
    account: string,
    reason: string,
  ) => Promise<void> | void;
  codexCatalog?: CodexModelCatalog;
  codexClientVersion?: string;
  codexUserAgent?: string;
  modelDiscoveryCache?: OAuthModelDiscoveryCache;
}

// Split a credential into store fields. `meta` carries every key beyond the
// canonical {access, refresh, expires} (e.g. copilot enterpriseUrl).
function metaFrom(creds: OAuthCredentials): string | null {
  const { access: _a, refresh: _r, expires: _e, idToken: _idToken, ...rest } = creds;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
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

function parseStoredMetadata(raw: string | null): Readonly<Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function statusCodexIdentity(
  store: OAuthTokenStore,
  encKey: Buffer,
  providerId: string,
  account: string,
): Promise<OpenAICodexIdentity> {
  if (providerId !== CODEX) return {};
  try {
    const row = await store.get(providerId, account);
    if (!row) return {};
    const metadata = parseStoredMetadata(row.meta);
    const storedIdentity = codexIdentityFromMetadata(metadata);
    if (!row.accessEnc) return storedIdentity;
    try {
      return mergeCodexIdentity(decryptSecret(row.accessEnc, encKey), metadata);
    } catch {
      return storedIdentity;
    }
  } catch {
    return {};
  }
}

function codexModelSets(
  models: ReadonlyArray<{ slug: string; priority: number; visibility: "list" | "hide" | "none" }>,
): { entitled: string[]; visible: string[] } {
  const ordered = [...models].sort((left, right) => left.priority - right.priority);
  return {
    entitled: expandOpenAICodexModelAliases(ordered.map((model) => model.slug)),
    visible: expandOpenAICodexModelAliases(
      ordered.filter((model) => model.visibility === "list").map((model) => model.slug),
    ),
  };
}

export function createOAuthAdmin(deps: OAuthAdminDeps): OAuthAdminAccess {
  const now = deps.now ?? (() => Date.now());
  const genId = deps.genSessionId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});
  // Resolve the egress fetch for a (possibly absent) proxy. ONE place so the whole
  // flow — begin/complete/poll + token-manager refresh + quota — egresses alike.
  const makeFetch =
    deps.makeFetch ?? ((proxy?: ProxyConfig) => (proxy ? makeProxyFetch(proxy) : fetch));
  const modelDiscoveryCache = deps.modelDiscoveryCache ?? createOAuthModelDiscoveryCache({ now });
  // Normalize + fail-closed-validate a connect-dialog proxy into a ProxyConfig held
  // for the whole login (issue #38). Mirrors setAccountProxy's field handling so the
  // shape persisted at bind matches a later Manage-dialog edit. Throws on a malformed
  // proxy BEFORE any network call, so an invalid proxy never silently falls back to a
  // direct (real-IP) connection.
  function toProxy(input?: AccountProxyInput | null): ProxyConfig | undefined {
    if (!input) return undefined;
    const next: ProxyConfig = {
      type: input.type,
      host: input.host,
      port: input.port,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined && input.password !== ""
        ? { password: input.password }
        : {}),
    };
    validateProxyConfig(next);
    return next;
  }
  // Persist the bind-time proxy to the account settings so refresh + execution +
  // quota reuse it (the SAME blob resolveProviderProxy reads) — true 全程 coverage.
  async function persistProxy(
    providerId: string,
    account: string,
    proxy?: ProxyConfig,
  ): Promise<void> {
    if (!proxy) return;
    await setAccountSettings(deps.config, deps.encKey, providerId, account, { proxy });
  }
  // Project a stored proxy into the REDACTED admin view (principle 7): the password
  // is NEVER echoed, only whether one is set. Shared by listStatus (folds it onto
  // every row) and getAccountProxy (the Manage dialog's per-account read) so the two
  // can never drift in what they reveal. null in ⇒ null out (direct connection).
  function redactProxy(
    proxy:
      | {
          type: "http" | "https" | "socks5";
          host: string;
          port: number;
          username?: string;
          password?: string;
        }
      | undefined,
  ): AccountProxyView | null {
    if (!proxy) return null;
    return {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      ...(proxy.username !== undefined ? { username: proxy.username } : {}),
      hasPassword: typeof proxy.password === "string" && proxy.password.length > 0,
    };
  }
  const sessions = new Map<string, Session>();
  let pendingDeviceStarts = 0;
  // Per-account provider quota cache (5-min TTL): key `<provider> <account>`.
  // Caches the OUTCOME of a usage fetch — windows on success, `null` on failure —
  // so a rate-limited/erroring endpoint is NOT retried until the TTL lapses
  // (negative caching). The providers page is the only caller and triggers this on
  // page open / after an account action; there is no background poll.
  // `resetCredits` (Codex only) rides alongside the windows: both come from the
  // SAME /wham/usage PULL, so caching them together avoids a second round-trip.
  // undefined for the Anthropic path (which has no such grant).
  const quotaCache = new Map<string, CodexQuotaCacheValue>();
  const quotaCacheEpoch = new Map<string, number>();
  const cachedCodexQuota = (account: string): CodexQuotaResult => {
    const cached = quotaCache.get(`${CODEX} ${account}`);
    if (!cached || cached.windows === null) return null;
    return {
      windows: cached.windows,
      additionalLimits: cached.additionalLimits ?? [],
      resetCredits: cached.resetCredits ?? null,
      resetCreditDetails: cached.resetCreditDetails ?? null,
      credits: cached.credits ?? null,
      individualLimit: cached.individualLimit ?? null,
      planType: cached.planType ?? null,
      rateLimitReachedType: cached.rateLimitReachedType ?? null,
    };
  };
  const invalidateQuotaCache = (providerId: string, account: string): void => {
    const key = `${providerId} ${account}`;
    quotaCache.delete(key);
    quotaCacheEpoch.set(key, (quotaCacheEpoch.get(key) ?? 0) + 1);
  };

  async function codexCatalogModels(
    account: string,
  ): Promise<{ entitled: string[]; visible: string[] } | undefined> {
    if (!deps.codexCatalog) return undefined;
    const row = await deps.store.get(CODEX, account);
    if (!row?.accessEnc) return undefined;
    try {
      const accessToken = decryptSecret(row.accessEnc, deps.encKey);
      const identity = mergeCodexIdentity(accessToken, parseStoredMetadata(row.meta));
      const key: CodexModelCacheKey = {
        providerId: CODEX,
        account,
        accountIdentity: openAICodexIdentityFingerprint(identity),
        clientVersion: deps.codexClientVersion ?? DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
      };
      const snapshot = deps.codexCatalog.snapshot(key);
      return snapshot ? codexModelSets(snapshot.models) : undefined;
    } catch {
      return undefined;
    }
  }

  async function discoverAccountModels(
    providerId: string,
    account: string,
    settings: AccountSettings,
    forceRefresh = false,
  ): Promise<{ available: string[]; entitled: string[] }> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return { available: [], entitled: [] };
    if (providerId === XAI) {
      const lkg = (settings.xaiDiscoveredModels ?? [])
        .filter(isRoutableXaiOAuthModel)
        .map((model) => model.id);
      try {
        const accountFetch = makeFetch(settings.proxy as ProxyConfig | undefined);
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId, account },
          tokenStore: deps.store,
          encKey: deps.encKey,
          oauthProvider: provider,
          fetch: accountFetch,
          now,
        });
        const accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
        const metadata = tm.currentMetadata();
        const live = await listXaiOAuthModels(accessToken, accountFetch, {
          identity: {
            userId: identityString(metadata.accountId),
            email: identityString(metadata.email),
          },
        });
        if (!(await saveAccountXaiDiscoveredModels(deps.config, deps.encKey, account, live))) {
          log("warn", "oauth.models.snapshot_write_failed", { providerId, account });
        }
        const available = live.filter(isRoutableXaiOAuthModel).map((model) => model.id);
        return { available, entitled: available };
      } catch {
        return { available: lkg, entitled: lkg };
      }
    }
    if (providerId !== CODEX) {
      const discoveryKey = { providerId, account };
      const available = await modelDiscoveryCache.load(
        discoveryKey,
        async () => {
          const accountFetch = makeFetch(settings.proxy as ProxyConfig | undefined);
          const tm = createTokenManager({
            oauth: { kind: "preset", providerId, account },
            tokenStore: deps.store,
            encKey: deps.encKey,
            oauthProvider: provider,
            fetch: accountFetch,
            now,
          });
          const accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
          return discoverOAuthModels(providerId, accessToken, accountFetch, {
            fallbackToCurated: false,
          });
        },
        { force: forceRefresh },
      );
      const accepted = modelDiscoveryCache.snapshot(discoveryKey);
      if (
        accepted &&
        accepted.length > 0 &&
        !(await saveAccountDiscoveredModels(
          deps.config,
          deps.encKey,
          providerId,
          account,
          accepted,
        ))
      ) {
        log("warn", "oauth.models.snapshot_write_failed", { providerId, account });
      }
      return { available, entitled: available };
    }
    try {
      const accountFetch = makeFetch(settings.proxy as ProxyConfig | undefined);
      const tm = createTokenManager({
        oauth: { kind: "preset", providerId, account },
        tokenStore: deps.store,
        encKey: deps.encKey,
        oauthProvider: provider,
        fetch: accountFetch,
        now,
      });
      const accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
      if (providerId === CODEX && deps.codexCatalog) {
        const clientVersion = deps.codexClientVersion ?? DEFAULT_OPENAI_CODEX_CLIENT_VERSION;
        const userAgent = deps.codexUserAgent ?? buildOpenAICodexUserAgent(clientVersion);
        const identity = mergeCodexIdentity(accessToken, tm.currentMetadata());
        const key: CodexModelCacheKey = {
          providerId,
          account,
          accountIdentity: openAICodexIdentityFingerprint(identity),
          clientVersion,
        };
        const snapshot = await deps.codexCatalog.load(
          key,
          async () => {
            const currentAccess = (await tm.getAuthHeader()).replace(/^Bearer /, "");
            const currentIdentity = mergeCodexIdentity(currentAccess, tm.currentMetadata());
            return listOpenAICodexModels(currentAccess, {
              accountId: currentIdentity.accountId,
              isFedramp: currentIdentity.isFedramp,
              clientVersion,
              userAgent,
              fetchImpl: accountFetch,
            });
          },
          { force: forceRefresh },
        );
        if (!snapshot) return { available: [], entitled: [] };
        const modelSets = codexModelSets(snapshot.models);
        return { available: modelSets.visible, entitled: modelSets.entitled };
      }
      const available = await discoverOAuthModels(providerId, accessToken, accountFetch, {
        fallbackToCurated: false,
      });
      const expanded = expandOpenAICodexModelAliases(available);
      return { available: expanded, entitled: expanded };
    } catch {
      return { available: [], entitled: [] };
    }
  }

  function enabledAccountModels(
    providerId: string,
    settings: AccountSettings,
    discovered: { available: string[]; entitled: string[] },
  ): string[] {
    if (providerId === CODEX) return selectAccountModels(CODEX, settings, discovered.entitled);
    const mode = resolveAccountModelsMode(providerId, settings);
    const enabled = mode === "auto" ? discovered.available : (settings.enabledModels ?? []);
    return mode === "auto" ? withXaiMediaModels(providerId, enabled) : enabled;
  }

  function withXaiMediaModels(providerId: string, models: string[]): string[] {
    return providerId === XAI ? [...new Set([...models, ...GROK_OAUTH_MEDIA_MODELS])] : models;
  }

  function prune(): void {
    const current = now();
    const cutoff = current - SESSION_TTL_MS;
    for (const [id, s] of sessions) {
      if (s.createdAt < cutoff || (s.kind === "device" && s.expiresAt <= current)) {
        sessions.delete(id);
      }
    }
  }

  function ensureSessionCapacity(): void {
    prune();
    if (sessions.size + pendingDeviceStarts >= MAX_PENDING_OAUTH_SESSIONS) {
      throw new Error("too many pending OAuth sessions; complete or wait for an existing login");
    }
  }

  function take(sessionId: string): Session {
    prune();
    const s = sessions.get(sessionId);
    if (!s) throw new Error("login session not found or expired — start again");
    return s;
  }

  async function persist(
    providerId: string,
    account: string,
    creds: OAuthCredentials,
  ): Promise<void> {
    if (providerId !== CODEX) {
      // Invalidate first so an old in-flight discovery cannot become the current
      // cache generation, then strictly clear its durable identity-bound snapshot.
      modelDiscoveryCache.invalidate({ providerId, account });
      if (!(await clearAccountDiscoveredModels(deps.config, deps.encKey, providerId, account))) {
        throw new Error("failed to clear the previous account model snapshot");
      }
    }
    await deps.store.upsert({
      providerId,
      account,
      accessEnc: encryptSecret(creds.access, deps.encKey),
      refreshEnc: encryptSecret(creds.refresh, deps.encKey),
      expiresAt: creds.expires,
      meta: metaFrom(creds),
      updatedAt: now(),
    });
    // A reconnect may reuse the same operator-facing label for a different
    // upstream identity. Never let that new credential inherit the old identity's
    // positive OR negative quota cache entry.
    invalidateQuotaCache(providerId, account);
  }

  // Ensure a stored account's access token is fresh — the SAME lazy refresh the
  // execution path uses (openclaw-style: refresh when expired/near, write back),
  // but triggered on page view so the UI shows a live, just-renewed expiry instead
  // of a stale "expired". A still-valid token is a no-op (no network). Returns the
  // (possibly updated) expiry + a health flag: `healthy:false` means the durable
  // credential itself failed to refresh — the account needs re-connecting.
  async function ensureFresh(
    providerId: string,
    account: string,
    stored: { expiresAt: number | null; updatedAt: number },
    // The account's egress proxy (from the already-loaded settings) so the lazy
    // refresh tunnels through the SAME hop as execution — never the real IP.
    proxy?: ProxyConfig,
  ): Promise<{
    account: string;
    expiresAt: number | null;
    updatedAt: number;
    healthy: boolean;
    credentialFailed: boolean;
  }> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return { account, ...stored, healthy: true, credentialFailed: false };
    const tm = createTokenManager({
      oauth: { kind: "preset", providerId, account },
      tokenStore: deps.store,
      encKey: deps.encKey,
      oauthProvider: provider,
      fetch: makeFetch(proxy),
      now,
    });
    let healthy = true;
    let credentialFailed = false;
    try {
      await tm.getAuthHeader(); // refresh-if-expired + write back; no-op when fresh
    } catch (e) {
      healthy = false; // refresh-token / durable credential is dead → needs re-login
      credentialFailed = isPermanentOAuthCredentialFailure(e);
      if (credentialFailed) {
        const reason = oauthCredentialFailureReason(e);
        await markAccountCredentialFailure(deps.config, deps.encKey, providerId, account, {
          at: now(),
          reason,
        });
        await Promise.resolve(deps.onCredentialFailure?.(providerId, account, reason)).catch(
          () => {},
        );
      }
    }
    const r = await deps.store.get(providerId, account);
    return {
      account,
      expiresAt: r?.expiresAt ?? stored.expiresAt,
      updatedAt: r?.updatedAt ?? stored.updatedAt,
      healthy,
      credentialFailed,
    };
  }

  async function buildStatus(options: {
    refresh: boolean;
    forceRefresh: boolean;
    serial: boolean;
  }): Promise<OAuthAdminStatusResponse> {
    const rows = await deps.store.list();
    const settings = await loadAccountSettings(deps.config, deps.encKey);
    const globalSettings = await loadGlobalOAuthSettings(deps.config, deps.encKey);
    const project = async (r: (typeof rows)[number]) => {
      const sch = getAccountSettings(settings, r.providerId, r.account);
      const hasCredentialFailure = typeof sch.credentialFailedAt === "number";
      const fresh =
        options.refresh && !hasCredentialFailure
          ? await ensureFresh(r.providerId, r.account, r, sch.proxy as ProxyConfig | undefined)
          : {
              account: r.account,
              expiresAt: r.expiresAt,
              updatedAt: r.updatedAt,
              healthy: !hasCredentialFailure,
              credentialFailed: hasCredentialFailure,
            };
      const { credentialFailed, ...freshView } = fresh;
      const modelsMode = resolveAccountModelsMode(r.providerId, sch);
      let discovered: { available: string[]; entitled: string[] };
      if (options.refresh && modelsMode === "auto" && fresh.healthy) {
        discovered = await discoverAccountModels(
          r.providerId,
          r.account,
          sch,
          options.forceRefresh,
        );
      } else if (r.providerId === XAI) {
        // Runtime synthesis deliberately bypasses the generic string cache for xAI:
        // catalog id, wire model, and per-model request defaults are inseparable.
        // Cached Providers status must project that same validated structured LKG,
        // otherwise it can show stale/empty models while the live pool and Lane
        // picker correctly expose the account.
        const cached = (sch.xaiDiscoveredModels ?? [])
          .filter(isRoutableXaiOAuthModel)
          .map((model) => model.id);
        discovered = { available: cached, entitled: cached };
      } else if (r.providerId === CODEX) {
        const cached = await codexCatalogModels(r.account);
        discovered = { available: cached?.visible ?? [], entitled: cached?.entitled ?? [] };
      } else if (modelsMode === "auto") {
        const cached = modelDiscoveryCache.snapshot({
          providerId: r.providerId,
          account: r.account,
        });
        discovered = { available: cached ?? [], entitled: cached ?? [] };
      } else {
        discovered = { available: [], entitled: [] };
      }
      const models = enabledAccountModels(r.providerId, sch, discovered);
      const identity = await statusCodexIdentity(deps.store, deps.encKey, r.providerId, r.account);
      return {
        providerId: r.providerId,
        ...freshView,
        credentialFailed,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
        ...(identity.accountId ? { chatgptAccountId: identity.accountId } : {}),
        ...(typeof identity.isFedramp === "boolean" ? { isFedramp: identity.isFedramp } : {}),
        priority: sch.priority ?? 50,
        schedulable: credentialFailed ? false : (sch.schedulable ?? true),
        autoReset: sch.autoReset ?? false,
        allowSpendRemainingCredits: sch.allowSpendRemainingCredits ?? false,
        fastMode: sch.fastMode ?? false,
        proxy: redactProxy(sch.proxy),
        models,
      };
    };
    const refreshed: Array<Awaited<ReturnType<typeof project>>> = [];
    if (options.serial) {
      for (const row of rows) refreshed.push(await project(row));
    } else {
      refreshed.push(...(await Promise.all(rows.map(project))));
    }
    const accountsFor = (id: string) =>
      refreshed.filter((x) => x.providerId === id).map(({ providerId: _p, ...rest }) => rest);
    return {
      selectionStrategy: globalSettings.selectionStrategy ?? "balanced",
      providers: [
        {
          id: ANTHROPIC,
          name: "Anthropic (Claude Pro/Max)",
          flow: "manual_paste",
          accounts: accountsFor(ANTHROPIC),
        },
        {
          id: CODEX,
          name: "ChatGPT Plus/Pro (Codex)",
          flow: "manual_paste",
          accounts: accountsFor(CODEX),
        },
        {
          id: COPILOT,
          name: "GitHub Copilot",
          flow: "device_code",
          accounts: accountsFor(COPILOT),
        },
        {
          id: XAI,
          name: "xAI (SuperGrok/X Premium) · Experimental",
          flow: "device_code",
          accounts: accountsFor(XAI),
        },
      ],
    };
  }

  return {
    async listCachedStatus(): Promise<OAuthAdminStatusResponse> {
      return buildStatus({ refresh: false, forceRefresh: false, serial: false });
    },

    async listStatus(options = {}): Promise<OAuthAdminStatusResponse> {
      return buildStatus({
        refresh: true,
        forceRefresh: options.forceRefresh === true,
        serial: options.serial === true,
      });
    },

    async startManualPaste({ providerId, proxy }) {
      const flow = MANUAL_FLOWS[providerId];
      if (!flow) {
        throw new Error(`provider '${providerId}' does not support the manual-paste flow`);
      }
      ensureSessionCapacity();
      // Validate the proxy up-front (fail-closed) and pin it to the session. begin()
      // is a pure URL build (no network), so the only flow call that egresses — the
      // token exchange in complete — already has the proxy.
      const pinned = toProxy(proxy);
      const { authorizeUrl, verifier, state } = flow.begin();
      const sessionId = genId();
      sessions.set(sessionId, {
        kind: "manual",
        providerId,
        verifier,
        state,
        proxy: pinned,
        createdAt: now(),
      });
      return { sessionId, authorizeUrl };
    },

    async completeManualPaste({ sessionId, redirectInput, account }) {
      const s = take(sessionId);
      if (s.kind !== "manual") throw new Error("wrong flow for this session");
      const flow = MANUAL_FLOWS[s.providerId];
      if (!flow)
        throw new Error(`provider '${s.providerId}' does not support the manual-paste flow`);
      // Token exchange tunnels through the session's proxy — never the real IP.
      const creds = await flow.complete(
        { redirectInput, verifier: s.verifier, state: s.state },
        makeFetch(s.proxy),
      );
      // Persist the proxy BEFORE the token (fail-closed ordering): if the settings
      // write fails, the token is NOT bound, so the operator retries rather than
      // ending up with an account routed directly despite picking a proxy. A token
      // write that fails afterward leaves only an orphan proxy setting (no token =
      // not routable) — harmless, and overwritten by the next successful bind.
      await persistProxy(s.providerId, account, s.proxy);
      await persist(s.providerId, account, creds);
      await clearAccountCredentialFailure(deps.config, deps.encKey, s.providerId, account);
      sessions.delete(sessionId);
    },

    async startDeviceCode({ providerId, enterprise, proxy }) {
      if (providerId !== COPILOT && providerId !== XAI) {
        throw new Error(`provider '${providerId}' does not support the device-code flow`);
      }
      ensureSessionCapacity();
      pendingDeviceStarts += 1;
      try {
        // CRITICAL: the device-code POST is the FIRST network call of the flow. Build
        // the proxy fetch BEFORE it so step 1 never leaves from the operator's real IP.
        const pinned = toProxy(proxy);
        const doFetch = makeFetch(pinned);
        const start =
          providerId === XAI
            ? await beginXaiDeviceLogin(doFetch, now)
            : await beginCopilotDeviceLogin(enterprise, doFetch);
        const sessionId = genId();
        sessions.set(sessionId, {
          kind: "device",
          providerId,
          deviceCode: start.deviceCode,
          ...(providerId === XAI
            ? { tokenEndpoint: (start as XaiDeviceStart).tokenEndpoint }
            : {
                domain: (start as CopilotDeviceStart).domain,
                enterpriseDomain: (start as CopilotDeviceStart).enterpriseDomain,
              }),
          proxy: pinned,
          createdAt: now(),
          expiresAt: start.expiresAt,
        });
        return {
          sessionId,
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          intervalMs: start.intervalMs,
          expiresAt: start.expiresAt,
          // The browser converts the absolute upstream expiry into a relative TTL
          // using this same-clock reference. Browser and gateway clocks need not agree.
          serverNowMs: now(),
        };
      } finally {
        pendingDeviceStarts -= 1;
      }
    },

    async pollDeviceCode({ sessionId, account }) {
      const s = take(sessionId);
      if (s.kind !== "device") throw new Error("wrong flow for this session");
      const doFetch = makeFetch(s.proxy);
      if (s.providerId === XAI) {
        if (!s.tokenEndpoint) throw new Error("xAI OAuth session is missing its token endpoint");
        const xai = await pollXaiDeviceOnce(
          { tokenEndpoint: s.tokenEndpoint, deviceCode: s.deviceCode },
          doFetch,
          now,
        );
        if (xai.status !== "done") return { status: xai.status };
        await persistProxy(s.providerId, account, s.proxy);
        await persist(s.providerId, account, xai.credentials);
        await clearAccountCredentialFailure(deps.config, deps.encKey, s.providerId, account);
        sessions.delete(sessionId);
        return { status: "done" };
      }
      if (!s.domain) throw new Error("Copilot device session is missing its domain");
      const result = await pollCopilotDeviceOnce(
        { domain: s.domain, deviceCode: s.deviceCode },
        doFetch,
      );
      if (result.status !== "done") return { status: result.status };
      // Copilot-token mint also tunnels through the session proxy.
      const creds = await refreshGitHubCopilotToken(
        result.githubToken,
        s.enterpriseDomain,
        doFetch,
      );
      // Proxy BEFORE token (fail-closed ordering — see completeManualPaste): the
      // account is never bound without its proxy, so it can't later route directly.
      await persistProxy(s.providerId, account, s.proxy);
      await persist(s.providerId, account, creds);
      await clearAccountCredentialFailure(deps.config, deps.encKey, s.providerId, account);
      sessions.delete(sessionId);
      return { status: "done" };
    },

    async logout({ providerId, account }) {
      await deps.store.delete(providerId, account);
      // Invalidate immediately after the credential delete succeeds. A later
      // settings cleanup failure must not leave quota attached to a logged-out
      // identity or a future same-name reconnect.
      invalidateQuotaCache(providerId, account);
      await clearAccountSettings(deps.config, deps.encKey, providerId, account);
      modelDiscoveryCache.invalidate({ providerId, account });
    },

    async listModels({ providerId, account }) {
      // Load settings once: the proxy drives BOTH the token refresh and the live
      // model discovery through the account's hop; enabledModels seeds `enabled`.
      const settings = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        providerId,
        account,
      );
      const discovered = await discoverAccountModels(providerId, account, settings);
      // `available` is account discovery plus verified xAI media aliases — only
      // SUGGESTIONS to seed from.
      // In manual mode `enabled` is the operator's AUTHORITATIVE list (verbatim,
      // NOT intersected), so a custom id survives stale discovery. In auto mode it
      // is the exact discovery projection; runtime composition separately retains
      // its curated fail-open safety net.
      const modelsMode = resolveAccountModelsMode(providerId, settings);
      const enabled = enabledAccountModels(providerId, settings, discovered);
      // `canPull` tells the UI whether account-scoped model refresh is meaningful.
      return {
        available: withXaiMediaModels(providerId, discovered.available),
        enabled,
        modelsMode,
        canPull: hasLiveModelDiscovery(providerId),
      };
    },

    async setEnabledModels({ providerId, account, mode, models }) {
      await setAccountSettings(deps.config, deps.encKey, providerId, account, {
        modelsMode: mode,
        enabledModels: mode === "manual" ? models : undefined,
      });
    },

    async getAccountProxy({ providerId, account }): Promise<AccountProxyView | null> {
      // REDACT the password (principle 7): the admin read surface returns only
      // whether one is set, never the secret itself. Shared with listStatus.
      return redactProxy(
        getAccountSettings(await loadAccountSettings(deps.config, deps.encKey), providerId, account)
          .proxy,
      );
    },

    async setAccountProxy({ providerId, account, proxy }): Promise<void> {
      if (proxy === null) {
        // Clear: revert to a direct connection. setAccountSettings does a top-level
        // merge, so patching `proxy: undefined` overwrites just that field (JSON
        // drops the undefined key) while curation/pool state survive.
        await setAccountSettings(deps.config, deps.encKey, providerId, account, {
          proxy: undefined,
        });
        modelDiscoveryCache.invalidate({ providerId, account });
        return;
      }
      // An OMITTED password on an update preserves the stored one (so the operator
      // can edit host/port without re-entering the secret); an explicit empty string
      // clears it. Resolve the effective password BEFORE validating + persisting.
      const prior = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        providerId,
        account,
      ).proxy;
      const password = proxy.password !== undefined ? proxy.password : prior?.password;
      const next: ProxyConfig = {
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        ...(proxy.username !== undefined ? { username: proxy.username } : {}),
        ...(password !== undefined && password !== "" ? { password } : {}),
      };
      // Fail-closed (principle 2): reject a malformed proxy here, never persist it.
      validateProxyConfig(next);
      await setAccountSettings(deps.config, deps.encKey, providerId, account, { proxy: next });
      modelDiscoveryCache.invalidate({ providerId, account });
    },

    async getAccountSchedule({ providerId, account }): Promise<AccountScheduleView> {
      const s = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        providerId,
        account,
      );
      // Apply the scheduler defaults so the UI always shows a concrete value
      // (priority 50, schedulable true, autoReset false) even for a never-tuned account.
      return {
        priority: s.priority ?? 50,
        schedulable: typeof s.credentialFailedAt === "number" ? false : (s.schedulable ?? true),
        autoReset: s.autoReset ?? false,
        allowSpendRemainingCredits: s.allowSpendRemainingCredits ?? false,
        fastMode: s.fastMode ?? false,
      };
    },

    async setAccountSchedule({
      providerId,
      account,
      priority,
      schedulable,
      autoReset,
      allowSpendRemainingCredits,
      fastMode,
    }): Promise<void> {
      if (schedulable === true) {
        const current = getAccountSettings(
          await loadAccountSettings(deps.config, deps.encKey),
          providerId,
          account,
        );
        if (typeof current.credentialFailedAt === "number") {
          throw new Error("account needs reconnect before it can be scheduled");
        }
      }
      // Top-level merge (setAccountSettings) preserves curation/proxy. Only patch
      // the fields the caller supplied — an omitted field stays unchanged.
      const patch: {
        priority?: number;
        schedulable?: boolean;
        autoReset?: boolean;
        allowSpendRemainingCredits?: boolean;
        fastMode?: boolean;
        autoDisabledForCredentialFailure?: boolean;
      } = {};
      if (priority !== undefined) patch.priority = priority;
      if (schedulable !== undefined) patch.schedulable = schedulable;
      if (schedulable !== undefined) patch.autoDisabledForCredentialFailure = false;
      if (autoReset !== undefined) patch.autoReset = autoReset;
      if (allowSpendRemainingCredits !== undefined) {
        patch.allowSpendRemainingCredits = allowSpendRemainingCredits;
      }
      if (fastMode !== undefined) patch.fastMode = fastMode;
      await setAccountSettings(deps.config, deps.encKey, providerId, account, patch);
    },

    async getSelectionStrategy(): Promise<AccountPoolStrategyView> {
      const s = await loadGlobalOAuthSettings(deps.config, deps.encKey);
      return { selectionStrategy: s.selectionStrategy ?? "balanced" };
    },

    async setSelectionStrategy({ selectionStrategy }): Promise<void> {
      await setGlobalOAuthSettings(deps.config, deps.encKey, { selectionStrategy });
    },

    async fetchAnthropicQuota({ account, force = false }): Promise<OAuthQuotaWindow[] | null> {
      // Serve from the 5-min cache when warm — INCLUDING a cached failure (null) —
      // so reopening the providers page or saving an account setting never re-hits
      // the upstream usage endpoint, which itself rate-limits aggressively. Refresh
      // is therefore page-open-driven AND debounced to at most once per TTL.
      const key = `${ANTHROPIC}${" "}${account}`;
      const cached = quotaCache.get(key);
      if (!force && cached && now() - cached.at < QUOTA_TTL_MS) return cached.windows;
      const epoch = quotaCacheEpoch.get(key) ?? 0;
      const provider = getOAuthProvider(ANTHROPIC);
      if (!provider) return null;
      let windows: OAuthQuotaWindow[] | null = null;
      try {
        // The account's egress proxy is reused for BOTH the token refresh and the
        // usage call — network-identity consistency (anti-ban) AND no real-IP leak.
        const proxy = getAccountSettings(
          await loadAccountSettings(deps.config, deps.encKey),
          ANTHROPIC,
          account,
        ).proxy as ProxyConfig | undefined;
        const doFetch = makeFetch(proxy);
        // Same lazy-refresh token manager the execution path uses, so the bearer is
        // fresh; its refresh tunnels through the same proxy.
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId: ANTHROPIC, account },
          tokenStore: deps.store,
          encKey: deps.encKey,
          oauthProvider: provider,
          fetch: doFetch,
          now,
        });
        const authorization = await tm.getAuthHeader(); // "Bearer <access>"
        // Bounded timeout (fail-open): a slow proxy/upstream must NOT hang the
        // providers page — the AbortSignal trips the catch below, leaving `windows`
        // null so the page renders the stored/empty snapshot instead of stalling.
        const res = await doFetch(ANTHROPIC_USAGE_URL, {
          headers: { ...ANTHROPIC_USAGE_HEADERS, authorization },
          signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          const body = await readBoundedJsonResponse(res, OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES);
          windows = parseAnthropicUsageBody(body, now());
          // A 200 that yields ZERO windows means the schema rejected the body (or
          // it carried no windows at all) — the upsert is skipped and the stored
          // snapshot silently goes stale. Warn so the next shape drift is visible
          // in logs instead of frozen percentages (no body content — principle 7).
          if (windows.length === 0) {
            log("warn", "oauth.quota.pull_empty", { provider_id: ANTHROPIC, account });
          }
        } else {
          await res.body?.cancel().catch(() => {}); // 429/4xx/5xx → cache the miss
          log("warn", "oauth.quota.pull_failed", {
            provider_id: ANTHROPIC,
            account,
            status: res.status,
          });
        }
      } catch (e) {
        windows = null; // dead token / network / malformed body → page renders "—"
        log("warn", "oauth.quota.pull_failed", {
          provider_id: ANTHROPIC,
          account,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // Cache the outcome (success OR failure) so the next page open within the TTL
      // is served from memory rather than re-hitting the rate-limited endpoint.
      if ((quotaCacheEpoch.get(key) ?? 0) !== epoch) return null;
      quotaCache.set(key, { at: now(), windows });
      return windows;
    },

    async fetchXaiQuota({ account, force = false }): Promise<OAuthQuotaWindow[] | null> {
      const key = `${XAI} ${account}`;
      const cached = quotaCache.get(key);
      if (!force && cached && now() - cached.at < QUOTA_TTL_MS) return cached.windows;
      const epoch = quotaCacheEpoch.get(key) ?? 0;
      const provider = getOAuthProvider(XAI);
      if (!provider) return null;

      let windows: OAuthQuotaWindow[] | null = null;
      try {
        const proxy = getAccountSettings(
          await loadAccountSettings(deps.config, deps.encKey),
          XAI,
          account,
        ).proxy as ProxyConfig | undefined;
        const doFetch = makeFetch(proxy);
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId: XAI, account },
          tokenStore: deps.store,
          encKey: deps.encKey,
          oauthProvider: provider,
          fetch: doFetch,
          now,
        });
        const authorization = await tm.getAuthHeader();
        const userId = identityString(tm.currentMetadata().accountId);
        if (!userId) throw new Error("xAI OAuth credential is missing its user id");
        const res = await doFetch(XAI_GROK_CREDITS_URL, {
          method: "GET",
          headers: {
            ...XAI_GROK_CREDITS_HEADERS,
            authorization,
            "x-userid": userId,
            "x-grok-client-version": resolveXaiGrokClientVersion(),
          },
          redirect: "error",
          signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          const body = await readBoundedJsonResponse(res, OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES);
          windows = parseXaiGrokCreditsResponse(body, now());
          if (windows.length === 0) {
            log("warn", "oauth.quota.pull_empty", { provider_id: XAI, account });
          }
        } else {
          await res.body?.cancel().catch(() => {});
          log("warn", "oauth.quota.pull_failed", {
            provider_id: XAI,
            account,
            status: res.status,
          });
        }
      } catch (e) {
        windows = null;
        log("warn", "oauth.quota.pull_failed", {
          provider_id: XAI,
          account,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if ((quotaCacheEpoch.get(key) ?? 0) !== epoch) return null;
      quotaCache.set(key, { at: now(), windows });
      return windows;
    },

    async getCachedCodexQuota({ account }): Promise<CodexQuotaResult> {
      return cachedCodexQuota(account);
    },

    async fetchCodexQuota({ account, force = false }): Promise<CodexQuotaResult> {
      // Twin of fetchAnthropicQuota above — same 5-min cache (success AND failure),
      // same bounded timeout, same per-account proxy reuse. Codex-specific bits:
      // the endpoint keys on `chatgpt-account-id` (decoded from the access-token
      // JWT, exactly like the execution path in core/provider/openai-responses).
      // Returns windows AND the available reset-credit count (both parsed off the
      // one PULL) so the providers page can render quota + enable the reset button.
      const key = `${CODEX} ${account}`;
      const cached = quotaCache.get(key);
      if (!force && cached && now() - cached.at < QUOTA_TTL_MS) return cachedCodexQuota(account);
      const epoch = quotaCacheEpoch.get(key) ?? 0;
      const provider = getOAuthProvider(CODEX);
      if (!provider) return null;
      let windows: OAuthQuotaWindow[] | null = null;
      let additionalLimits: CodexAdditionalLimitView[] = [];
      let resetCredits: number | null = null;
      let resetCreditDetails: CodexResetCreditDetailView[] | null = null;
      let credits: CodexCreditsView | null = null;
      let individualLimit: CodexIndividualLimitView | null = null;
      let planType: string | null = null;
      let rateLimitReachedType: CodexRateLimitReachedType | null = null;
      try {
        const proxy = getAccountSettings(
          await loadAccountSettings(deps.config, deps.encKey),
          CODEX,
          account,
        ).proxy as ProxyConfig | undefined;
        const doFetch = makeFetch(proxy);
        const tm = createTokenManager({
          oauth: { kind: "preset", providerId: CODEX, account },
          tokenStore: deps.store,
          encKey: deps.encKey,
          oauthProvider: provider,
          fetch: doFetch,
          now,
        });
        const authorization = await tm.getAuthHeader(); // "Bearer <access>"
        const accessToken = authorization.replace(/^Bearer\s+/i, "");
        const identity = mergeCodexIdentity(accessToken, tm.currentMetadata());
        const headers = {
          ...CODEX_USAGE_HEADERS,
          authorization,
          ...(identity.accountId ? { "chatgpt-account-id": identity.accountId } : {}),
          ...(identity.isFedramp === true ? { "X-OpenAI-Fedramp": "true" } : {}),
        };
        const [res, detailsRes] = await Promise.all([
          doFetch(CODEX_USAGE_URL, {
            headers,
            signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
          }),
          doFetch(CODEX_RESET_DETAILS_URL, {
            headers,
            signal: AbortSignal.timeout(RESET_CREDIT_DETAILS_TIMEOUT_MS),
          }).catch(() => null),
        ]);
        if (res.ok) {
          const body = await readBoundedJsonResponse(res, OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES);
          const quota = parseCodexQuotaDetails(body, now());
          windows = quota?.windows ?? [];
          additionalLimits = quota?.additionalLimits ?? [];
          resetCredits = parseCodexResetCredits(body); // null when the grant is absent
          credits = quota?.credits ?? null;
          individualLimit = quota?.individualLimit ?? null;
          planType = quota?.planType ?? null;
          rateLimitReachedType = quota?.rateLimitReachedType ?? null;
          if (detailsRes?.ok) {
            const detailsBody = await readBoundedJsonResponse(
              detailsRes,
              OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES,
            ).catch(() => null);
            const details = codexResetCreditDetails(detailsBody);
            if (details) {
              resetCredits = details.availableCount;
              resetCreditDetails = details.credits;
            }
          } else {
            await detailsRes?.body?.cancel().catch(() => {});
          }
          // Same tripwire as the Anthropic PULL: a 200 yielding zero windows would
          // otherwise freeze the stored snapshot silently.
          if (windows.length === 0) {
            log("warn", "oauth.quota.pull_empty", { provider_id: CODEX, account });
          }
        } else {
          await res.body?.cancel().catch(() => {}); // 429/4xx/5xx → cache the miss
          log("warn", "oauth.quota.pull_failed", {
            provider_id: CODEX,
            account,
            status: res.status,
          });
        }
      } catch (e) {
        windows = null; // dead token / network / malformed body → page renders "—"
        additionalLimits = [];
        resetCredits = null;
        resetCreditDetails = null;
        credits = null;
        individualLimit = null;
        planType = null;
        rateLimitReachedType = null;
        log("warn", "oauth.quota.pull_failed", {
          provider_id: CODEX,
          account,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if ((quotaCacheEpoch.get(key) ?? 0) !== epoch) return null;
      quotaCache.set(key, {
        at: now(),
        windows,
        additionalLimits,
        resetCredits,
        resetCreditDetails,
        credits,
        individualLimit,
        planType,
        rateLimitReachedType,
      });
      if (windows === null) return null;
      const result = {
        windows,
        additionalLimits,
        resetCredits,
        resetCreditDetails,
        credits,
        individualLimit,
        planType,
        rateLimitReachedType,
      };
      return result;
    },

    async consumeCodexResetCredit(input: {
      account: string;
      creditId?: string;
      idempotencyKey?: string;
    }): Promise<CodexResetCreditResult> {
      const { account, creditId, idempotencyKey } = input;
      if (creditId !== undefined && creditId.length === 0) {
        throw new Error("creditId must not be empty");
      }
      if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
        throw new Error("idempotencyKey must not be empty");
      }
      // The "reset usage limit" operator action: spend one rate-limit reset credit
      // to immediately restore the account's windows. Mirrors fetchCodexQuota's
      // setup (per-account proxy + preset token manager + chatgpt-account-id), but
      // is FAIL-CLOSED — a mutation must THROW on failure so the route surfaces an
      // error to the operator (the PULL is fail-open; this is not).
      const provider = getOAuthProvider(CODEX);
      if (!provider) throw new Error("openai-codex OAuth is not configured");
      const proxy = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        CODEX,
        account,
      ).proxy as ProxyConfig | undefined;
      const doFetch = makeFetch(proxy);
      const tm = createTokenManager({
        oauth: { kind: "preset", providerId: CODEX, account },
        tokenStore: deps.store,
        encKey: deps.encKey,
        oauthProvider: provider,
        fetch: doFetch,
        now,
      });
      const authorization = await tm.getAuthHeader(); // "Bearer <access>"
      const accessToken = authorization.replace(/^Bearer\s+/i, "");
      const identity = mergeCodexIdentity(accessToken, tm.currentMetadata());
      const redeemRequestId = idempotencyKey ?? randomUUID();
      const res = await doFetch(CODEX_RESET_URL, {
        method: "POST",
        headers: {
          ...CODEX_USAGE_HEADERS,
          authorization,
          "content-type": "application/json",
          ...(identity.accountId ? { "chatgpt-account-id": identity.accountId } : {}),
          ...(identity.isFedramp === true ? { "X-OpenAI-Fedramp": "true" } : {}),
        },
        body: JSON.stringify({
          redeem_request_id: redeemRequestId,
          ...(creditId === undefined ? {} : { credit_id: creditId }),
        }),
        signal: AbortSignal.timeout(RESET_CREDIT_CONSUME_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {}); // never log/echo the body (principle 7)
        log("warn", "oauth.reset_credit.failed", {
          provider_id: CODEX,
          account,
          status: res.status,
          redeem_request_id: redeemRequestId,
        });
        throw new Error(`codex reset-credit consume failed (status ${res.status})`);
      }
      const body = await readBoundedJsonResponse(res, OAUTH_OPERATOR_JSON_MAX_RESPONSE_BYTES).catch(
        () => null,
      );
      const result = parseCodexResetResult(body);
      if (result.outcome === null) {
        log("warn", "oauth.reset_credit.failed", {
          provider_id: CODEX,
          account,
          redeem_request_id: redeemRequestId,
          error: "unrecognized consume response",
        });
        throw new Error("codex reset-credit consume returned an unrecognized response");
      }
      const consumed = result.outcome === "reset" || result.outcome === "alreadyRedeemed";
      log("info", consumed ? "oauth.reset_credit.consumed" : "oauth.reset_credit.not_consumed", {
        provider_id: CODEX,
        account,
        redeem_request_id: redeemRequestId,
        code: result.code,
        outcome: result.outcome,
        windows_reset: result.windowsReset,
      });
      // The consume restored the windows AND decremented the credit count. The grant is
      // keyed by the upstream ChatGPT account (chatgpt_account_id), which can back
      // SEVERAL connected helm accounts — so a single consume resets every sibling that
      // shares the login. Bust EVERY codex quota entry (not just this account's) so each
      // sibling re-pulls its now-reset windows + decremented count on the next /quota
      // read, instead of showing a stale saturated snapshot for up to the cache TTL.
      // (Anthropic keys use a different prefix and are untouched.) Snapshot the keys
      // first to avoid mutating the Map mid-iteration.
      for (const key of [...quotaCache.keys()]) {
        if (key.startsWith(`${CODEX} `)) {
          invalidateQuotaCache(CODEX, key.slice(CODEX.length + 1));
        }
      }
      return {
        code: result.code,
        outcome: result.outcome,
        windowsReset: result.windowsReset,
        redeemRequestId,
      };
    },
  };
}
