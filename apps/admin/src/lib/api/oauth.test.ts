import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeManualPaste,
  consumeCodexResetCredit,
  getAccountModels,
  getOAuthOverview,
  getOAuthQuota,
  getOAuthUsage,
  listOAuthStatus,
  logoutOAuth,
  OAuthApiError,
  pollDeviceCode,
  requestOAuthRefresh,
  setAccountModels,
  setAccountSchedule,
  setSelectionStrategy,
  startDeviceCode,
  startManualPaste,
} from './oauth.js';

function resp(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function firstCall<T>(calls: readonly T[]): T {
  const call = calls[0];
  if (call === undefined) {
    throw new Error('expected fetch to be called');
  }
  return call;
}

function requestInit(call: readonly unknown[]): RequestInit {
  const init = call[1];
  if (init === undefined || init === null || typeof init !== 'object') {
    throw new Error('expected fetch request init');
  }
  return init as RequestInit;
}

describe('admin oauth api client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats a 503 status response as OAuth not configured', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      resp({ error: 'not_configured' }, { ok: false, status: 503 }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(listOAuthStatus()).resolves.toEqual({
      configured: false,
      selectionStrategy: 'balanced',
      providers: [],
    });
    expect(fetchFn).toHaveBeenCalledWith('/admin/api/oauth', {
      headers: { accept: 'application/json' },
    });
  });

  it('preserves a structured device polling error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resp(
          { error: 'xAI device authorization was denied', code: 'device_authorization_denied' },
          { ok: false, status: 400 },
        ),
      ),
    );

    await expect(pollDeviceCode('xai', { sessionId: 's' })).rejects.toMatchObject({
      name: 'OAuthApiError',
      status: 400,
      code: 'device_authorization_denied',
    } satisfies Partial<OAuthApiError>);
  });

  it('parses configured provider status without exposing secrets', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      resp({
        selectionStrategy: 'low_risk',
        providers: [
          {
            id: 'anthropic',
            name: 'Claude Max',
            flow: 'manual_paste',
            accounts: [
              {
                account: 'acct-a',
                expiresAt: null,
                updatedAt: 1,
                healthy: true,
                credentialFailed: false,
                priority: 20,
                schedulable: true,
                fastMode: true,
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    const status = await listOAuthStatus();
    expect(status.configured).toBe(true);
    expect(status.selectionStrategy).toBe('low_risk');
    expect(status.providers[0]?.accounts[0]?.account).toBe('acct-a');
    expect(status.providers[0]?.accounts[0]?.credentialFailed).toBe(false);
    expect(status.providers[0]?.accounts[0]?.fastMode).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/access_token|refresh_token|secret/i);
  });

  it('loads the providers overview in one cache-only request', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      resp({
        configured: true,
        selectionStrategy: 'balanced',
        providers: [],
        usage: [
          {
            providerId: 'anthropic',
            account: 'acct-a',
            requests: 2,
            tokens: 12,
            costUsd: null,
            rpm: 0.1,
          },
        ],
        quota: [
          {
            providerId: 'anthropic',
            account: 'acct-a',
            windows: [],
            capturedAt: 123,
            source: 'anthropic',
          },
        ],
        refresh: {
          state: 'idle',
          jobId: null,
          requestedAt: null,
          startedAt: null,
          finishedAt: null,
          lastSuccessAt: null,
          nextAllowedAt: null,
          error: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(getOAuthOverview()).resolves.toMatchObject({
      configured: true,
      usage: [{ providerId: 'anthropic', account: 'acct-a', requests: 2 }],
      quota: [{ providerId: 'anthropic', account: 'acct-a', capturedAt: 123 }],
      refresh: { state: 'idle', jobId: null },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(firstCall(fetchFn.mock.calls)[0])).toContain('/admin/api/oauth/overview?');
  });

  it('enqueues a provider refresh without waiting for upstream work', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      resp(
        {
          accepted: true,
          coalesced: false,
          retryAfterMs: 0,
          status: { state: 'queued', jobId: 'refresh-1' },
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(requestOAuthRefresh()).resolves.toMatchObject({
      accepted: true,
      coalesced: false,
      status: { state: 'queued', jobId: 'refresh-1' },
    });
    expect(fetchFn).toHaveBeenCalledWith('/admin/api/oauth/refresh', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
  });

  it('saves the global selection strategy', async () => {
    const fetchFn = vi.fn(async () => resp(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);

    await setSelectionStrategy('use_expiring');

    expect(fetchFn).toHaveBeenCalledWith('/admin/api/oauth/strategy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selectionStrategy: 'use_expiring' }),
    });
  });

  it('preserves the server device-code polling interval and expiry', async () => {
    const fetchFn = vi.fn(async () =>
      resp({
        sessionId: 'xai-session',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.x.ai/activate',
        intervalMs: 7000,
        expiresAt: 123456,
        serverNowMs: 100000,
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(startDeviceCode('xai')).resolves.toEqual({
      sessionId: 'xai-session',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      intervalMs: 7000,
      expiresAt: 123456,
      serverNowMs: 100000,
    });
  });

  it('fails open for usage and quota observability reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp({}, { ok: false, status: 500 })),
    );
    await expect(getOAuthUsage()).resolves.toEqual([]);
    await expect(getOAuthQuota()).resolves.toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(getOAuthUsage()).resolves.toEqual([]);
    await expect(getOAuthQuota()).resolves.toEqual([]);
  });

  it('parses usage and quota rows when the gateway responds successfully', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        resp({
          usage: [
            {
              providerId: 'anthropic',
              account: 'acct-a',
              requests: 12,
              tokens: 3456,
              costUsd: null,
              rpm: 0.3,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          quota: [
            {
              providerId: 'anthropic',
              account: 'acct-a',
              windows: [{ key: '5h', usedPercent: 42, resetsAtMs: 123, windowMinutes: 300 }],
              capturedAt: 99,
              source: 'anthropic',
              identity: {
                email: 'codex@example.com',
                chatgptPlanType: 'pro',
                chatgptAccountId: 'account-1',
                isFedramp: false,
              },
              planType: 'pro',
              credits: { hasCredits: true, unlimited: false, balance: '9.99' },
              individualLimit: {
                limit: '25000',
                used: '8000',
                remainingPercent: 68,
                resetsAtMs: 456,
              },
              rateLimitReachedType: 'rate_limit_reached',
              resetCreditDetails: [
                {
                  id: 'credit-1',
                  resetType: 'codexRateLimits',
                  status: 'available',
                  grantedAt: 1,
                  expiresAt: 2,
                  title: 'Full reset',
                  description: 'Ready',
                },
              ],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchFn);

    await expect(getOAuthUsage()).resolves.toEqual([
      expect.objectContaining({ providerId: 'anthropic', account: 'acct-a', requests: 12 }),
    ]);
    await expect(getOAuthQuota()).resolves.toEqual([
      expect.objectContaining({
        providerId: 'anthropic',
        account: 'acct-a',
        capturedAt: 99,
        identity: {
          email: 'codex@example.com',
          chatgptPlanType: 'pro',
          chatgptAccountId: 'account-1',
          isFedramp: false,
        },
        planType: 'pro',
        credits: { hasCredits: true, unlimited: false, balance: '9.99' },
        individualLimit: {
          limit: '25000',
          used: '8000',
          remainingPercent: 68,
          resetsAtMs: 456,
        },
        rateLimitReachedType: 'rate_limit_reached',
        resetCreditDetails: [
          {
            id: 'credit-1',
            resetType: 'codexRateLimits',
            status: 'available',
            grantedAt: 1,
            expiresAt: 2,
            title: 'Full reset',
            description: 'Ready',
          },
        ],
      }),
    ]);
  });

  it('fails open when quota JSON does not match the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resp({
          quota: [
            {
              providerId: 'openai-codex',
              account: 'acct-a',
              windows: [],
              capturedAt: 99,
              source: 'codex',
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: 9.99,
              },
            },
          ],
        }),
      ),
    );

    await expect(getOAuthQuota()).resolves.toEqual([]);
  });

  it('keeps valid quota rows when another account has malformed metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resp({
          quota: [
            {
              providerId: 'openai-codex',
              account: 'valid',
              windows: [],
              capturedAt: 99,
              source: 'codex',
            },
            {
              providerId: 'openai-codex',
              account: 'invalid',
              windows: [],
              capturedAt: 99,
              source: 'codex',
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: 9.99,
              },
            },
          ],
        }),
      ),
    );

    await expect(getOAuthQuota()).resolves.toEqual([
      expect.objectContaining({ account: 'valid', usageLimitedUntilMs: null }),
    ]);
  });

  it('posts a selected reset credit with a reusable idempotency key and returns the outcome', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      resp({
        code: 'already_redeemed',
        outcome: 'alreadyRedeemed',
        windowsReset: 0,
        redeemRequestId: 'idem-1',
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(
      consumeCodexResetCredit('openai-codex', 'acct-codex', {
        creditId: 'credit-1',
        idempotencyKey: 'idem-1',
      }),
    ).resolves.toMatchObject({
      outcome: 'alreadyRedeemed',
      redeemRequestId: 'idem-1',
    });

    const call = firstCall(fetchFn.mock.calls);
    expect(JSON.parse(String(requestInit(call).body))).toEqual({
      account: 'acct-codex',
      creditId: 'credit-1',
      idempotencyKey: 'idem-1',
    });
  });

  it('shows a completed reset for the local cooldown response without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      resp(
        {
          error: 'reset credit blocked: a reset credit was already consumed within the last hour',
          code: 'reset_credit_cooldown_active',
          retryAfterMs: 358_411,
        },
        { ok: false, status: 429 },
      ),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(consumeCodexResetCredit('openai-codex', 'acct-codex')).resolves.toEqual({
      code: 'already_redeemed',
      outcome: 'alreadyRedeemed',
      windowsReset: 0,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('keeps unrelated reset-credit 429 responses as errors without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      resp(
        {
          error: 'another reset-credit attempt is still in progress',
          code: 'reset_credit_reservation_active',
          retryAfterMs: 30_000,
        },
        { ok: false, status: 429 },
      ),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(consumeCodexResetCredit('openai-codex', 'acct-codex')).rejects.toThrow(
      'reset_credit_reservation_active',
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects a malformed reset-credit success body instead of casting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        resp({
          code: 'reset',
          windowsReset: 2,
        }),
      ),
    );

    await expect(consumeCodexResetCredit('openai-codex')).rejects.toThrow(
      'invalid normalized Codex reset-credit response',
    );
  });

  it('posts manual-paste proxy settings to the gateway start endpoint', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      resp({ sessionId: 'sess-1', authorizeUrl: 'https://login' }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(
      startManualPaste('anthropic', { type: 'socks5', host: '127.0.0.1', port: 9050 }),
    ).resolves.toEqual({ sessionId: 'sess-1', authorizeUrl: 'https://login' });

    const call = firstCall(fetchFn.mock.calls);
    expect(call[0]).toBe('/admin/api/oauth/anthropic/manual/start');
    const init = requestInit(call);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      proxy: { type: 'socks5', host: '127.0.0.1', port: 9050 },
    });
  });

  it('throws gateway details for failed manual-paste completion', async () => {
    const fetchFn = vi.fn(async () =>
      resp({ error: { code: 'invalid_redirect' } }, { ok: false, status: 400 }),
    );
    vi.stubGlobal('fetch', fetchFn);

    await expect(
      completeManualPaste('anthropic', {
        sessionId: 'sess-1',
        redirectInput: 'https://callback',
        account: 'acct-a',
      }),
    ).rejects.toThrow('invalid_redirect');
  });

  it('updates per-account scheduling with a partial patch', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => resp(null, { ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchFn);

    await setAccountSchedule('anthropic', 'acct-a', {
      priority: 5,
      schedulable: false,
      fastMode: true,
    });

    const call = firstCall(fetchFn.mock.calls);
    expect(call[0]).toBe('/admin/api/oauth/anthropic/account');
    const init = requestInit(call);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      account: 'acct-a',
      priority: 5,
      schedulable: false,
      fastMode: true,
    });
  });

  it('reads and saves the per-account model selection mode', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        resp({
          available: ['gpt-5.6-sol', 'gpt-5.6-terra'],
          enabled: ['gpt-5.6-sol'],
          canPull: true,
          modelsMode: 'auto',
        }),
      )
      .mockResolvedValueOnce(resp(null, { ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchFn);

    await expect(getAccountModels('openai-codex', 'acct-codex')).resolves.toEqual({
      available: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      enabled: ['gpt-5.6-sol'],
      canPull: true,
      modelsMode: 'auto',
    });

    await setAccountModels('openai-codex', 'acct-codex', {
      mode: 'manual',
      models: ['gpt-5.6-sol'],
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      '/admin/api/oauth/openai-codex/models?account=acct-codex',
    );
    const saveCall = fetchFn.mock.calls[1];
    if (!saveCall) throw new Error('expected model save request');
    expect(saveCall[0]).toBe('/admin/api/oauth/openai-codex/models');
    const init = requestInit(saveCall);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      account: 'acct-codex',
      mode: 'manual',
      models: ['gpt-5.6-sol'],
    });
  });

  it('deletes a URL-encoded account credential on logout', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => resp(null, { ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchFn);

    await logoutOAuth('github-copilot', 'user+team@example.com');

    const call = firstCall(fetchFn.mock.calls);
    expect(call[0]).toBe('/admin/api/oauth/github-copilot?account=user%2Bteam%40example.com');
    expect(requestInit(call).method).toBe('DELETE');
  });
});
