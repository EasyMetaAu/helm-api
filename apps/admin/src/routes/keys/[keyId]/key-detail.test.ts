import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from '$lib/api/keys.js';
import type { RequestListItem, RequestsPage } from '$lib/api/requests.js';
import type { DashboardStats } from '$lib/api/stats.js';
import type { KeyDetailFilters } from '$lib/key-detail-filters.js';

// LayerChart touches window.matchMedia at import time (absent in jsdom) — stub it
// so the component can be imported. The charts are guarded off by the empty
// aggregate in these tests, so the stubs are never instantiated anyway.
vi.mock('layerchart', () => ({ AreaChart: () => {}, PieChart: () => {} }));

// The detail page LOADER (scoping + window math + fail-soft) and the COMPONENT
// (config card + scoped request list) are tested separately, mirroring the
// dashboard's split (home.test.ts tests the loader; charts are not rendered in
// jsdom — the component test uses an empty aggregate so LayerChart never mounts).

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
  return { emptyStats, getKey: vi.fn(), getStats: vi.fn(), listRequests: vi.fn() };
});

vi.mock('$lib/api/keys.js', () => ({ getKey: (...a: unknown[]) => mocks.getKey(...a) }));
vi.mock('$lib/api/stats.js', () => ({
  EMPTY_STATS: mocks.emptyStats,
  getStats: (...a: unknown[]) => mocks.getStats(...a),
}));
vi.mock('$lib/api/requests.js', () => ({
  listRequests: (...a: unknown[]) => mocks.listRequests(...a),
}));

import { load } from './+page.js';
import KeyDetailPage from './+page.svelte';

function keyView(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    key_id: 'k1',
    prefix: 'helm_live_ab12',
    role: 'user',
    name: 'Prod backend',
    allowed_lanes: ['balanced'],
    allow_custom_model: false,
    blocked_models: null,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: 'degrade',
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: 'off',
    memory_project_id: null,
    memory_thread_source: 'header',
    request_content_mode: null,
    max_reasoning_effort: null,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('key detail loader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getKey.mockReset().mockResolvedValue(keyView());
    mocks.getStats.mockReset().mockResolvedValue(mocks.emptyStats);
    mocks.listRequests
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('scopes getStats + listRequests to the key id and the resolved today window', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = await load({
      params: { keyId: 'k1' },
      url: new URL('https://admin.test/keys/k1'),
    } as never);

    // Both reads are scoped to the key.
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({ key_id: 'k1' });
    expect(mocks.listRequests.mock.calls[0]?.[0]).toMatchObject({ keyId: 'k1', page: 1 });
    // Default 'today' window: start = local midnight (TZ-independent recompute), end = now.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({
      start: midnight.getTime(),
      end: now,
    });
    expect((result as { filters: KeyDetailFilters }).filters.range).toBe('today');
  });

  it('starts stats and recent requests concurrently after the key resolves', async () => {
    const stats = deferred<DashboardStats>();
    const requests = deferred<RequestsPage>();
    mocks.getStats.mockReset().mockReturnValueOnce(stats.promise);
    mocks.listRequests.mockReset().mockReturnValueOnce(requests.promise);

    const loading = load({
      params: { keyId: 'k1' },
      url: new URL('https://admin.test/keys/k1'),
    } as never);
    await vi.waitFor(() => expect(mocks.getStats).toHaveBeenCalledOnce());
    const requestCallsBeforeStatsSettles = mocks.listRequests.mock.calls.length;

    stats.resolve(mocks.emptyStats);
    requests.resolve({ items: [], total: 0, page: 1, pageSize: 25 });
    await loading;

    expect(requestCallsBeforeStatsSettles).toBe(1);
  });

  it('resolves a custom date range to [midnight(start), midnight(end)+1day)', async () => {
    await load({
      params: { keyId: 'k1' },
      url: new URL('https://admin.test/keys/k1?start=2026-06-01&end=2026-06-01'),
    } as never);
    const arg = mocks.getStats.mock.calls[0]?.[0] as { start: number; end: number };
    expect(arg.start).toBe(new Date('2026-06-01T00:00:00').getTime());
    expect(arg.end).toBe(new Date('2026-06-02T00:00:00').getTime());
  });

  it('throws 404 only when the key genuinely does not exist (getKey → null)', async () => {
    mocks.getKey.mockResolvedValue(null);
    await expect(
      load({ params: { keyId: 'nope' }, url: new URL('https://admin.test/keys/nope') } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('propagates a non-404 admin-API failure instead of masking it as 404', async () => {
    mocks.getKey.mockRejectedValue(new Error('keys api 503'));
    // The real error must surface (a load error), NOT a misleading "key not found".
    await expect(
      load({ params: { keyId: 'k1' }, url: new URL('https://admin.test/keys/k1') } as never),
    ).rejects.toThrow(/503/);
  });

  it('fails soft: a stats/requests error still renders zeroed panels', async () => {
    mocks.getStats.mockRejectedValue(new Error('boom'));
    mocks.listRequests.mockRejectedValue(new Error('boom'));
    const result = (await load({
      params: { keyId: 'k1' },
      url: new URL('https://admin.test/keys/k1'),
    } as never)) as { stats: { total: number }; requests: RequestsPage };
    expect(result.stats.total).toBe(0);
    expect(result.requests.items).toEqual([]);
  });
});

function requestItem(traceId: string): RequestListItem {
  return {
    request_id: traceId,
    trace_id: traceId,
    ts: new Date(1_700_000_000_000).toISOString(),
    key_prefix: 'helm_live_ab12',
    key_name: 'Prod backend',
    session: null,
    requested_model: 'gpt-4o',
    requested_reasoning_effort: null,
    reasoning_effort: null,
    task_type: 'coding',
    complexity: 'complex',
    decided_by: 'rules',
    lane: 'balanced',
    served_provider: 'openai',
    serving_account: null,
    final_model: 'gpt-4o',
    fallback_count: 0,
    status: 'ok',
    stream_outcome: 'completed',
    latency_ms: 1200,
    cost_usd: 0.004,
    request_body_bytes: null,
    usage: {
      measurement: 'reported',
      input: 100,
      output: 20,
      cached: 0,
      cacheCreation: 0,
      nonCached: 100,
      total: 120,
    },
    tps: 30,
  };
}

function pageData(
  over: {
    key?: ApiKeyView;
    requests?: RequestsPage;
    filters?: KeyDetailFilters;
  } = {},
) {
  return {
    key: over.key ?? keyView(),
    keyId: 'k1',
    filters: over.filters ?? ({ range: 'today', page: 1 } as KeyDetailFilters),
    bucket: 'hour' as const,
    // Empty aggregate → charts render their empty-state, LayerChart never mounts.
    agg: mocks.emptyStats,
    stats: {
      total: 42,
      ok: 40,
      errors: 2,
      successRate: 95,
      avgLatency: 90_000,
      avgTps: 30,
      totalCost: 0.5,
      totalTokens: 1500,
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 100,
      cacheHitRate: 8,
    },
    requests: over.requests ?? { items: [requestItem('tr_1')], total: 1, page: 1, pageSize: 25 },
  };
}

describe('key detail page', () => {
  it('renders the key name, config card, headline stats, and scoped request list', () => {
    render(KeyDetailPage, { data: pageData({ key: keyView({ allow_fast_mode: true }) }) });

    expect(screen.getByRole('heading', { name: /prod backend/i })).toBeInTheDocument();
    expect(screen.getByText('helm_live_ab12')).toBeInTheDocument();
    // Config card surfaces the caps ('balanced' shows in the config + the row lane).
    expect(screen.getByRole('heading', { name: /configuration/i })).toBeInTheDocument();
    expect(screen.getAllByText('balanced').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fast mode/i)).toBeInTheDocument();
    expect(screen.getByText(/^yes$/i)).toBeInTheDocument();
    // Headline request count from stats.
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('1.5min')).toBeInTheDocument();
    // The scoped request row links to the shared request detail page, carrying THIS
    // key page as `from` so the detail's Back link returns here (not the global list).
    const link = screen.getByTestId('request-detail-link');
    expect(link.getAttribute('href')).toBe('/requests/tr_1?from=%2Fkeys%2Fk1');
  });

  it('always links the Memory config to the scoped memory view — even when memory is off', () => {
    const { unmount } = render(KeyDetailPage, {
      data: pageData({ key: keyView({ memory_mode: 'inject', memory_project_id: 'proj-a' }) }),
    });
    // `base` resolves to '' in the test env → /memory?key=k1 (the key's own scope).
    const link = screen.getByRole('link', { name: /manage memory/i });
    expect(link.getAttribute('href')).toBe('/memory?key=k1');
    unmount();

    // Memory off does NOT mean "nothing to manage": switching observe off doesn't
    // erase what the key already learned, and the memory page resolves the scope
    // from the key's config (account + memory_project_id) regardless of mode. So
    // the link MUST stay — otherwise a switched-off key with prior memory has no
    // path to it. This is the fix.
    render(KeyDetailPage, {
      data: pageData({ key: keyView({ memory_mode: 'off', memory_project_id: 'lukin-personal' }) }),
    });
    expect(screen.getByRole('link', { name: /manage memory/i }).getAttribute('href')).toBe(
      '/memory?key=k1',
    );
  });

  it('shows whether request-content storage inherits or overrides the system setting', () => {
    const { unmount } = render(KeyDetailPage, {
      data: pageData({ key: keyView({ request_content_mode: 'payload' }) }),
    });
    expect(screen.getByText('Full payload for every request')).toBeInTheDocument();
    unmount();

    render(KeyDetailPage, { data: pageData({ key: keyView({ request_content_mode: null }) }) });
    expect(screen.getByText('Inherit system setting')).toBeInTheDocument();
  });

  it('shows a "view all" link to the global requests list filtered by key and active window', () => {
    render(KeyDetailPage, {
      data: pageData({
        // 60 in the window, only the most-recent 25 shown → there IS more.
        requests: { items: [requestItem('tr_1')], total: 60, page: 1, pageSize: 25 },
      }),
    });
    // No in-page pager any more — the key page only shows the recent slice.
    expect(screen.queryByTestId('pager-status')).not.toBeInTheDocument();
    // The clean global requests URL defaults to today, so the link only needs key_id.
    const link = screen.getByTestId('view-all-requests');
    expect(link).toHaveAttribute('href', '/requests?key_id=k1');
  });

  it('carries a non-default key detail preset into the global requests list', () => {
    render(KeyDetailPage, {
      data: pageData({
        filters: { range: '7d', page: 1 },
        requests: { items: [requestItem('tr_1')], total: 60, page: 1, pageSize: 25 },
      }),
    });

    expect(screen.getByTestId('view-all-requests')).toHaveAttribute(
      'href',
      '/requests?range=7d&key_id=k1',
    );
  });

  it('carries a custom key detail date range into the global requests list', () => {
    render(KeyDetailPage, {
      data: pageData({
        filters: { range: 'today', startDate: '2026-06-01', endDate: '2026-06-03', page: 1 },
        requests: { items: [requestItem('tr_1')], total: 60, page: 1, pageSize: 25 },
      }),
    });

    expect(screen.getByTestId('view-all-requests')).toHaveAttribute(
      'href',
      '/requests?start=2026-06-01&end=2026-06-03&key_id=k1',
    );
  });

  it('hides the "view all" link when the window\'s requests all fit on the page', () => {
    render(KeyDetailPage, {
      data: pageData({
        requests: { items: [requestItem('tr_1')], total: 1, page: 1, pageSize: 25 },
      }),
    });
    expect(screen.queryByTestId('view-all-requests')).not.toBeInTheDocument();
  });
});
