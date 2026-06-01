import { describe, expect, it, vi } from 'vitest';
import { getHealth, getVersion } from './gateway.js';

// Minimal Response-like stub — we only touch `ok`, `status`, and `json()`.
function resp(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('getVersion', () => {
  it('parses the /version build-info shape', async () => {
    const fetchFn = vi.fn(async () =>
      resp({ version: '0.1.0', gitSha: 'a1b2c3d', builtAt: '2026-05-30T00:00:00Z' }),
    );
    const info = await getVersion(fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith('/version', expect.anything());
    expect(info).toEqual({ version: '0.1.0', gitSha: 'a1b2c3d', builtAt: '2026-05-30T00:00:00Z' });
  });

  it('throws when /version is not ok', async () => {
    const fetchFn = vi.fn(async () => resp({}, { ok: false, status: 500 }));
    await expect(getVersion(fetchFn as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe('getHealth', () => {
  it('maps a 200 readiness probe to "online"', async () => {
    const fetchFn = vi.fn(async () => resp({ status: 'ok', ready: true }, { ok: true, status: 200 }));
    expect(await getHealth(fetchFn as unknown as typeof fetch)).toBe('online');
  });

  it('maps a reachable-but-not-ready 503 to "degraded"', async () => {
    const fetchFn = vi.fn(async () =>
      resp({ status: 'degraded', ready: false }, { ok: false, status: 503 }),
    );
    expect(await getHealth(fetchFn as unknown as typeof fetch)).toBe('degraded');
  });

  it('maps an unreachable gateway (network throw) to "offline" — fail-open, never throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await getHealth(fetchFn as unknown as typeof fetch)).toBe('offline');
  });
});
