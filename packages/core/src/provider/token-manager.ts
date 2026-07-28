// OAuth token manager — framework-agnostic (packages/core, principle 1). Caches a
// non-interactive OAuth access token and refreshes it lazily (no background
// timers) when it is missing / expired / explicitly invalidated. Mirrors the
// circuit breaker's single-probe lock (breaker.ts) for refresh single-flight and
// its injected `now` clock for deterministic tests.
//
// SECURITY (principle 7): this module only ever receives ALREADY-RESOLVED plaintext
// secrets (the env→value resolution stays in apps/gateway/src/server.ts). Tokens
// live in memory only and are NEVER logged: TokenRefreshError carries a scrubbed
// message with no token material, and `currentSecrets()` hands the live access +
// refresh tokens to the client's `scrub()` so they can be stripped from any echoed
// upstream error body.
//
// Decisions D1–D3 (see implementation-notes): refresh logic lives here, the 401
// retry trigger lives in the client. CONFIDENTIAL-client grants (PR #43,
// refresh_token / client_credentials) stay in-memory only. PRESET subscription
// grants (issue #38) are persisted to the OAuthTokenStore — encrypted — so a
// rotated refresh token survives restarts.

import { decryptSecret, encryptSecret } from "../store/crypto/token-cipher.js";
import type { OAuthTokenStore } from "../store/ports.js";
import { OpenAICodexIdentityMismatchError } from "./oauth/openai-codex.js";
import { buildOAuthRequestSignal, OAuthHttpError } from "./oauth/runtime.js";
import type { OAuthCredentials, OAuthProviderInterface } from "./oauth/types.js";

// Cross-instance refresh serialization for PRESET credentials. The composition root
// builds MANY TokenManager instances for the SAME (providerId, account) — the
// executor pool, model discovery, the providers-page status refresh, the quota
// scrape, admin connectivity tests — and they all share ONE rotating refresh token
// in the store. Anthropic-style refresh tokens are SINGLE-USE: two instances that
// refresh the same token concurrently make the second replay a consumed token, which
// the upstream rejects (invalid_grant) and often revokes the whole token family →
// the subscription goes permanently dead until a manual re-login. The per-instance
// single-flight lock cannot see across instances, so we serialize every preset
// refresh through one async mutex keyed by (providerId, account), SCOPED to the
// shared store object (WeakMap) so the gate tracks the real shared resource and two
// unrelated stores in a test never collide. Inside the gate each instance RE-READS
// the store, so a sibling's just-rotated token is adopted rather than re-refreshed.
const presetRefreshGates = new WeakMap<OAuthTokenStore, Map<string, Promise<unknown>>>();
let presetRefreshOutstanding = 0;

export function oauthRefreshQueueDepth(): number {
  return presetRefreshOutstanding;
}

function runExclusive<T>(store: OAuthTokenStore, key: string, fn: () => Promise<T>): Promise<T> {
  let gates = presetRefreshGates.get(store);
  if (gates === undefined) {
    gates = new Map();
    presetRefreshGates.set(store, gates);
  }
  // Chain after the previous holder. The stored tail is swallowed so it never
  // rejects — a failed refresh frees the gate for the next waiter instead of
  // wedging the queue.
  const prev = gates.get(key) ?? Promise.resolve();
  const result = prev.then(fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  gates.set(key, tail);
  presetRefreshOutstanding += 1;
  return result.finally(() => {
    presetRefreshOutstanding -= 1;
    if (gates?.get(key) !== tail) return;
    gates.delete(key);
    if (gates.size === 0) presetRefreshGates.delete(store);
  });
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

// CONFIDENTIAL-client OAuth (PR #43): generic token endpoint reached with a
// client SECRET. Already-resolved values (NOT env names — the composition root
// resolves those). `refreshToken` is present for the refresh_token grant. `kind`
// is optional so existing call sites that omit it default to confidential.
export interface ConfidentialOAuth {
  kind?: "confidential";
  grant: "refresh_token" | "client_credentials";
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  scopes: string[];
  audience?: string;
}

// PRESET subscription OAuth (issue #38): a public-client / device flow whose
// refresh wire shape is encapsulated in an OAuthProviderInterface, and whose
// credentials live in the OAuthTokenStore (encrypted) rather than env. The token
// manager delegates refresh to the provider and writes the rotated credential
// back to the store so it survives restarts.
export interface PresetOAuth {
  kind: "preset";
  providerId: string;
  account: string;
}

export type ResolvedOAuth = ConfidentialOAuth | PresetOAuth;

export interface TokenManagerDeps {
  oauth: ResolvedOAuth;
  fetch?: typeof globalThis.fetch;
  /** Injected clock (ms epoch) for deterministic expiry windows in tests. */
  now?: () => number;
  /** Refresh `skew` ms before the reported expiry so a token never expires mid-flight. */
  expirySkewMs?: number;
  /** Internal deadline for the shared refresh fetch. */
  refreshTimeoutMs?: number;
  // ── preset-kind deps (REQUIRED when oauth.kind === "preset") ────────────────
  /** Persistent credential store (read on first use, rotation write-back on refresh). */
  tokenStore?: OAuthTokenStore;
  /** AES key for at-rest encrypt/decrypt of the stored access + refresh tokens. */
  encKey?: Buffer;
  /** The subscription provider whose refresh wire shape + getApiKey is used. */
  oauthProvider?: OAuthProviderInterface;
}

export interface TokenManager {
  /** "Bearer <access-token>"; refreshes first if the token is missing/expired. */
  getAuthHeader(signal?: AbortSignal): Promise<string>;
  /** Live access + refresh tokens, for redaction of echoed upstream bodies. */
  currentSecrets(): string[];
  /** Persisted provider metadata loaded with the current preset credential. */
  currentMetadata(): Readonly<Record<string, unknown>>;
  /** Force the next getAuthHeader() to refresh (e.g. after an upstream 401). */
  invalidate(): void;
}

// Refresh failure. The message is SCRUBBED by construction — it never contains the
// access token, refresh token, or client secret (principle 7). Carries the HTTP
// status (when there was a response) for the caller's diagnostics.
export class TokenRefreshError extends Error {
  readonly httpStatus: number | null;
  readonly permanentCredentialFailure: boolean;
  constructor(
    message: string,
    httpStatus: number | null = null,
    permanentCredentialFailure = false,
  ) {
    super(message);
    this.name = "TokenRefreshError";
    this.httpStatus = httpStatus;
    this.permanentCredentialFailure = permanentCredentialFailure;
  }
}

const DEFAULT_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
// Fallback lifetime when the token endpoint omits expires_in (rare). Short so a
// missing TTL degrades to "refresh often", never "cache a token forever".
const DEFAULT_EXPIRES_IN_S = 3600;

interface TokenEndpointResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const skew = deps.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const refreshTimeoutMs = Math.max(1, deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
  const oauth = deps.oauth;
  const isPreset = oauth.kind === "preset";

  let accessToken: string | null = null;
  let expiresAt = 0; // ms epoch; 0 => no cached token
  // Refresh tokens may ROTATE: the endpoint can hand back a new one each refresh.
  // Confidential: held in memory (D3). Preset: persisted (see doPresetRefresh).
  let refreshToken: string | undefined = isPreset ? undefined : oauth.refreshToken;
  // Single-flight lock: concurrent callers hitting an expired token await the SAME
  // in-flight refresh (mirrors breaker.ts inFlightProbe) so N callers => 1 fetch.
  let refreshing: Promise<void> | null = null;
  // Preset-only: extra credential fields (e.g. copilot `enterpriseUrl`) carried
  // through the store `meta` and re-merged into the provider refresh call.
  let presetExtra: Record<string, unknown> = {};
  let presetLoaded = false;
  let presetLoading: Promise<void> | null = null;
  // Preset-only: invalidate() (an upstream 401) demands a NETWORK refresh even when
  // the stored token still looks unexpired — but ONLY while the store holds the SAME
  // token that was just rejected. `forcedRefresh` carries that intent across the gate
  // re-read; `invalidatedAccess` is the rejected token we must not serve again. If a
  // sibling has meanwhile rotated the credential, the re-read adopts the new token
  // and the forced refresh is satisfied without burning another rotation.
  let forcedRefresh = false;
  let invalidatedAccess: string | null = null;

  // ── preset deps (validated up-front so a misconfig fails CLOSED, principle 2) ─
  if (isPreset) {
    if (!deps.tokenStore || !deps.encKey || !deps.oauthProvider) {
      throw new Error("preset OAuth token manager requires tokenStore + encKey + oauthProvider");
    }
  }

  function buildBody(o: ConfidentialOAuth): URLSearchParams {
    const body = new URLSearchParams();
    body.set("grant_type", o.grant);
    body.set("client_id", o.clientId);
    body.set("client_secret", o.clientSecret);
    if (o.grant === "refresh_token") {
      // refreshToken is guaranteed present for this grant (config refine), but
      // guard anyway so a desync never sends "undefined" on the wire.
      if (refreshToken !== undefined) body.set("refresh_token", refreshToken);
    }
    if (o.scopes.length > 0) body.set("scope", o.scopes.join(" "));
    if (o.audience !== undefined) body.set("audience", o.audience);
    return body;
  }

  async function doRefresh(signal?: AbortSignal): Promise<void> {
    const o = oauth as ConfidentialOAuth;
    let res: Response;
    try {
      res = await doFetch(o.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildBody(o).toString(),
        signal: buildOAuthRequestSignal({ signal, timeoutMs: refreshTimeoutMs }),
      });
    } catch {
      // Network / DNS / abort: never echo the cause (could carry the URL with a
      // secret query — keep it generic; principle 7).
      throw new TokenRefreshError("oauth token request failed (network error)");
    }
    if (!res.ok) {
      // Drain + discard the body: an OAuth error body can echo the credential.
      await res.text().catch(() => "");
      throw new TokenRefreshError(`oauth token request failed (status ${res.status})`, res.status);
    }
    let parsed: TokenEndpointResponse;
    try {
      parsed = (await res.json()) as TokenEndpointResponse;
    } catch {
      throw new TokenRefreshError("oauth token response was not valid JSON", res.status);
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new TokenRefreshError("oauth token response missing access_token", res.status);
    }
    accessToken = parsed.access_token;
    const expiresInS =
      typeof parsed.expires_in === "number" && parsed.expires_in > 0
        ? parsed.expires_in
        : DEFAULT_EXPIRES_IN_S;
    expiresAt = now() + expiresInS * 1000;
    // Rotated refresh token: adopt the new value for subsequent refreshes.
    if (typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0) {
      refreshToken = parsed.refresh_token;
    }
  }

  // Split a credential into store fields. `meta` carries every key beyond the
  // canonical {access, refresh, expires} (e.g. copilot enterpriseUrl).
  function metaFrom(creds: OAuthCredentials): string | null {
    const { access: _a, refresh: _r, expires: _e, idToken: _idToken, ...rest } = creds;
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
  }

  // (Re)load the persisted credential from the store (preset only), decrypting the
  // access + refresh blobs into the in-memory cache. Called once lazily on first use
  // AND again under the refresh gate, so a sibling instance's rotation is adopted
  // instead of re-refreshed. A missing row leaves the current in-memory state intact
  // (never wipes a working token just because the row was deleted out from under us).
  async function loadFromStore(): Promise<void> {
    const p = oauth as PresetOAuth;
    const rec = await deps.tokenStore?.get(p.providerId, p.account);
    if (!rec) return;
    const encKey = deps.encKey as Buffer;
    accessToken = rec.accessEnc ? decryptSecret(rec.accessEnc, encKey) : null;
    refreshToken = rec.refreshEnc ? decryptSecret(rec.refreshEnc, encKey) : undefined;
    expiresAt = rec.expiresAt ?? 0;
    presetExtra = rec.meta ? (JSON.parse(rec.meta) as Record<string, unknown>) : {};
  }

  // First-use load: a still-valid stored token is reused WITHOUT a network refresh
  // after a restart.
  async function ensurePresetLoaded(): Promise<void> {
    if (presetLoaded) return;
    if (presetLoading === null) {
      presetLoading = loadFromStore()
        .then(() => {
          presetLoaded = true;
        })
        .finally(() => {
          presetLoading = null;
        });
    }
    await presetLoading;
  }

  // Preset refresh: delegate the wire shape to the subscription provider, then
  // WRITE THE ROTATED credential back to the store (encrypted) so it survives a
  // restart — the core of why the preset path is persistent (issue #38 / D3).
  async function doPresetRefresh(): Promise<void> {
    await ensurePresetLoaded();
    const p = oauth as PresetOAuth;
    const provider = deps.oauthProvider as OAuthProviderInterface;
    const encKey = deps.encKey as Buffer;
    if (refreshToken === undefined) {
      throw new TokenRefreshError(
        `no stored OAuth credential for ${p.providerId} (run \`helm oauth login ${p.providerId}\`)`,
      );
    }
    let creds: OAuthCredentials;
    try {
      // Forward the manager's fetch (deps.fetch ?? global) so a proxied account
      // refreshes through the SAME egress hop as its execution traffic (issue #38).
      creds = await provider.refreshToken(
        {
          access: accessToken ?? "",
          refresh: refreshToken,
          expires: expiresAt,
          ...presetExtra,
        },
        (input, init) =>
          doFetch(input, {
            ...init,
            signal: buildOAuthRequestSignal({
              signal: init?.signal ?? undefined,
              timeoutMs: refreshTimeoutMs,
            }),
          }),
      );
    } catch (err) {
      // Provider refresh failed — never echo its message (could carry a token), but
      // the numeric HTTP status from the token endpoint IS safe and turns an opaque
      // "refresh failed" into a diagnosable one (e.g. 400 invalid_grant ⇒ re-login;
      // 429 ⇒ rate limited; 5xx ⇒ upstream down).
      const status = err instanceof OAuthHttpError ? err.httpStatus : null;
      const identityMismatch = err instanceof OpenAICodexIdentityMismatchError;
      throw new TokenRefreshError(
        identityMismatch
          ? `oauth refresh identity changed (${p.providerId}); reconnect the account`
          : status === null
            ? `oauth refresh failed (${p.providerId})`
            : `oauth refresh failed (${p.providerId}, status ${status})`,
        status,
        identityMismatch,
      );
    }
    accessToken = provider.getApiKey(creds);
    refreshToken = creds.refresh;
    expiresAt = creds.expires;
    presetExtra = (() => {
      const { access: _a, refresh: _r, expires: _e, idToken: _idToken, ...rest } = creds;
      return rest;
    })();
    await deps.tokenStore?.upsert({
      providerId: p.providerId,
      account: p.account,
      accessEnc: encryptSecret(accessToken, encKey),
      refreshEnc: encryptSecret(refreshToken, encKey),
      expiresAt,
      meta: metaFrom(creds),
      updatedAt: now(),
    });
  }

  function isExpired(): boolean {
    return accessToken === null || now() + skew >= expiresAt;
  }

  // The current in-memory token is still the one a 401 rejected — serving it again
  // would just 401 again, so a forced refresh must proceed.
  function reloadStillRejected(): boolean {
    return invalidatedAccess !== null && accessToken === invalidatedAccess;
  }

  async function ensureFresh(signal?: AbortSignal): Promise<void> {
    if (!isPreset) {
      // Confidential grant: in-memory only, so the per-instance single-flight lock is
      // sufficient (no shared rotating credential to coordinate with siblings).
      if (!isExpired()) return;
      if (refreshing === null) {
        refreshing = doRefresh(signal).finally(() => {
          refreshing = null;
        });
      }
      await waitForSignal(refreshing, signal);
      return;
    }

    // Preset grant: the rotating refresh token is shared across instances via the
    // store, so coordinate through the store-scoped gate (see presetRefreshGates).
    await waitForSignal(ensurePresetLoaded(), signal);
    if (!isExpired() && !forcedRefresh) return;
    // Per-instance single-flight: N concurrent callers of THIS manager coalesce into
    // ONE refresh op (cleared in finally so a later expiry refreshes again, and a
    // failed refresh never poisons the lock). That op then coordinates ACROSS sibling
    // managers via the store-scoped gate inside runPresetRefresh.
    if (refreshing === null) {
      refreshing = runPresetRefresh().finally(() => {
        refreshing = null;
      });
    }
    await waitForSignal(refreshing, signal);
  }

  // Run ONE preset refresh under the cross-instance gate: serialize against sibling
  // managers that share this credential's store row, RE-READ the store first, and hit
  // the network only when the re-read still shows an expired / rejected token — what
  // stops two instances replaying the same single-use rotating refresh token.
  async function runPresetRefresh(): Promise<void> {
    const p = oauth as PresetOAuth;
    const store = deps.tokenStore as OAuthTokenStore;
    await runExclusive(store, `${p.providerId} ${p.account}`, async () => {
      // A sibling may have rotated the credential while we waited for the gate —
      // re-read before deciding so we adopt its token instead of replaying ours.
      await loadFromStore();
      if (!isExpired() && !(forcedRefresh && reloadStillRejected())) {
        // The store already holds a usable, non-rejected token: adopt it, no refresh.
        forcedRefresh = false;
        invalidatedAccess = null;
        return;
      }
      await doPresetRefresh();
      forcedRefresh = false;
      invalidatedAccess = null;
    });
  }

  return {
    async getAuthHeader(signal?: AbortSignal): Promise<string> {
      await ensureFresh(signal);
      return `Bearer ${accessToken}`;
    },
    currentSecrets(): string[] {
      const out: string[] = [];
      if (accessToken !== null) out.push(accessToken);
      if (refreshToken !== undefined) out.push(refreshToken);
      return out;
    },
    currentMetadata(): Readonly<Record<string, unknown>> {
      return { ...presetExtra };
    },
    invalidate(): void {
      // Force the next getAuthHeader() to refresh. Remember WHICH token was rejected
      // first: the preset path re-reads the store before refreshing, and must still
      // force a network refresh when that re-read returns the same rejected token
      // (rather than be fooled into re-serving it). A sibling's newer token clears
      // the flag implicitly (reloadStillRejected() turns false).
      invalidatedAccess = accessToken;
      forcedRefresh = true;
      expiresAt = 0;
      accessToken = null;
    },
  };
}
