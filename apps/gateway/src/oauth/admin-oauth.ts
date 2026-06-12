import { randomUUID } from "node:crypto";
import {
  beginAnthropicLogin,
  beginCopilotDeviceLogin,
  beginOpenAICodexLogin,
  type ConfigStore,
  type CopilotDeviceStart,
  codexAccountIdFromToken,
  completeAnthropicLogin,
  completeOpenAICodexLogin,
  createTokenManager,
  discoverOAuthModels,
  encryptSecret,
  getOAuthProvider,
  hasLiveModelDiscovery,
  makeProxyFetch,
  type OAuthCredentials,
  type OAuthTokenStore,
  type ProxyConfig,
  parseAnthropicUsageBody,
  parseCodexUsageBody,
  pollCopilotDeviceOnce,
  refreshGitHubCopilotToken,
  validateProxyConfig,
} from "@helm/core";
import type { OAuthQuotaWindow } from "@helm/shared";
import type {
  AccountProxyInput,
  AccountProxyView,
  AccountScheduleView,
  OAuthAdminAccess,
  OAuthAdminStatus,
} from "../routes/admin/deps.js";
import { getAccountSettings, loadAccountSettings, setAccountSettings } from "./account-settings.js";
import { effectiveAccountModels } from "./effective-models.js";

// Admin OAuth-login orchestration (issue #38) — the implementation behind the
// OAuthAdminAccess seam the /admin/api/oauth routes call. Owns the ephemeral
// per-login session state (PKCE verifier/state for Anthropic; device code/domain
// for Copilot), the upstream exchange (via the core OAuth kit), at-rest
// ENCRYPTION (token-cipher), and the OAuthTokenStore write-back.
//
// SECURITY (principle 7): the encryption key is resolved at the composition root
// and handed in as a Buffer (never an env name here). Sessions live in memory only
// and hold short-lived flow state, never a long-lived secret beyond the login.

const ANTHROPIC = "anthropic";
const COPILOT = "github-copilot";
const CODEX = "openai-codex";
const SESSION_TTL_MS = 15 * 60 * 1000;

// Anthropic OAuth usage endpoint (providers page Tier 3 quota PULL). Mirrors the
// claude-relay-service reference: the `oauth-2025-04-20` beta flag + a claude-cli
// User-Agent gate the endpoint (a generic UA is rejected). Cached per account for 5
// min so a page refresh never hammers it (the upstream itself rate-limits this).
const QUOTA_TTL_MS = 5 * 60 * 1000;
// Hard ceiling on the usage-endpoint fetch so a hung proxy/upstream never blocks the
// providers page (the route is fail-open; this bounds the worst case).
const QUOTA_FETCH_TIMEOUT_MS = 8_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
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
      domain: string;
      enterpriseDomain?: string;
      proxy?: ProxyConfig;
      createdAt: number;
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
  log?: (level: "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
}

// Split a credential into store fields. `meta` carries every key beyond the
// canonical {access, refresh, expires} (e.g. copilot enterpriseUrl).
function metaFrom(creds: OAuthCredentials): string | null {
  const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

export function createOAuthAdmin(deps: OAuthAdminDeps): OAuthAdminAccess {
  const now = deps.now ?? (() => Date.now());
  const genId = deps.genSessionId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});
  // Resolve the egress fetch for a (possibly absent) proxy. ONE place so the whole
  // flow — begin/complete/poll + token-manager refresh + quota — egresses alike.
  const makeFetch =
    deps.makeFetch ?? ((proxy?: ProxyConfig) => (proxy ? makeProxyFetch(proxy) : fetch));
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
      | { type: "http" | "https" | "socks5"; host: string; port: number; username?: string; password?: string }
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
  // Per-account Anthropic quota cache (5-min TTL): key `anthropic <account>`.
  // Caches the OUTCOME of a usage fetch — windows on success, `null` on failure —
  // so a rate-limited/erroring endpoint is NOT retried until the TTL lapses
  // (negative caching). The providers page is the only caller and triggers this on
  // page open / after an account action; there is no background poll.
  const quotaCache = new Map<string, { at: number; windows: OAuthQuotaWindow[] | null }>();

  function prune(): void {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
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
    await deps.store.upsert({
      providerId,
      account,
      accessEnc: encryptSecret(creds.access, deps.encKey),
      refreshEnc: encryptSecret(creds.refresh, deps.encKey),
      expiresAt: creds.expires,
      meta: metaFrom(creds),
      updatedAt: now(),
    });
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
  ): Promise<{ account: string; expiresAt: number | null; updatedAt: number; healthy: boolean }> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return { account, ...stored, healthy: true };
    const tm = createTokenManager({
      oauth: { kind: "preset", providerId, account },
      tokenStore: deps.store,
      encKey: deps.encKey,
      oauthProvider: provider,
      fetch: makeFetch(proxy),
      now,
    });
    let healthy = true;
    try {
      await tm.getAuthHeader(); // refresh-if-expired + write back; no-op when fresh
    } catch {
      healthy = false; // refresh-token / durable credential is dead → needs re-login
    }
    const r = await deps.store.get(providerId, account);
    return {
      account,
      expiresAt: r?.expiresAt ?? stored.expiresAt,
      updatedAt: r?.updatedAt ?? stored.updatedAt,
      healthy,
    };
  }

  return {
    async listStatus(): Promise<OAuthAdminStatus[]> {
      const rows = await deps.store.list();
      // Load the per-account settings blob ONCE for the whole page (a single decrypt)
      // so the list carries each account's effective priority + schedulable without an
      // N+1 per-account GET. Fail-open to {} (defaults applied below).
      const settings = await loadAccountSettings(deps.config, deps.encKey);
      // Ensure-fresh every stored account in parallel so the page reflects live,
      // auto-renewed expiries (and surfaces a dead credential as unhealthy).
      const refreshed = await Promise.all(
        rows.map(async (r) => {
          // Same defaults as getAccountSchedule (priority 50, schedulable true) so a
          // never-tuned account always renders a concrete value.
          const sch = getAccountSettings(settings, r.providerId, r.account);
          return {
            providerId: r.providerId,
            ...(await ensureFresh(
              r.providerId,
              r.account,
              r,
              sch.proxy as ProxyConfig | undefined,
            )),
            priority: sch.priority ?? 50,
            schedulable: sch.schedulable ?? true,
            // Both folded from the SAME settings blob (zero extra network): the
            // redacted egress proxy (principle 7) and the effective routable models
            // — the SAME network-free set synthesizeOAuthProviders exposes to Lanes
            // (operator curation verbatim, else the curated fallback). Live discovery
            // stays in the Manage dialog; the list never fans out per account.
            proxy: redactProxy(sch.proxy),
            models: effectiveAccountModels(sch, r.providerId),
          };
        }),
      );
      const accountsFor = (id: string) =>
        refreshed.filter((x) => x.providerId === id).map(({ providerId: _p, ...rest }) => rest);
      return [
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
      ];
    },

    async startManualPaste({ providerId, proxy }) {
      const flow = MANUAL_FLOWS[providerId];
      if (!flow) {
        throw new Error(`provider '${providerId}' does not support the manual-paste flow`);
      }
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
      sessions.delete(sessionId);
    },

    async startDeviceCode({ providerId, enterprise, proxy }) {
      if (providerId !== COPILOT) {
        throw new Error(`provider '${providerId}' does not support the device-code flow`);
      }
      // CRITICAL: the device-code POST is the FIRST network call of the flow. Build
      // the proxy fetch BEFORE it so step 1 never leaves from the operator's real IP.
      const pinned = toProxy(proxy);
      const start: CopilotDeviceStart = await beginCopilotDeviceLogin(
        enterprise,
        makeFetch(pinned),
      );
      const sessionId = genId();
      sessions.set(sessionId, {
        kind: "device",
        providerId,
        deviceCode: start.deviceCode,
        domain: start.domain,
        enterpriseDomain: start.enterpriseDomain,
        proxy: pinned,
        createdAt: now(),
      });
      return { sessionId, userCode: start.userCode, verificationUri: start.verificationUri };
    },

    async pollDeviceCode({ sessionId, account }) {
      const s = take(sessionId);
      if (s.kind !== "device") throw new Error("wrong flow for this session");
      const doFetch = makeFetch(s.proxy);
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
      sessions.delete(sessionId);
      return { status: "done" };
    },

    async logout({ providerId, account }) {
      await deps.store.delete(providerId, account);
    },

    async listModels({ providerId, account }) {
      // Load settings once: the proxy drives BOTH the token refresh and the live
      // model discovery through the account's hop; enabledModels seeds `enabled`.
      const settings = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        providerId,
        account,
      );
      const proxy = settings.proxy as ProxyConfig | undefined;
      // Discover the account's available models. Live where an API exists
      // (Copilot GET /models) using the account's REFRESHED access token; curated
      // otherwise. Fail-open: any error (no credential, dead refresh, network)
      // yields [] so the providers page never breaks on a flaky discovery.
      let available: string[] = [];
      const provider = getOAuthProvider(providerId);
      if (provider) {
        try {
          const tm = createTokenManager({
            oauth: { kind: "preset", providerId, account },
            tokenStore: deps.store,
            encKey: deps.encKey,
            oauthProvider: provider,
            fetch: makeFetch(proxy),
            now,
          });
          const accessToken = (await tm.getAuthHeader()).replace(/^Bearer /, "");
          available = await discoverOAuthModels(providerId, accessToken, makeFetch(proxy));
        } catch {
          available = [];
        }
      }
      // `available` is the live/curated discovery — only SUGGESTIONS to seed from.
      // `enabled` is the operator's AUTHORITATIVE list (verbatim, NOT intersected),
      // so a model the operator typed in by hand survives even when discovery is
      // stale / missing it. UNSET ⇒ seed with all available.
      const enabled = settings.enabledModels ?? available;
      // `canPull` tells the UI whether a "pull from provider" action is meaningful:
      // true only where a LIVE list-models API exists (Copilot, Anthropic). Codex
      // has none — its list is curated — so the UI hides the button for it.
      return { available, enabled, canPull: hasLiveModelDiscovery(providerId) };
    },

    async setEnabledModels({ providerId, account, models }) {
      await setAccountSettings(deps.config, deps.encKey, providerId, account, {
        enabledModels: models,
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
    },

    async getAccountSchedule({ providerId, account }): Promise<AccountScheduleView> {
      const s = getAccountSettings(
        await loadAccountSettings(deps.config, deps.encKey),
        providerId,
        account,
      );
      // Apply the scheduler defaults so the UI always shows a concrete value
      // (priority 50, schedulable true) even for a never-tuned account.
      return { priority: s.priority ?? 50, schedulable: s.schedulable ?? true };
    },

    async setAccountSchedule({ providerId, account, priority, schedulable }): Promise<void> {
      // Top-level merge (setAccountSettings) preserves curation/proxy. Only patch
      // the fields the caller supplied — an omitted field stays unchanged.
      const patch: { priority?: number; schedulable?: boolean } = {};
      if (priority !== undefined) patch.priority = priority;
      if (schedulable !== undefined) patch.schedulable = schedulable;
      await setAccountSettings(deps.config, deps.encKey, providerId, account, patch);
    },

    async fetchAnthropicQuota({ account }): Promise<OAuthQuotaWindow[] | null> {
      // Serve from the 5-min cache when warm — INCLUDING a cached failure (null) —
      // so reopening the providers page or saving an account setting never re-hits
      // the upstream usage endpoint, which itself rate-limits aggressively. Refresh
      // is therefore page-open-driven AND debounced to at most once per TTL.
      const key = `${ANTHROPIC}${" "}${account}`;
      const cached = quotaCache.get(key);
      if (cached && now() - cached.at < QUOTA_TTL_MS) return cached.windows;
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
          const body: unknown = await res.json();
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
      quotaCache.set(key, { at: now(), windows });
      return windows;
    },

    async fetchCodexQuota({ account }): Promise<OAuthQuotaWindow[] | null> {
      // Twin of fetchAnthropicQuota above — same 5-min cache (success AND failure),
      // same bounded timeout, same per-account proxy reuse. Codex-specific bits:
      // the endpoint keys on `chatgpt-account-id` (decoded from the access-token
      // JWT, exactly like the execution path in core/provider/openai-responses).
      const key = `${CODEX} ${account}`;
      const cached = quotaCache.get(key);
      if (cached && now() - cached.at < QUOTA_TTL_MS) return cached.windows;
      const provider = getOAuthProvider(CODEX);
      if (!provider) return null;
      let windows: OAuthQuotaWindow[] | null = null;
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
        const accountId = codexAccountIdFromToken(authorization.replace(/^Bearer\s+/i, ""));
        const res = await doFetch(CODEX_USAGE_URL, {
          headers: {
            ...CODEX_USAGE_HEADERS,
            authorization,
            ...(accountId ? { "chatgpt-account-id": accountId } : {}),
          },
          signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          const body: unknown = await res.json();
          windows = parseCodexUsageBody(body, now());
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
        log("warn", "oauth.quota.pull_failed", {
          provider_id: CODEX,
          account,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      quotaCache.set(key, { at: now(), windows });
      return windows;
    },
  };
}
