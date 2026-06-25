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
      compare: unknown;
    };

    expect(result.range).toBe('all');
    expect(result.bucket).toBe('day');
    // No vs-yesterday comparison outside the today view → single getStats call.
    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(result.compare).toBeNull();
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({
      start: 0,
      end: now,
      bucket: 'day',
    });
  });

  // The today view also fetches yesterday's FULL-DAY aggregate and reports a
  // {pct, base} per card (base = the yesterday value, surfaced in the tooltip).
  function statsWith(totals: Partial<DashboardStats['totals']>): DashboardStats {
    return { ...EMPTY_STATS, totals: { ...EMPTY_STATS.totals, ...totals } };
  }

  it('computes vs-yesterday deltas (pct + baseline) on the today view', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mocks.getStats
      .mockReset()
      .mockResolvedValueOnce(
        statsWith({
          requests: 90,
          promptTokens: 200,
          completionTokens: 100,
          cachedTokens: 50,
          totalCostUsd: 30,
        }),
      ) // today
      .mockResolvedValueOnce(
        statsWith({
          requests: 30,
          promptTokens: 50,
          completionTokens: 25,
          cachedTokens: 10,
          totalCostUsd: 10,
        }),
      ); // yesterday, full day

    const result = (await load({ url: new URL('https://admin.test/') } as never)) as {
      range: string;
      compare: Record<string, { pct: number | null; base: number }> | null;
    };

    expect(result.range).toBe('today');
    expect(mocks.getStats).toHaveBeenCalledTimes(2); // today + yesterday-full-day
    expect(result.compare).toEqual({
      requests: { pct: 200, base: 30 }, // (90-30)/30
      totalTokens: { pct: 300, base: 75 }, // today 300 vs y 75
      inputTokens: { pct: 300, base: 50 },
      outputTokens: { pct: 300, base: 25 },
      cachedTokens: { pct: 400, base: 10 },
      totalCost: { pct: 200, base: 10 },
    });
  });

  it('suppresses the whole delta set when yesterday had too little traffic', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mocks.getStats
      .mockReset()
      .mockResolvedValueOnce(statsWith({ requests: 90, promptTokens: 200 })) // today
      .mockResolvedValueOnce(statsWith({ requests: 9, promptTokens: 5 })); // yesterday: < 10 requests → too thin

    const result = (await load({ url: new URL('https://admin.test/') } as never)) as {
      compare: unknown;
    };
    expect(result.compare).toBeNull();
  });
});
