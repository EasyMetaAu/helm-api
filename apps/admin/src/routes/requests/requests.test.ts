import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import type { RequestDetail, RequestListItem } from '$lib/api/requests.js';
import { DEFAULT_FILTERS, type RequestsFilters } from '$lib/requests-filters.js';
import DetailPage from './[traceId]/+page.svelte';
import { load as loadDetail, safeBackTo } from './[traceId]/+page.js';
import ListPage from './+page.svelte';

// The Debug UI is a READ-ONLY consumer of /admin/api/* — it renders the trail the
// backend recorded and re-computes nothing (docs/07, Principle 1). The list/detail
// clients are mocked; we assert docs/07 list/detail fields, the Principle 5 separation of
// classification-stage vs execution-stage fallback, and Principle 7 redaction.

const getRequest = vi.fn();
const getRequestPayload = vi.fn();
vi.mock('$lib/api/requests.js', () => ({
  getRequest: (...args: unknown[]) => getRequest(...args),
  getRequestPayload: (...args: unknown[]) => getRequestPayload(...args),
}));

function item(traceId: string, overrides: Partial<RequestListItem> = {}): RequestListItem {
  return {
    trace_id: traceId,
    ts: '2026-05-31T10:00:00Z',
    key_prefix: 'helm_live_ab12',
    key_name: null,
    requested_model: 'gpt-4o',
    task_type: 'coding',
    complexity: 'high',
    decided_by: 'rules',
    lane: 'premium',
    final_model: 'claude-x',
    fallback_count: 1,
    status: 'ok',
    latency_ms: 460,
    cost_usd: 0.0123,
    usage: { input: 1200, output: 340, cached: 800, cacheCreation: 64, nonCached: 400, total: 1540 },
    tps: 200,
    ...overrides,
  };
}

// Build the loader's page envelope (items + totals + filters). Defaults to a
// single unfiltered page so the common case stays terse.
function listData(
  items: RequestListItem[],
  over: { total?: number; page?: number; pageSize?: number; filters?: RequestsFilters } = {},
) {
  return {
    items,
    total: over.total ?? items.length,
    page: over.page ?? 1,
    pageSize: over.pageSize ?? 50,
    filters: over.filters ?? DEFAULT_FILTERS,
  };
}

function detail(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    trace_id: 'tr_1',
    ts: '2026-05-31T10:00:00Z',
    key_prefix: 'helm_live_ab12',
    key_name: 'Production backend',
    requested_model: 'gpt-4o',
    final_model: 'claude-x',
    lane: 'premium',
    status: 'ok',
    latency_ms: 460,
    request_meta: { requested_model: 'gpt-4o' },
    payload_summary: 'payload withheld (redacted — only routing metadata is stored)',
    classifier_output: {
      task_type: 'coding',
      complexity: 'high',
      confidence: 0.91,
      decided_by: 'rules',
      rules_confidence: 0.91,
      matched_dimensions: ['has_code_fence'],
      constraints: { require_tools: true },
    },
    eval_triggered: false,
    eval_cache_hit: null,
    eval_model: null,
    eval_latency_ms: null,
    eval_fallback_reason: null,
    matched_policy: 'policy_x',
    lane_candidates: ['premium', 'balanced'],
    provider_attempts: [
      {
        model: 'claude-x',
        provider: 'anthropic',
        outcome: 'success',
        latency_ms: 340,
        error_detail: null,
      },
    ],
    response_meta: { model_alias: 'claude-x' },
    error: null,
    cost_breakdown: {
      routing_usd: 0.0001,
      eval_usd: 0.0002,
      completion_usd: 0.01,
      total_usd: 0.0103,
    },
    usage: { input: 1200, output: 340, cached: 800, cacheCreation: 64, nonCached: 400, total: 1540 },
    tps: 200,
    generation_ms: 1700,
    ttfb_ms: 460,
    ...overrides,
  };
}

describe('requests list page', () => {
  it('renders every docs/07 list field per row and shows the key by prefix only', () => {
    render(ListPage, {
      data: listData([
        item('tr_a', { decided_by: 'rules' }),
        item('tr_b', {
          status: 'error',
          decided_by: 'default',
          error_class: 'all_providers_failed',
        }),
      ]),
    });
    const rows = screen.getAllByTestId('request-row');
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first).toHaveTextContent('helm_live_ab12'); // key prefix
    expect(first).toHaveTextContent('gpt-4o'); // requested_model
    expect(first).toHaveTextContent('coding'); // task_type
    expect(first).toHaveTextContent('high'); // complexity
    expect(first).toHaveTextContent('rules'); // decided_by
    expect(first).toHaveTextContent('premium'); // lane
    expect(first).toHaveTextContent('claude-x'); // final_model
    expect(first).toHaveTextContent('460'); // latency_ms
    expect(within(first).getByTestId('cell-tps')).toHaveTextContent('200 tok/s'); // true TPS
    expect(first).toHaveTextContent(/0\.0123|0\.012/); // cost
    expect(first).toHaveTextContent('1'); // fallback_count
    // The error row surfaces error_class as a human label (raw code in the title attr).
    expect(rows[1]).toHaveTextContent('All providers failed');
    // No plaintext-like long secret anywhere.
    expect(document.body.textContent ?? '').not.toMatch(/helm_live_[A-Za-z0-9]{16,}/);
  });

  it('shows the key NAME when set (prefix as a subtitle), and the bare prefix when unnamed', () => {
    render(ListPage, {
      data: listData([
        item('tr_named', { key_name: 'Production backend' }),
        item('tr_unnamed', { key_name: null }),
      ]),
    });
    const rows = screen.getAllByTestId('request-row');
    // Named key: the recognizable name shows, with the prefix still present for traceability.
    expect(rows[0]).toHaveTextContent('Production backend');
    expect(rows[0]).toHaveTextContent('helm_live_ab12');
    // Unnamed key: only the prefix (no stray name).
    expect(rows[1]).toHaveTextContent('helm_live_ab12');
    expect(rows[1]).not.toHaveTextContent('Production backend');
  });

  it('labels the decision layer distinctly for rules / eval / default', () => {
    render(ListPage, {
      data: listData([
        item('tr_r', { decided_by: 'rules' }),
        item('tr_e', { decided_by: 'eval' }),
        item('tr_d', { decided_by: 'default' }),
      ]),
    });
    const rows = screen.getAllByTestId('request-row');
    expect(within(rows[0]).getByTestId('decided-by')).toHaveTextContent('rules');
    expect(within(rows[1]).getByTestId('decided-by')).toHaveTextContent('eval');
    expect(within(rows[2]).getByTestId('decided-by')).toHaveTextContent('default');
  });

  it('links each row to its detail route, carrying the current list URL as `from`', () => {
    render(ListPage, { data: listData([item('tr_link')]) });
    const link = screen.getByTestId('request-row').querySelector('a');
    // Default (clean) list URL → from is the bare /requests, so Back returns here.
    expect(link).toHaveAttribute('href', '/requests/tr_link?from=%2Frequests');
  });

  it('carries the active filters into the detail `from` so Back restores them', () => {
    render(ListPage, {
      data: listData([item('tr_link')], {
        filters: { range: 'all', status: 'error', page: 2, pageSize: 50 },
      }),
    });
    const link = screen.getByTestId('request-row').querySelector('a');
    expect(link).toHaveAttribute(
      'href',
      `/requests/tr_link?from=${encodeURIComponent('/requests?range=all&status=error&page=2')}`,
    );
  });

  it('shows the request ID as the first column and the recorded time, with no separate "view" action', () => {
    render(ListPage, {
      data: listData([item('tr_first', { ts: '2026-05-31T10:00:00Z' })]),
    });
    const cells = screen.getByTestId('request-row').querySelectorAll('td');
    // Request ID is the FIRST column.
    expect(cells[0]).toHaveTextContent('tr_first');
    // The time column (second) renders the recorded timestamp (year is locale-stable).
    expect(cells[1]).toHaveTextContent('2026');
    // The trailing "view" link is gone — the whole row is the link now.
    expect(screen.queryByText('view')).not.toBeInTheDocument();
  });

  it('navigates to the detail page when the row itself is clicked', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, { data: listData([item('tr_go')]) });
    await fireEvent.click(screen.getByTestId('request-row'));
    expect(goto).toHaveBeenCalledWith('/requests/tr_go?from=%2Frequests');
  });

  it('clicking a row key scopes the list to that key (key_id filter)', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, { data: listData([item('tr_k', { key_id: 'k_42' })]) });
    // The key cell is a filter button (so the row click does NOT open the detail).
    await fireEvent.click(screen.getByTestId('key-filter'));
    expect(goto).toHaveBeenCalledWith('?key_id=k_42', expect.anything());
  });

  it('shows a removable chip for the active key filter and clears it', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, {
      data: listData([item('tr_k', { key_name: 'Prod', key_id: 'k_42' })], {
        filters: { ...DEFAULT_FILTERS, keyId: 'k_42' },
      }),
    });
    // The chip labels itself from the matching row (name preferred over prefix).
    expect(screen.getByTestId('key-filter-chip')).toHaveTextContent('Prod');
    // Clearing drops key_id → back to the clean default URL.
    await fireEvent.click(screen.getByTestId('key-filter-clear'));
    expect(goto).toHaveBeenCalledWith('?', expect.anything());
  });

  it('shows an empty state when there are no requests', () => {
    render(ListPage, { data: listData([], { total: 0 }) });
    expect(screen.getByTestId('requests-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('request-row')).not.toBeInTheDocument();
  });

  it('renders the pager status (page X of Y · N requests) from the totals', () => {
    render(ListPage, { data: listData([item('tr_a')], { total: 120, page: 2, pageSize: 50 }) });
    const status = screen.getByTestId('pager-status');
    expect(status).toHaveTextContent('2'); // current page
    expect(status).toHaveTextContent('3'); // ceil(120/50) = 3 pages
    expect(status).toHaveTextContent('120'); // total
  });

  it('disables Previous on page 1 and Next on the last page', () => {
    const { unmount } = render(ListPage, {
      data: listData([item('tr_a')], { total: 120, page: 1, pageSize: 50 }),
    });
    expect(screen.getByTestId('pager-prev')).toBeDisabled();
    expect(screen.getByTestId('pager-next')).not.toBeDisabled();
    unmount();
    render(ListPage, { data: listData([item('tr_a')], { total: 120, page: 3, pageSize: 50 }) });
    expect(screen.getByTestId('pager-next')).toBeDisabled();
    expect(screen.getByTestId('pager-prev')).not.toBeDisabled();
  });

  it('paging Next navigates with the page in the querystring', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, { data: listData([item('tr_a')], { total: 120, page: 1, pageSize: 50 }) });
    await fireEvent.click(screen.getByTestId('pager-next'));
    expect(goto).toHaveBeenCalledWith('?page=2', expect.anything());
  });

  it('renders numbered page links with the current page marked, others as hrefs', () => {
    // total 1000 / 50 = 20 pages, current 10 → 1 … 9 [10] 11 … 20
    render(ListPage, { data: listData([item('tr_a')], { total: 1000, page: 10, pageSize: 50 }) });
    const current = screen.getByTestId('pager-page-current');
    expect(current).toHaveTextContent('10');
    expect(current.getAttribute('aria-current')).toBe('page');

    // Other numbers are real <a> links carrying the target page (page 1 → clean '?').
    const links = screen.getAllByTestId('pager-page');
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('?'); // page 1 omits the param
    expect(hrefs).toContain('?page=11');
    expect(hrefs).toContain('?page=20'); // last page always shown
  });

  it('changing rows-per-page navigates with pageSize (and resets to page 1)', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, { data: listData([item('tr_a')], { total: 1000, page: 5, pageSize: 50 }) });
    await fireEvent.change(screen.getByTestId('pager-page-size'), { target: { value: '100' } });
    expect(goto).toHaveBeenCalledWith('?pageSize=100', expect.anything());
  });

  it('changing a filter navigates with the filter in the querystring (resets to page 1)', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, { data: listData([item('tr_a')], { total: 120, page: 2, pageSize: 50 }) });
    await fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'error' } });
    expect(goto).toHaveBeenCalledWith('?status=error', expect.anything());
  });

  it('Reset clears the querystring back to defaults', async () => {
    vi.mocked(goto).mockClear();
    render(ListPage, {
      data: listData([item('tr_a')], {
        filters: { range: '7d', status: 'error', page: 1, pageSize: 50 },
      }),
    });
    await fireEvent.click(screen.getByTestId('filter-reset'));
    expect(goto).toHaveBeenCalledWith('?', expect.anything());
  });
});

describe('requests detail page', () => {
  beforeEach(() => {
    getRequest.mockReset();
  });

  it('Back link returns to the originating page passed via the loader (backTo)', () => {
    render(DetailPage, {
      data: {
        detail: detail(),
        payload: { captured: false },
        traceId: 'tr_1',
        backTo: '/requests?status=error&page=2',
      },
    });
    expect(screen.getByTestId('back-to-requests')).toHaveAttribute(
      'href',
      '/requests?status=error&page=2',
    );
  });

  it('Back link falls back to the bare list when no backTo was provided', () => {
    render(DetailPage, {
      data: { detail: detail(), payload: { captured: false }, traceId: 'tr_1' },
    });
    expect(screen.getByTestId('back-to-requests')).toHaveAttribute('href', '/requests');
  });

  it('renders the decision chain, cost breakdown (incl. eval) and a not-recorded notice when capture is off', () => {
    render(DetailPage, {
      data: { detail: detail(), payload: { captured: false }, traceId: 'tr_1' },
    });
    // Decision chain present.
    expect(screen.getByTestId('chain-classifier')).toBeInTheDocument();
    expect(screen.getByTestId('chain-lanes')).toBeInTheDocument();
    expect(screen.getByTestId('chain-attempts')).toBeInTheDocument();
    // Cost breakdown shows all four parts, including eval self-cost.
    const cost = screen.getByTestId('cost-breakdown');
    expect(within(cost).getByTestId('cost-routing')).toBeInTheDocument();
    expect(within(cost).getByTestId('cost-eval')).toBeInTheDocument();
    expect(within(cost).getByTestId('cost-completion')).toBeInTheDocument();
    expect(within(cost).getByTestId('cost-total')).toBeInTheDocument();
    // Capture was off → a clear not-recorded notice instead of the full body.
    expect(screen.getByTestId('payload-summary')).toHaveTextContent(/not recorded/i);
  });

  it('renders a Request summary card with key (name+prefix), requested+served model, lane, status, latency', () => {
    render(DetailPage, {
      data: { detail: detail(), payload: { captured: false }, traceId: 'tr_1' },
    });
    const summary = screen.getByTestId('request-summary');
    expect(summary).toHaveTextContent('Production backend'); // key name
    expect(summary).toHaveTextContent('helm_live_ab12'); // key prefix (traceability)
    expect(summary).toHaveTextContent('gpt-4o'); // requested model
    expect(summary).toHaveTextContent('claude-x'); // served model
    expect(summary).toHaveTextContent('premium'); // lane
    expect(summary).toHaveTextContent('460ms'); // total latency
  });

  it('falls back to the prefix (and "—") in the summary for an unnamed/legacy record', () => {
    render(DetailPage, {
      data: {
        detail: detail({ key_name: null, key_prefix: null, final_model: null, latency_ms: null }),
        payload: { captured: false },
        traceId: 'tr_1',
      },
    });
    const summary = screen.getByTestId('request-summary');
    // No key name and no prefix → the key cell degrades to the em-dash, never blank
    // and never a fabricated value (Principle 7).
    expect(summary).toHaveTextContent('—');
    expect(summary).not.toHaveTextContent('Production backend');
  });

  it('renders the throughput card: true TPS, time-to-first-token, and the generation window', () => {
    render(DetailPage, {
      data: { detail: detail(), payload: { captured: false }, traceId: 'tr_1' },
    });
    const tp = screen.getByTestId('throughput');
    expect(within(tp).getByTestId('tps')).toHaveTextContent('200 tok/s');
    expect(within(tp).getByTestId('ttfb')).toHaveTextContent('460ms');
    expect(within(tp).getByTestId('generation-ms')).toHaveTextContent('1700ms');
  });

  it('renders the throughput card as not-measured for a non-streaming request', () => {
    render(DetailPage, {
      data: {
        detail: detail({ tps: null, generation_ms: null, ttfb_ms: null }),
        payload: { captured: false },
        traceId: 'tr_1',
      },
    });
    const tp = screen.getByTestId('throughput');
    expect(within(tp).getByTestId('tps')).toHaveTextContent('—');
    expect(within(tp).getByTestId('ttfb')).toHaveTextContent('—');
    expect(within(tp).getByTestId('generation-ms')).toHaveTextContent('—');
  });

  it('renders the full captured request and response bodies when capture is on', () => {
    render(DetailPage, {
      data: {
        detail: detail(),
        payload: { captured: true, request: { model: 'auto' }, response: { ok: true } },
        traceId: 'tr_1',
      },
    });
    expect(screen.getByTestId('request-body')).toHaveTextContent(/"model": "auto"/);
    expect(screen.getByTestId('response-body')).toHaveTextContent(/"ok": true/);
  });

  it('enables Retry for any captured protocol body, disabled only when nothing was captured', () => {
    // Responses (input[]) and Gemini (contents[]) bodies have NO `messages` array —
    // the old gate wrongly disabled Retry for them. The server now recovers the
    // protocol and re-issues natively, so the button is enabled whenever a body was
    // captured (regression: the GPT/Codex requests that were stuck disabled).
    const responses = render(DetailPage, {
      data: {
        detail: detail(),
        payload: { captured: true, request: { model: 'gpt-5.5', input: 'hi' }, response: {} },
        traceId: 'tr_resp',
      },
    });
    expect(screen.getByTestId('retry-request')).not.toBeDisabled();
    responses.unmount();

    const gemini = render(DetailPage, {
      data: {
        detail: detail(),
        payload: {
          captured: true,
          request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
          response: {},
        },
        traceId: 'tr_gem',
      },
    });
    expect(screen.getByTestId('retry-request')).not.toBeDisabled();
    gemini.unmount();

    // Capture off → no body to re-issue → the button stays disabled.
    render(DetailPage, {
      data: { detail: detail(), payload: { captured: false }, traceId: 'tr_off' },
    });
    expect(screen.getByTestId('retry-request')).toBeDisabled();
  });

  it('surfaces a structured error with class, status, redacted message and redacted provider_raw', () => {
    render(DetailPage, {
      data: {
        detail: detail({
          status_is_error_marker: undefined,
          error: {
            error_class: 'all_providers_failed',
            http_status: 502,
            message: 'all providers failed',
            provider_raw: null,
          },
        } as Partial<RequestDetail>),
        payload: { captured: false },
        traceId: 'tr_err',
      },
    });
    const err = screen.getByTestId('request-error');
    expect(err).toHaveTextContent('All providers failed');
    expect(err).toHaveTextContent('502');
    expect(err).toHaveTextContent(/all providers failed/);
    // trace_id is copyable.
    expect(screen.getByTestId('copy-trace')).toBeInTheDocument();
  });

  it('shows a friendly error state when the trace cannot be loaded (no white screen)', () => {
    render(DetailPage, {
      data: {
        detail: null,
        payload: { captured: false },
        traceId: 'missing',
        loadError: 'not found',
      },
    });
    expect(screen.getByTestId('detail-error')).toBeInTheDocument();
  });
});

describe('requests detail loader (payload fails open, detail is fatal)', () => {
  // The loader only reads params.traceId + url.searchParams — a minimal stub is enough.
  // `PageLoad` widens the return to `void | …`; narrow it back to the real object shape.
  async function runLoad(traceId: string): Promise<Exclude<Awaited<ReturnType<typeof loadDetail>>, void>> {
    const event = {
      params: { traceId },
      url: new URL(`http://localhost/requests/${traceId}`),
    } as unknown as Parameters<typeof loadDetail>[0];
    return (await loadDetail(event)) as Exclude<Awaited<ReturnType<typeof loadDetail>>, void>;
  }

  beforeEach(() => {
    getRequest.mockReset();
    getRequestPayload.mockReset();
  });

  it('still returns the detail when the payload fetch fails — a body error must not sink the page', async () => {
    getRequest.mockResolvedValue(detail());
    getRequestPayload.mockRejectedValue(new Error('payload timeout'));
    const data = await runLoad('tr_1');
    // The decision trail renders; the payload merely fails open to "not captured".
    expect(data.detail).not.toBeNull();
    expect(data.payload).toEqual({ captured: false });
    expect(data.loadError).toBeUndefined();
  });

  it('surfaces a retryable error state only when the detail itself fails', async () => {
    getRequest.mockRejectedValue(new Error('not found'));
    getRequestPayload.mockResolvedValue({ captured: false });
    const data = await runLoad('missing');
    expect(data.detail).toBeNull();
    expect(data.loadError).toBe('not found');
  });
});

describe('safeBackTo (Back-link open-redirect guard)', () => {
  it('keeps a same-app relative path verbatim (filters survive)', () => {
    expect(safeBackTo('/requests?status=error&page=2', '/requests')).toBe(
      '/requests?status=error&page=2',
    );
    expect(safeBackTo('/keys/k1?range=7d', '/requests')).toBe('/keys/k1?range=7d');
  });

  it('falls back for missing / scheme / protocol-relative / backslash targets', () => {
    for (const bad of [null, '', '//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:1']) {
      expect(safeBackTo(bad, '/requests')).toBe('/requests');
    }
  });
});
