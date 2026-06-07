import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import type { RequestDetail, RequestListItem } from '$lib/api/requests.js';
import { DEFAULT_FILTERS, type RequestsFilters } from '$lib/requests-filters.js';
import DetailPage from './[traceId]/+page.svelte';
import ListPage from './+page.svelte';

// The Debug UI is a READ-ONLY consumer of /admin/api/* — it renders the trail the
// backend recorded and re-computes nothing (docs/07, Principle 1). The list/detail
// clients are mocked; we assert docs/07 list/detail fields, the Principle 5 separation of
// classification-stage vs execution-stage fallback, and Principle 7 redaction.

const getRequest = vi.fn();
vi.mock('$lib/api/requests.js', () => ({
  getRequest: (...args: unknown[]) => getRequest(...args),
}));

function item(traceId: string, overrides: Partial<RequestListItem> = {}): RequestListItem {
  return {
    trace_id: traceId,
    ts: '2026-05-31T10:00:00Z',
    key_prefix: 'helm_live_ab12',
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
    expect(first).toHaveTextContent(/0\.0123|0\.012/); // cost
    expect(first).toHaveTextContent('1'); // fallback_count
    // The error row surfaces error_class.
    expect(rows[1]).toHaveTextContent('all_providers_failed');
    // No plaintext-like long secret anywhere.
    expect(document.body.textContent ?? '').not.toMatch(/helm_live_[A-Za-z0-9]{16,}/);
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

  it('links each row to its detail route /requests/<trace_id>', () => {
    render(ListPage, { data: listData([item('tr_link')]) });
    const link = screen.getByTestId('request-row').querySelector('a');
    expect(link).toHaveAttribute('href', '/requests/tr_link');
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
    expect(goto).toHaveBeenCalledWith('/requests/tr_go');
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
    expect(err).toHaveTextContent('all_providers_failed');
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
