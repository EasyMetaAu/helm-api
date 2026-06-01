import { describe, expect, it, vi } from 'vitest';
import { formatStars, getStarCount, REPO } from './github.js';

// In-memory Storage stub (jsdom localStorage works too, but an explicit fake
// keeps each test isolated and lets us seed/inspect the cache directly).
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function resp(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

describe('formatStars', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12345, '12.3k'],
    [999000, '999k'],
    [1_000_000, '1M'],
    [1_500_000, '1.5M'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatStars(input)).toBe(expected);
  });
});

describe('getStarCount', () => {
  it('fetches the count and writes it to the cache', async () => {
    const storage = fakeStorage();
    const fetchFn = vi.fn(async () => resp({ stargazers_count: 1234 }));
    const count = await getStarCount({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage,
      now: () => 1000,
    });
    expect(count).toBe(1234);
    expect(fetchFn).toHaveBeenCalledWith(`https://api.github.com/repos/${REPO}`, expect.anything());
    // Cache persisted for next time.
    expect(storage.getItem('helm_admin_gh_stars')).toContain('1234');
  });

  it('serves a fresh cached value without hitting the network', async () => {
    const storage = fakeStorage({
      helm_admin_gh_stars: JSON.stringify({ count: 555, fetchedAt: 1000 }),
    });
    const fetchFn = vi.fn(async () => resp({ stargazers_count: 9999 }));
    const count = await getStarCount({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage,
      now: () => 1000 + 60_000, // 1 min later, well within TTL
      ttlMs: 6 * 60 * 60 * 1000,
    });
    expect(count).toBe(555);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refetches when the cached value is stale', async () => {
    const storage = fakeStorage({
      helm_admin_gh_stars: JSON.stringify({ count: 555, fetchedAt: 0 }),
    });
    const fetchFn = vi.fn(async () => resp({ stargazers_count: 9999 }));
    const count = await getStarCount({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage,
      now: () => 7 * 60 * 60 * 1000, // past the 6h TTL
    });
    expect(count).toBe(9999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns null (fail-silent) when the request rejects and there is no cache', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const count = await getStarCount({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage: fakeStorage(),
      now: () => 1000,
    });
    expect(count).toBeNull();
  });

  it('falls back to a stale cached value when a refetch fails', async () => {
    const storage = fakeStorage({
      helm_admin_gh_stars: JSON.stringify({ count: 777, fetchedAt: 0 }),
    });
    const fetchFn = vi.fn(async () => resp({}, false)); // 500
    const count = await getStarCount({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage,
      now: () => 7 * 60 * 60 * 1000,
    });
    expect(count).toBe(777);
  });
});
