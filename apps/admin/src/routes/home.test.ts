import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import type { RequestListItem } from '$lib/api/requests.js';
import type { DashboardStats } from '$lib/api/stats.js';
import type { TrendBucket } from '$lib/dashboard-chart.js';
import type { RangeKey } from '$lib/requests-filters.js';
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

// LayerChart touches browser-only APIs and is expensive to import in jsdom. The
// component test uses an empty aggregate, so charts render empty states and these
// stubs are never instantiated.
vi.mock('layerchart', () => ({ AreaChart: () => {}, PieChart: () => {} }));

import HomePage from './+page.svelte';

type HomeStats = {
  total: number;
  ok: number;
  errors: number;
  successRate: number | null;
  avgLatency: number | null;
  avgTps: number | null;
  totalCost: number | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheHitRate: number | null;
};

type HomePageData = {
  items: RequestListItem[];
  range: RangeKey;
  startDate?: string;
  endDate?: string;
  bucket: TrendBucket;
  stats: HomeStats;
  agg: DashboardStats;
  compare: Record<string, { pct: number | null; base: number }> | null;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pageData(overrides: Partial<HomePageData> = {}): HomePageData {
  return {
    items: [],
    range: 'today',
    bucket: 'hour',
    stats: {
      total: 0,
      ok: 0,
      errors: 0,
      successRate: null,
      avgLatency: null,
      avgTps: null,
      totalCost: null,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheHitRate: null,
    },
    agg: EMPTY_STATS,
    compare: null,
    ...overrides,
  };
}

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
    vi.mocked(invalidateAll).mockClear();
  });

  it('renders a refresh control that reloads all dashboard data', async () => {
    render(HomePage, { data: pageData() });

    await fireEvent.click(screen.getByTestId('refresh-now'));

    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it('formats average latency in seconds', () => {
    const data = pageData();
    data.stats.avgLatency = 6911;

    render(HomePage, { data });

    expect(screen.getByText('6.9s')).toBeInTheDocument();
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

  it('starts current stats, recent requests, and comparison stats concurrently', async () => {
    const current = deferred<DashboardStats>();
    const recent = deferred<{ items: RequestListItem[] }>();
    const comparison = deferred<DashboardStats>();
    mocks.getStats
      .mockReset()
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(comparison.promise);
    mocks.listRequests.mockReset().mockReturnValueOnce(recent.promise);

    const loading = load({ url: new URL('https://admin.test/') } as never);
    const callsBeforeAnyReadSettles = {
      stats: mocks.getStats.mock.calls.length,
      requests: mocks.listRequests.mock.calls.length,
    };

    current.resolve(statsWith({ requests: 20 }));
    recent.resolve({ items: [] });
    comparison.resolve(statsWith({ requests: 10 }));
    await loading;

    expect(callsBeforeAnyReadSettles).toEqual({ stats: 2, requests: 1 });
  });

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

  it('computes vs-day-before deltas on the yesterday view (full day vs full day)', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mocks.getStats
      .mockReset()
      .mockResolvedValueOnce(
        statsWith({
          requests: 120,
          promptTokens: 400,
          completionTokens: 100,
          cachedTokens: 80,
          totalCostUsd: 40,
        }),
      ) // yesterday, full day (the headline aggregate)
      .mockResolvedValueOnce(
        statsWith({
          requests: 60,
          promptTokens: 200,
          completionTokens: 50,
          cachedTokens: 20,
          totalCostUsd: 20,
        }),
      ); // day before yesterday, full day (the baseline)

    const result = (await load({
      url: new URL('https://admin.test/?range=yesterday'),
    } as never)) as {
      range: string;
      compare: Record<string, { pct: number | null; base: number }> | null;
    };

    expect(result.range).toBe('yesterday');
    expect(mocks.getStats).toHaveBeenCalledTimes(2); // yesterday + day-before-yesterday
    expect(result.compare).toEqual({
      requests: { pct: 100, base: 60 }, // (120-60)/60
      totalTokens: { pct: 100, base: 250 }, // 500 vs 250
      inputTokens: { pct: 100, base: 200 },
      outputTokens: { pct: 100, base: 50 },
      cachedTokens: { pct: 300, base: 20 }, // (80-20)/20
      totalCost: { pct: 100, base: 20 },
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
