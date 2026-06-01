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
// Decisions D1–D3 (see implementation-notes): non-interactive grants only
// (refresh_token / client_credentials); refresh logic lives here, the 401 retry
// trigger lives in the client; in-memory only (a rotating refresh token is lost on
// restart — documented limitation).

// Already-resolved OAuth credential values (NOT env var names — the composition
// root resolves those). `refreshToken` is present for the refresh_token grant.
export interface ResolvedOAuth {
  grant: "refresh_token" | "client_credentials";
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  scopes: string[];
  audience?: string;
}

export interface TokenManagerDeps {
  oauth: ResolvedOAuth;
  fetch?: typeof globalThis.fetch;
  /** Injected clock (ms epoch) for deterministic expiry windows in tests. */
  now?: () => number;
  /** Refresh `skew` ms before the reported expiry so a token never expires mid-flight. */
  expirySkewMs?: number;
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

  let accessToken: string | null = null;
  let expiresAt = 0; // ms epoch; 0 => no cached token
  // Refresh tokens may ROTATE: the endpoint can hand back a new one each refresh.
  // Hold the live value in memory (D3: lost on restart — documented limitation).
  let refreshToken: string | undefined = oauth.refreshToken;
  // Single-flight lock: concurrent callers hitting an expired token await the SAME
  // in-flight refresh (mirrors breaker.ts inFlightProbe) so N callers => 1 fetch.
  let refreshing: Promise<void> | null = null;

  function buildBody(): URLSearchParams {
    const body = new URLSearchParams();
    body.set("grant_type", oauth.grant);
    body.set("client_id", oauth.clientId);
    body.set("client_secret", oauth.clientSecret);
    if (oauth.grant === "refresh_token") {
      // refreshToken is guaranteed present for this grant (config refine), but
      // guard anyway so a desync never sends "undefined" on the wire.
      if (refreshToken !== undefined) body.set("refresh_token", refreshToken);
    }
    if (oauth.scopes.length > 0) body.set("scope", oauth.scopes.join(" "));
    if (oauth.audience !== undefined) body.set("audience", oauth.audience);
    return body;
  }

  async function doRefresh(): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildBody().toString(),
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

  function isExpired(): boolean {
    return accessToken === null || now() + skew >= expiresAt;
  }

  async function ensureFresh(): Promise<void> {
    if (!isExpired()) return;
    // Coalesce concurrent refreshes. The first caller starts the fetch; everyone
    // else awaits the same promise. Cleared in finally so a later expiry refreshes
    // again (and a failed refresh does not poison the lock).
    if (refreshing === null) {
      refreshing = doRefresh().finally(() => {
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
