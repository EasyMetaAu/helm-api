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
import type { OAuthCredentials, OAuthProviderInterface } from "./oauth/types.js";

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
  getAuthHeader(): Promise<string>;
  /** Live access + refresh tokens, for redaction of echoed upstream bodies. */
  currentSecrets(): string[];
  /** Force the next getAuthHeader() to refresh (e.g. after an upstream 401). */
  invalidate(): void;
}

// Refresh failure. The message is SCRUBBED by construction — it never contains the
// access token, refresh token, or client secret (principle 7). Carries the HTTP
// status (when there was a response) for the caller's diagnostics.
export class TokenRefreshError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "TokenRefreshError";
    this.httpStatus = httpStatus;
  }
}

const DEFAULT_EXPIRY_SKEW_MS = 60_000;
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

  async function doRefresh(): Promise<void> {
    const o = oauth as ConfidentialOAuth;
    let res: Response;
    try {
      res = await doFetch(o.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildBody(o).toString(),
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
    const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
  }

  // Lazily load the persisted credential on first use (preset only). Decrypts the
  // stored access + refresh blobs so a still-valid token is reused WITHOUT a
  // network refresh after a restart.
  async function ensurePresetLoaded(): Promise<void> {
    if (presetLoaded) return;
    presetLoaded = true;
    const p = oauth as PresetOAuth;
    const rec = await deps.tokenStore?.get(p.providerId, p.account);
    if (!rec) return;
    const encKey = deps.encKey as Buffer;
    accessToken = rec.accessEnc ? decryptSecret(rec.accessEnc, encKey) : null;
    refreshToken = rec.refreshEnc ? decryptSecret(rec.refreshEnc, encKey) : undefined;
    expiresAt = rec.expiresAt ?? 0;
    presetExtra = rec.meta ? (JSON.parse(rec.meta) as Record<string, unknown>) : {};
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
      creds = await provider.refreshToken({
        access: accessToken ?? "",
        refresh: refreshToken,
        expires: expiresAt,
        ...presetExtra,
      });
    } catch {
      // Provider refresh failed — never echo its message (could carry a token).
      throw new TokenRefreshError(`oauth refresh failed (${p.providerId})`);
    }
    accessToken = provider.getApiKey(creds);
    refreshToken = creds.refresh;
    expiresAt = creds.expires;
    presetExtra = (() => {
      const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
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

  async function ensureFresh(): Promise<void> {
    // Preset: load the persisted token first so a still-valid one skips refresh.
    if (isPreset) await ensurePresetLoaded();
    if (!isExpired()) return;
    // Coalesce concurrent refreshes. The first caller starts the fetch; everyone
    // else awaits the same promise. Cleared in finally so a later expiry refreshes
    // again (and a failed refresh does not poison the lock).
    if (refreshing === null) {
      refreshing = (isPreset ? doPresetRefresh() : doRefresh()).finally(() => {
        refreshing = null;
      });
    }
    await refreshing;
  }

  return {
    async getAuthHeader(): Promise<string> {
      await ensureFresh();
      return `Bearer ${accessToken}`;
    },
    currentSecrets(): string[] {
      const out: string[] = [];
      if (accessToken !== null) out.push(accessToken);
      if (refreshToken !== undefined) out.push(refreshToken);
      return out;
    },
    invalidate(): void {
      // Force the next getAuthHeader() to refresh. Do NOT clear the cached token
      // synchronously: an in-flight refresh (if any) still resolves to the new one;
      // expiring it is enough to make the next call refetch.
      expiresAt = 0;
      accessToken = null;
    },
  };
}
