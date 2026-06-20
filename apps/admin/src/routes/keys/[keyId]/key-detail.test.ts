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
    ...overrides,
  };
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

  it('scopes getStats + listRequests to the key id and the resolved 24h window', async () => {
    const now = Date.UTC(2026, 5, 17, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = await load({
      params: { keyId: 'k1' },
      url: new URL('https://admin.test/keys/k1'),
    } as never);

    // Both reads are scoped to the key.
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({ key_id: 'k1' });
    expect(mocks.listRequests.mock.calls[0]?.[0]).toMatchObject({ keyId: 'k1', page: 1 });
    // Default 24h window: start = now - 24h, end = now.
    expect(mocks.getStats.mock.calls[0]?.[0]).toMatchObject({
      start: now - 86_400_000,
      end: now,
    });
    expect((result as { filters: KeyDetailFilters }).filters.range).toBe('24h');
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
    trace_id: traceId,
    ts: new Date(1_700_000_000_000).toISOString(),
    key_prefix: 'helm_live_ab12',
    key_name: 'Prod backend',
    requested_model: 'gpt-4o',
    task_type: 'coding',
    complexity: 'complex',
    decided_by: 'rules',
    lane: 'balanced',
    final_model: 'gpt-4o',
    fallback_count: 0,
    status: 'ok',
    latency_ms: 1200,
    cost_usd: 0.004,
    usage: { input: 100, output: 20, cached: 0, cacheCreation: 0, nonCached: 100, total: 120 },
    tps: 30,
  };
}

function pageData(over: {
  key?: ApiKeyView;
  requests?: RequestsPage;
  filters?: KeyDetailFilters;
} = {}) {
  return {
    key: over.key ?? keyView(),
    keyId: 'k1',
    filters: over.filters ?? ({ range: '24h', page: 1 } as KeyDetailFilters),
    bucket: 'hour' as const,
    // Empty aggregate → charts render their empty-state, LayerChart never mounts.
    agg: mocks.emptyStats,
    stats: {
      total: 42,
      ok: 40,
      errors: 2,
      successRate: 95,
      avgLatency: 800,
      avgTps: 30,
      totalCost: 0.5,
      totalTokens: 1500,
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 100,
    },
    requests: over.requests ?? { items: [requestItem('tr_1')], total: 1, page: 1, pageSize: 25 },
  };
}

describe('key detail page', () => {
  it('renders the key name, config card, headline stats, and scoped request list', () => {
    render(KeyDetailPage, { data: pageData() });

    expect(screen.getByRole('heading', { name: /prod backend/i })).toBeInTheDocument();
    expect(screen.getByText('helm_live_ab12')).toBeInTheDocument();
    // Config card surfaces the caps ('balanced' shows in the config + the row lane).
    expect(screen.getByRole('heading', { name: /configuration/i })).toBeInTheDocument();
    expect(screen.getAllByText('balanced').length).toBeGreaterThan(0);
    // Headline request count from stats.
    expect(screen.getByText('42')).toBeInTheDocument();
    // The scoped request row links to the shared request detail page.
    const link = screen.getByRole('link', { name: 'tr_1' });
    expect(link.getAttribute('href')).toBe('/requests/tr_1');
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

  it('renders a requests-style pager (numbered links + status) across pages', () => {
    render(KeyDetailPage, {
      data: pageData({
        requests: { items: [requestItem('tr_1')], total: 60, page: 1, pageSize: 25 },
      }),
    });
    // 60 / 25 → 3 pages. Status line mirrors the requests list: "Page X of Y".
    const status = screen.getByTestId('pager-status');
    expect(status.textContent).toMatch(/Page\s*1\s*of\s*3/);

    // Page numbers are real <a> links carrying the page in the querystring (native
    // pointer / open-in-new-tab), not plain buttons like the old pager.
    const page2 = screen.getByRole('link', { name: '2' });
    expect(page2).toHaveAttribute('href', '?page=2');

    // The current page is a marked, non-link cell.
    const current = screen.getByTestId('pager-page-current');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.textContent?.trim()).toBe('1');

    // Prev is disabled on page 1; Next stays available — matching the requests pager.
    expect(screen.getByTestId('pager-prev')).toBeDisabled();
    expect(screen.getByTestId('pager-next')).not.toBeDisabled();
  });

  it('hides the pager when everything fits on one page', () => {
    render(KeyDetailPage, {
      data: pageData({
        requests: { items: [requestItem('tr_1')], total: 1, page: 1, pageSize: 25 },
      }),
    });
    expect(screen.queryByTestId('pager-status')).not.toBeInTheDocument();
  });

  it('preserves a non-default range in the page-number links', () => {
    render(KeyDetailPage, {
      data: pageData({
        filters: { range: '7d', page: 1 } as KeyDetailFilters,
        requests: { items: [requestItem('tr_1')], total: 60, page: 1, pageSize: 25 },
      }),
    });
    // The href must carry the active range so the window survives navigation —
    // the behaviour unique to this pager vs the requests list pager.
    expect(screen.getByRole('link', { name: '2' })).toHaveAttribute('href', '?range=7d&page=2');
  });
});
