// Admin OAuth-login API client (issue #38). The admin UI is a PURE consumer of
// the gateway's /admin/api/oauth surface (CLAUDE.md Principle 1) — no core logic,
// no secrets ever cross this boundary. Two flows: manual_paste (Anthropic /
// Claude Pro-Max) and device_code (GitHub Copilot).

export type OAuthFlow = 'manual_paste' | 'device_code';

export interface OAuthAccount {
  account: string;
  expiresAt: number | null;
  updatedAt: number;
  // True when the account has a working durable credential (the gateway auto-renews
  // the short-lived access token). False = a refresh failed → needs reconnecting.
  healthy: boolean;
}

export interface OAuthProviderStatus {
  id: string;
  name: string;
  flow: OAuthFlow;
  accounts: OAuthAccount[];
}

const BASE = '/admin/api/oauth';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // not JSON; keep the status only
    }
    throw new Error(`oauth api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// GET /oauth -> provider catalog + logged-in accounts (no secrets). 503 when
// OAuth login is not configured (HELM_OAUTH_ENC_KEY unset).
export async function listOAuthStatus(): Promise<{
  configured: boolean;
  providers: OAuthProviderStatus[];
}> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  if (res.status === 503) return { configured: false, providers: [] };
  const body = await asJson<{ providers: OAuthProviderStatus[] }>(res);
  return { configured: true, providers: body.providers };
}

// ── manual-paste (Anthropic) ─────────────────────────────────────────────────
export async function startManualPaste(
  provider: string,
): Promise<{ sessionId: string; authorizeUrl: string }> {
  const res = await fetch(`${BASE}/${provider}/manual/start`, { method: 'POST' });
  return asJson(res);
}

export async function completeManualPaste(
  provider: string,
  body: { sessionId: string; redirectInput: string; account?: string },
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/manual/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await asJson(res); // throws with detail
}

// ── device-code (Copilot) ────────────────────────────────────────────────────
export async function startDeviceCode(
  provider: string,
  enterprise?: string,
): Promise<{ sessionId: string; userCode: string; verificationUri: string }> {
  const res = await fetch(`${BASE}/${provider}/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enterprise }),
  });
  return asJson(res);
}

export async function pollDeviceCode(
  provider: string,
  body: { sessionId: string; account?: string },
): Promise<{ status: 'pending' | 'slow_down' | 'done' }> {
  const res = await fetch(`${BASE}/${provider}/device/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson(res);
}

// DELETE /oauth/:provider?account= -> forget a stored credential.
export async function logoutOAuth(provider: string, account = 'default'): Promise<void> {
  const res = await fetch(`${BASE}/${provider}?account=${encodeURIComponent(account)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

// ── per-account model curation ───────────────────────────────────────────────

// The discovered models for one account + the operator's exposed subset.
// `available` is the live/curated discovery; `enabled` is what reaches Lanes
// (unset settings ⇒ all available).
export interface AccountModels {
  available: string[];
  enabled: string[];
}

// GET /oauth/:provider/models?account= -> { available, enabled }.
export async function getAccountModels(
  provider: string,
  account = 'default',
): Promise<AccountModels> {
  const res = await fetch(`${BASE}/${provider}/models?account=${encodeURIComponent(account)}`, {
    headers: { accept: 'application/json' },
  });
  return asJson(res);
}

// PUT /oauth/:provider/models { account, models } -> 204. Persists the exposed set.
export async function setAccountModels(
  provider: string,
  account: string,
  models: string[],
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, models }),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

// ── per-account egress proxy ─────────────────────────────────────────────────

export type ProxyType = 'http' | 'https' | 'socks5';

// The account's configured proxy, REDACTED: the gateway never returns the password,
// only whether one is set (`hasPassword`). null = no proxy (direct connection).
export interface AccountProxyView {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  hasPassword: boolean;
}

// Write shape. Omit `password` on an update to keep the stored one; an empty string
// clears it. null clears the whole proxy.
export interface AccountProxyInput {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

// GET /oauth/:provider/proxy?account= -> { proxy: AccountProxyView | null }.
export async function getAccountProxy(
  provider: string,
  account = 'default',
): Promise<AccountProxyView | null> {
  const res = await fetch(`${BASE}/${provider}/proxy?account=${encodeURIComponent(account)}`, {
    headers: { accept: 'application/json' },
  });
  const body = await asJson<{ proxy: AccountProxyView | null }>(res);
  return body.proxy;
}

// PUT /oauth/:provider/proxy { account, proxy|null } -> 204. Persist or clear.
export async function setAccountProxy(
  provider: string,
  account: string,
  proxy: AccountProxyInput | null,
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/proxy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, proxy }),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

// ── per-account pool scheduling (priority + schedulable) ─────────────────────

// The account's effective scheduling. `priority` orders the pool (LOWER = served
// first); `schedulable` false parks the account out of rotation (still connected).
// Round-robin (LRU) breaks ties within an equal priority.
export interface AccountSchedule {
  priority: number;
  schedulable: boolean;
}

// GET /oauth/:provider/account?account= -> { priority, schedulable } (defaults applied).
export async function getAccountSchedule(
  provider: string,
  account = 'default',
): Promise<AccountSchedule> {
  const res = await fetch(`${BASE}/${provider}/account?account=${encodeURIComponent(account)}`, {
    headers: { accept: 'application/json' },
  });
  return asJson(res);
}

// PUT /oauth/:provider/account { account, priority?, schedulable? } -> 204. Either
// field may be omitted to leave it unchanged.
export async function setAccountSchedule(
  provider: string,
  account: string,
  patch: { priority?: number; schedulable?: boolean },
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/account`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, ...patch }),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}
