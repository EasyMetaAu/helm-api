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
