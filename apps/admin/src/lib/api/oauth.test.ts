import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeManualPaste,
  getOAuthQuota,
  getOAuthUsage,
  listOAuthStatus,
  logoutOAuth,
  setAccountSchedule,
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
    const fetchFn = vi.fn(async () => resp({ error: 'not_configured' }, { ok: false, status: 503 }));
    vi.stubGlobal('fetch', fetchFn);

    await expect(listOAuthStatus()).resolves.toEqual({ configured: false, providers: [] });
    expect(fetchFn).toHaveBeenCalledWith('/admin/api/oauth', {
      headers: { accept: 'application/json' },
    });
  });

  it('parses configured provider status without exposing secrets', async () => {
    const fetchFn = vi.fn(async () =>
      resp({
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
                priority: 20,
                schedulable: true,
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    const status = await listOAuthStatus();
    expect(status.configured).toBe(true);
    expect(status.providers[0]?.accounts[0]?.account).toBe('acct-a');
    expect(JSON.stringify(status)).not.toMatch(/access_token|refresh_token|secret/i);
  });

  it('fails open for usage and quota observability reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp({}, { ok: false, status: 500 })));
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
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchFn);

    await expect(getOAuthUsage()).resolves.toEqual([
      expect.objectContaining({ providerId: 'anthropic', account: 'acct-a', requests: 12 }),
    ]);
    await expect(getOAuthQuota()).resolves.toEqual([
      expect.objectContaining({ providerId: 'anthropic', account: 'acct-a', capturedAt: 99 }),
    ]);
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

    await setAccountSchedule('anthropic', 'acct-a', { priority: 5, schedulable: false });

    const call = firstCall(fetchFn.mock.calls);
    expect(call[0]).toBe('/admin/api/oauth/anthropic/account');
    const init = requestInit(call);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      account: 'acct-a',
      priority: 5,
      schedulable: false,
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
