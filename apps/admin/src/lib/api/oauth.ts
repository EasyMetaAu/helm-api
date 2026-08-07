// Admin OAuth-login API client (issue #38). The admin UI is a PURE consumer of
// the gateway's /admin/api/oauth surface (CLAUDE.md Principle 1) — no core logic,
// no secrets ever cross this boundary. Two flows: manual_paste (Anthropic /
// Claude Pro-Max) and device_code (GitHub Copilot / xAI).

import {
  type CodexResetResult,
  CodexResetResultSchema,
  type OAuthQuotaSnapshot as SharedOAuthQuotaSnapshot,
  OAuthQuotaSnapshotSchema,
  type OAuthUsagePeriod as SharedOAuthUsagePeriod,
  type OAuthUsagePeriods as SharedOAuthUsagePeriods,
  OAuthUsagePeriodsSchema,
} from '@helm/shared';
import { clientTzOffsetMinutes } from '$lib/requests-filters.js';

export type OAuthFlow = 'manual_paste' | 'device_code';
export type OAuthSelectionStrategy = 'balanced' | 'manual_priority' | 'low_risk' | 'use_expiring';

export interface OAuthAccount {
  account: string;
  // Codex identity claims copied from the ChatGPT subscription token. Optional
  // because legacy records and non-Codex providers do not have these fields.
  email?: string;
  chatgptPlanType?: string;
  chatgptAccountId?: string;
  isFedramp?: boolean;
  expiresAt: number | null;
  updatedAt: number;
  // True when the account has a working durable credential (the gateway auto-renews
  // the short-lived access token). False = a refresh failed → needs reconnecting.
  healthy: boolean;
  // True after a durable OAuth credential rejection. Reconnect clears it; the
  // schedulable toggle alone must not appear to recover the account.
  credentialFailed?: boolean;
  // Effective pool scheduling (defaults applied by the gateway: 50 / true). LOWER
  // priority = served first; schedulable false parks the account out of rotation.
  priority: number;
  schedulable: boolean;
  // Codex only: auto-consume a reset credit when the weekly window saturates
  // (default false). Lets the providers page pre-fill the reset-confirm checkbox.
  autoReset?: boolean;
  // When true, keep spending this account's remaining credits even while it is
  // usage-limited (never park it on the rate limit). Default false.
  allowSpendRemainingCredits?: boolean;
  // Per-account Fast mode. Claude accounts force speed=fast; Codex accounts force
  // service_tier=priority when this account serves a request.
  fastMode?: boolean;
  // The account's egress proxy, REDACTED (never the password — only `hasPassword`),
  // or null for a direct connection. Folded onto the row by the gateway so the list
  // shows which proxy each account tunnels through without the per-account GET the
  // Manage dialog uses.
  proxy: AccountProxyView | null;
  // Manual mode shows the saved allowlist; auto mode shows account discovery.
  models: string[];
}

export interface OAuthProviderStatus {
  id: string;
  name: string;
  flow: OAuthFlow;
  accounts: OAuthAccount[];
}

const BASE = '/admin/api/oauth';

export type OAuthApiErrorCode =
  | 'device_authorization_denied'
  | 'device_code_expired'
  | 'device_poll_failed'
  | 'reset_credit_cooldown_active';

export class OAuthApiError extends Error {
  readonly status: number;
  readonly code: OAuthApiErrorCode | undefined;

  constructor(status: number, detail: string, code?: OAuthApiErrorCode) {
    super(`oauth api ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'OAuthApiError';
    this.status = status;
    this.code = code;
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let code: OAuthApiErrorCode | undefined;
    try {
      const body: unknown = await res.json();
      detail = JSON.stringify(body);
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const value = Reflect.get(body, 'code');
        if (
          value === 'device_authorization_denied' ||
          value === 'device_code_expired' ||
          value === 'device_poll_failed' ||
          value === 'reset_credit_cooldown_active'
        ) {
          code = value;
        }
      }
    } catch {
      // not JSON; keep the status only
    }
    throw new OAuthApiError(res.status, detail, code);
  }
  return (await res.json()) as T;
}

// GET /oauth -> provider catalog + logged-in accounts (no secrets). 503 when
// OAuth login is not configured (HELM_OAUTH_ENC_KEY unset).
export async function listOAuthStatus(): Promise<{
  configured: boolean;
  selectionStrategy: OAuthSelectionStrategy;
  providers: OAuthProviderStatus[];
}> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  if (res.status === 503)
    return { configured: false, selectionStrategy: 'balanced', providers: [] };
  const body = await asJson<{
    selectionStrategy?: OAuthSelectionStrategy;
    providers: OAuthProviderStatus[];
  }>(res);
  return {
    configured: true,
    selectionStrategy: body.selectionStrategy ?? 'balanced',
    providers: body.providers,
  };
}

// ── per-account usage + quota (providers page enrichment) ────────────────────

// Today's served traffic for one account (Tier 2). `costUsd` is null for flat-rate
// subscriptions (unpriced); `rpm` is the daily-average requests-per-minute.
export interface OAuthUsageRow {
  providerId: string;
  account: string;
  requests: number;
  tokens: number;
  costUsd: number | null;
  rpm: number;
}

export type OAuthAdminRefreshState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface OAuthAdminRefreshStatus {
  state: OAuthAdminRefreshState;
  jobId: string | null;
  requestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastSuccessAt: number | null;
  nextAllowedAt: number | null;
  error: string | null;
}

export interface OAuthOverview {
  configured: boolean;
  selectionStrategy: OAuthSelectionStrategy;
  providers: OAuthProviderStatus[];
  usage: OAuthUsageRow[];
  quota: OAuthQuotaSnapshot[];
  refresh: OAuthAdminRefreshStatus;
}

export interface OAuthAdminRefreshEnqueueResult {
  accepted: boolean;
  coalesced: boolean;
  retryAfterMs: number;
  status: OAuthAdminRefreshStatus;
}

// Quota wire types come exclusively from @helm/shared's Zod schema. Keep aliases
// here so existing Admin imports stay stable without duplicating the contract.
export type OAuthQuotaSnapshot = SharedOAuthQuotaSnapshot;
export type OAuthQuotaWindow = OAuthQuotaSnapshot['windows'][number];
export type CodexRateLimitReachedType = NonNullable<OAuthQuotaSnapshot['rateLimitReachedType']>;
export type CodexCredits = NonNullable<OAuthQuotaSnapshot['credits']>;
export type CodexIndividualLimit = NonNullable<OAuthQuotaSnapshot['individualLimit']>;
export type CodexAdditionalLimit = NonNullable<OAuthQuotaSnapshot['additionalLimits']>[number];
export type CodexResetCreditDetail = NonNullable<OAuthQuotaSnapshot['resetCreditDetails']>[number];

// Cache-only observability reads are expected to be fast, but a DB lock or stalled
// gateway must still not leave the Providers page spinning forever.
const OBSERVABILITY_TIMEOUT_MS = 10_000;

// GET /oauth/overview -> one cache-only page snapshot. The gateway guarantees this
// route never performs provider discovery, token refresh, or quota pulls.
export async function getOAuthOverview(): Promise<OAuthOverview> {
  const res = await fetch(`${BASE}/overview?tzOffsetMinutes=${clientTzOffsetMinutes()}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(OBSERVABILITY_TIMEOUT_MS),
  });
  return asJson(res);
}

// POST /oauth/refresh -> enqueue one global refresh job. The 202 response is
// immediate; repeated clicks are coalesced by the gateway coordinator.
export async function requestOAuthRefresh(): Promise<OAuthAdminRefreshEnqueueResult> {
  const res = await fetch(`${BASE}/refresh`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  return asJson(res);
}

// GET /oauth/usage -> today's per-account usage, bucketed by the VIEWER's local day
// (send the browser UTC offset so "today" matches the dashboard, not 00:00 UTC).
// FAIL-OPEN: any failure (incl. timeout) yields [] so the page renders (zeros)
// instead of breaking.
export async function getOAuthUsage(): Promise<OAuthUsageRow[]> {
  try {
    const res = await fetch(`${BASE}/usage?tzOffsetMinutes=${clientTzOffsetMinutes()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(OBSERVABILITY_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { usage?: OAuthUsageRow[] }).usage ?? [];
  } catch {
    return [];
  }
}

// GET /oauth/quota -> latest cached rate-limit window snapshot per account. FAIL-OPEN
// to [] (incl. timeout) so an unavailable gateway never stalls the page.
export async function getOAuthQuota(): Promise<OAuthQuotaSnapshot[]> {
  try {
    const res = await fetch(`${BASE}/quota`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(OBSERVABILITY_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
    const quota = Reflect.get(body, 'quota');
    if (!Array.isArray(quota)) return [];
    return quota.flatMap((row) => {
      const parsed = OAuthQuotaSnapshotSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

// Re-export the shared period types so the account-detail page imports them from
// the API client (stable boundary) rather than reaching into @helm/shared directly.
export type OAuthUsagePeriod = SharedOAuthUsagePeriod;
export type OAuthUsagePeriods = SharedOAuthUsagePeriods;

const EMPTY_PERIODS: OAuthUsagePeriods = { current: [], daily: [], weekly: [] };

// GET /oauth/usage/periods -> the account-detail page: current reset-period summary +
// natural day/week history (bucketed in the viewer's local tz). FAIL-OPEN: any failure
// yields empty arrays so the page renders an empty state instead of breaking.
export async function getOAuthUsagePeriods(
  provider: string,
  account: string,
): Promise<OAuthUsagePeriods> {
  try {
    const qs = new URLSearchParams({
      provider,
      account,
      tzOffsetMinutes: String(clientTzOffsetMinutes()),
    });
    const res = await fetch(`${BASE}/usage/periods?${qs.toString()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(OBSERVABILITY_TIMEOUT_MS),
    });
    if (!res.ok) return EMPTY_PERIODS;
    const parsed = OAuthUsagePeriodsSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : EMPTY_PERIODS;
  } catch {
    return EMPTY_PERIODS;
  }
}

// ── manual-paste (Anthropic) ─────────────────────────────────────────────────
// `proxy` (optional, from the connect dialog's first step) is pinned to the login
// session server-side so the token exchange egresses through it, never the real IP.
export async function startManualPaste(
  provider: string,
  proxy?: AccountProxyInput,
): Promise<{ sessionId: string; authorizeUrl: string }> {
  const res = await fetch(`${BASE}/${provider}/manual/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxy }),
  });
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

// ── device-code (Copilot / xAI) ──────────────────────────────────────────────
// `proxy` is pinned BEFORE the device-code POST (the flow's first call), so step 1
// already egresses through it — no real-IP leak at bind time.
export async function startDeviceCode(
  provider: string,
  enterprise?: string,
  proxy?: AccountProxyInput,
): Promise<{
  sessionId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  serverNowMs: number;
}> {
  const res = await fetch(`${BASE}/${provider}/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enterprise, proxy }),
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

// POST /oauth/:provider/reset?account= -> Codex-only local cooldown override. Clears
// Helm's auto-park usage-limit cooldown so the account rejoins the pool on the next
// request ("Retry account"). Leaves the operator's schedulable park untouched. Upstream
// 5h/7d windows are subscription limits and are not resettable here.
export async function resetUsageLimit(provider: string, account = 'default'): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/reset?account=${encodeURIComponent(account)}`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

// ── Codex rate-limit reset credit (the "reset usage limit" action) ───────────

// The consume result surfaced to the operator. A 2xx response can still be
// noCredit or nothingToReset, so the Providers page must branch on `outcome`.
type NormalizedCodexResetCreditResult = Required<
  Pick<CodexResetResult, 'code' | 'outcome' | 'windowsReset'>
> &
  Pick<CodexResetResult, 'redeemRequestId'>;

const CodexResetCreditResponseSchema = CodexResetResultSchema.superRefine((result, ctx) => {
  if (
    !Object.hasOwn(result, 'code') ||
    result.outcome === undefined ||
    !Object.hasOwn(result, 'windowsReset')
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'invalid normalized Codex reset-credit response',
    });
  }
}).transform(
  (result): NormalizedCodexResetCreditResult => ({
    code: result.code ?? null,
    outcome: result.outcome as NonNullable<CodexResetResult['outcome']>,
    windowsReset: result.windowsReset ?? null,
    ...(result.redeemRequestId === undefined ? {} : { redeemRequestId: result.redeemRequestId }),
  }),
);

export type CodexResetCreditResult = ReturnType<typeof CodexResetCreditResponseSchema.parse>;

// POST /oauth/:provider/reset-credit -> consume one rate-limit reset credit for the
// account. Codex-only on the server; FAIL-CLOSED (the gateway 502s on any upstream
// failure). A local cooldown means the account was already reset recently, so project
// that one idempotent state as success without issuing another request.
export async function consumeCodexResetCredit(
  provider: string,
  account = 'default',
  options: { creditId?: string; idempotencyKey?: string } = {},
): Promise<CodexResetCreditResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(provider)}/reset-credit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, ...options }),
  });
  try {
    return CodexResetCreditResponseSchema.parse(await asJson<unknown>(res));
  } catch (error) {
    if (
      error instanceof OAuthApiError &&
      error.status === 429 &&
      error.code === 'reset_credit_cooldown_active'
    ) {
      return CodexResetCreditResponseSchema.parse({
        code: 'already_redeemed',
        outcome: 'alreadyRedeemed',
        windowsReset: 0,
      });
    }
    throw error;
  }
}

// ── per-account connectivity test (providers page "Test" button) ─────────────

// One normalized event from POST /oauth/:provider/test, mirroring the gateway's
// oauth-test event shapes. The dialog appends `content` deltas live and ends on
// `done` (success) or `error` (failure surfaced in-band, never a thrown 5xx).
export type AccountTestEvent =
  | { type: 'start'; model?: string }
  | { type: 'content'; text: string }
  | { type: 'finish'; reason?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'done'; durationMs?: number }
  | { type: 'error'; error: string };

// Pull one normalized event out of an SSE `data:` line (ignores comments, blanks,
// `[DONE]`, and unparseable payloads — fail-open like the gateway parser).
function parseTestLine(line: string): AccountTestEvent | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const obj = JSON.parse(payload) as AccountTestEvent;
    return obj && typeof obj === 'object' && typeof obj.type === 'string' ? obj : null;
  } catch {
    return null;
  }
}

// POST /oauth/:provider/test → stream the test reply, yielding each parsed event.
// A pre-flight failure (503 oauth-off / 400 bad input) is normalized into a single
// `error` event so the caller has ONE uniform channel. An abort (modal close / Stop)
// ends the generator quietly. Never throws — every failure becomes an `error` event.
export async function* streamAccountTest(
  provider: string,
  body: { account: string; model: string; prompt?: string },
  signal?: AbortSignal,
): AsyncGenerator<AccountTestEvent> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(provider)}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: 'error', error: e instanceof Error ? e.message : 'request failed' };
    return;
  }
  if (!res.ok || !res.body) {
    let detail = `test failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === 'string') detail = j.error;
    } catch {
      // not JSON — keep the status-only detail
    }
    yield { type: 'error', error: detail };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const ev = parseTestLine(buf.slice(0, nl).trimEnd());
        buf = buf.slice(nl + 1);
        if (ev) yield ev;
        nl = buf.indexOf('\n');
      }
    }
    const last = parseTestLine(buf.trim());
    if (last) yield last;
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: 'error', error: e instanceof Error ? e.message : 'stream interrupted' };
  }
}

// ── per-account model curation ───────────────────────────────────────────────

export type AccountModelsMode = 'auto' | 'manual';

// The discovered models for one account + its management projection.
// `available` is exact account discovery; `enabled` is the saved manual allowlist
// or that exact discovery in auto mode.
export interface AccountModels {
  available: string[];
  enabled: string[];
  // Auto follows the account's remote catalog and receives new models. Manual
  // persists an explicit operator-curated list.
  modelsMode: AccountModelsMode;
  // True when the provider has a live list-models API, including Codex.
  canPull: boolean;
}

// GET /oauth/:provider/models?account= -> { available, enabled, modelsMode, canPull }.
export async function getAccountModels(
  provider: string,
  account = 'default',
): Promise<AccountModels> {
  const res = await fetch(`${BASE}/${provider}/models?account=${encodeURIComponent(account)}`, {
    headers: { accept: 'application/json' },
  });
  return asJson(res);
}

// PUT /oauth/:provider/models { account, mode, models } -> 204. Auto follows the
// remote account catalog; manual persists the explicit exposed set.
export async function setAccountModels(
  provider: string,
  account: string,
  input: { mode: AccountModelsMode; models: string[] },
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, mode: input.mode, models: input.models }),
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
  // Codex only: auto-consume a reset credit when the weekly window saturates.
  autoReset: boolean;
  // When true, keep spending this account's remaining credits even while usage-limited.
  allowSpendRemainingCredits: boolean;
  // Per-account Fast mode.
  fastMode: boolean;
}

// GET /oauth/:provider/account?account= -> { priority, schedulable, autoReset, allowSpendRemainingCredits, fastMode }.
export async function getAccountSchedule(
  provider: string,
  account = 'default',
): Promise<AccountSchedule> {
  const res = await fetch(`${BASE}/${provider}/account?account=${encodeURIComponent(account)}`, {
    headers: { accept: 'application/json' },
  });
  return asJson(res);
}

// PUT /oauth/:provider/account { account, priority?, schedulable?, autoReset?, allowSpendRemainingCredits?, fastMode? } -> 204.
// Any field may be omitted to leave it unchanged.
export async function setAccountSchedule(
  provider: string,
  account: string,
  patch: {
    priority?: number;
    schedulable?: boolean;
    autoReset?: boolean;
    allowSpendRemainingCredits?: boolean;
    fastMode?: boolean;
  },
): Promise<void> {
  const res = await fetch(`${BASE}/${provider}/account`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, ...patch }),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

// PUT /oauth/strategy { selectionStrategy } -> 204. Persists the global
// account-pool strategy and hot-rebuilds every live OAuth pool.
export async function setSelectionStrategy(
  selectionStrategy: OAuthSelectionStrategy,
): Promise<void> {
  const res = await fetch(`${BASE}/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selectionStrategy }),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}
