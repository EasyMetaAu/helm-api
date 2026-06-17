import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardStats } from '$lib/api/stats.js';
import { load } from './+page.js';

const mocks = vi.hoisted(() => {
  const emptyStats: DashboardStats = {
    totals: {
      requests: 0,
      okCount: 0,
      errorCount: 0,
      totalCostUsd: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      avgLatencyMs: null,
      avgTps: null,
    },
    series: [],
    byModel: [],
  };
  return {
    emptyStats,
    getStats: vi.fn(),
    listRequests: vi.fn(),
  };
});

const EMPTY_STATS = mocks.emptyStats;

vi.mock('$lib/api/stats.js', () => ({
  EMPTY_STATS: mocks.emptyStats,
  getStats: (...args: unknown[]) => mocks.getStats(...args),
}));

vi.mock('$lib/api/requests.js', () => ({
  listRequests: (...args: unknown[]) => mocks.listRequests(...args),
}));

describe('home dashboard loader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getStats.mockReset().mockResolvedValue(EMPTY_STATS);
    mocks.listRequests.mockReset().mockResolvedValue({ items: [] });
  });

  it('loads all-time stats with an explicit full-history window', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = (await load({ url: new URL('https://admin.test/?range=all') } as never)) as {
      range: string;
      bucket: string;
    };

    expect(result.range).toBe('all');
    expect(result.bucket).toBe('day');
    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({
      start: 0,
      end: now,
      bucket: 'day',
    });
  });
});
