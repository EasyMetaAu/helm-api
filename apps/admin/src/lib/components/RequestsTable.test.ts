import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { RequestListItem } from '$lib/api/requests.js';
import RequestsTable from './RequestsTable.svelte';

// The shared request-list table renders the full decision trail (docs/07) for all
// three callers. These cover the per-caller Key-cell branches; the /requests page's
// in-page filter behavior is covered end-to-end in routes/requests/requests.test.ts.

function item(overrides: Partial<RequestListItem> = {}): RequestListItem {
  return {
    trace_id: 'tr_1',
    ts: '2026-05-31T10:00:00Z',
    key_id: 'k_42',
    key_prefix: 'helm_live_ab12',
    key_name: 'Prod',
    requested_model: 'gpt-4o',
    task_type: 'coding',
    complexity: 'high',
    decided_by: 'rules',
    lane: 'premium',
    served_provider: 'anthropic',
    serving_account: { provider_id: 'anthropic', account: 'claude-team-a' },
    final_model: 'claude-x',
    fallback_count: 1,
    status: 'ok',
    stream_outcome: 'completed',
    latency_ms: 460,
    cost_usd: 0.0123,
    usage: {
      measurement: 'reported',
      input: 1200,
      output: 340,
      cached: 800,
      cacheCreation: 64,
      nonCached: 400,
      total: 1540,
    },
    tps: 200,
    ...overrides,
  };
}

const detailHref = (id: string) => `/requests/${id}`;

describe('RequestsTable key cell', () => {
  it('renders the key as a filter LINK when given keyHref (the dashboard)', () => {
    render(RequestsTable, {
      items: [item()],
      detailHref,
      keyHref: (keyId: string) => `/requests?key_id=${keyId}&range=all`,
    });
    const cell = screen.getByTestId('key-filter');
    expect(cell.tagName).toBe('A');
    expect(cell).toHaveAttribute('href', '/requests?key_id=k_42&range=all');
  });

  it('renders the key as a filter BUTTON when given onKeyFilter (the /requests list)', async () => {
    const onKeyFilter = vi.fn();
    render(RequestsTable, { items: [item()], detailHref, onKeyFilter });
    const cell = screen.getByTestId('key-filter');
    expect(cell.tagName).toBe('BUTTON');
    await fireEvent.click(cell);
    expect(onKeyFilter).toHaveBeenCalledWith('k_42');
  });

  it('drops the Key column entirely when showKey is false (the key-detail page)', () => {
    render(RequestsTable, {
      items: [item()],
      detailHref,
      keyHref: (keyId: string) => `/x?${keyId}`,
      showKey: false,
    });
    expect(screen.queryByTestId('key-filter')).toBeNull();
    expect(screen.queryByText('Key')).toBeNull();
  });
});

describe('RequestsTable variants', () => {
  it('renders the full request-audit columns as grouped cells', () => {
    render(RequestsTable, {
      items: [item({ latency_ms: 6911 })],
      detailHref,
      variant: 'full',
    });

    const row = screen.getByTestId('request-row');
    expect(within(row).getByTestId('cell-result')).toHaveTextContent('ok');
    expect(within(row).getByTestId('cell-model')).toHaveTextContent('claude-x');
    expect(within(row).getByTestId('cell-model')).toHaveTextContent('requested: gpt-4o');
    expect(within(row).getByTestId('cell-routing')).toHaveTextContent('premium');
    expect(within(row).getByTestId('cell-routing')).toHaveTextContent('coding');
    expect(within(row).getByTestId('cell-serving')).toHaveTextContent('anthropic');
    expect(within(row).getByTestId('cell-serving')).toHaveTextContent('exec +1');
    expect(within(row).getByTestId('cell-performance')).toHaveTextContent('6.9s');
    expect(screen.getByText('Request ID')).toBeInTheDocument();
  });

  it('formats performance latency in minutes from sixty seconds', () => {
    render(RequestsTable, { items: [item({ latency_ms: 90_000 })], detailHref });

    expect(screen.getByTestId('cell-performance')).toHaveTextContent('1.5min');
  });

  it('shows a partial result and approximate cost for an estimated truncated stream', () => {
    render(RequestsTable, {
      items: [
        item({
          status: 'error',
          stream_outcome: 'truncated',
          usage: { ...item().usage, measurement: 'estimated_partial' },
        }),
      ],
      detailHref,
    });

    expect(screen.getByTestId('cell-result')).toHaveTextContent(/partial/i);
    expect(screen.getByTestId('cell-cost')).toHaveTextContent('≈$0.0123');
    expect(screen.getByTestId('usage-measurement')).toHaveTextContent(/estimated/i);
  });

  it('keeps an unpriced estimated partial stream unknown instead of showing approximate zero', () => {
    render(RequestsTable, {
      items: [
        item({
          status: 'error',
          stream_outcome: 'client_aborted',
          cost_usd: null,
          usage: { ...item().usage, measurement: 'estimated_partial' },
        }),
      ],
      detailHref,
    });

    expect(screen.getByTestId('tokens-cell')).toHaveTextContent('1.2K');
    expect(screen.getByTestId('cell-cost')).toHaveTextContent('—');
    expect(screen.getByTestId('cell-cost')).not.toHaveTextContent('≈$0');
  });

  it('keeps the request-list metric columns and hides only Request ID in the dashboard recent variant', () => {
    render(RequestsTable, { items: [item()], detailHref, variant: 'recent' });

    const row = screen.getByTestId('request-row');
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Performance')).toBeInTheDocument();
    expect(screen.queryByText('Metrics')).toBeNull();
    expect(within(row).getByText('$0.0123')).toBeInTheDocument();
    expect(within(row).getByTestId('tokens-cell')).toHaveTextContent('↑ 1.2K');
    expect(within(row).getByTestId('tokens-cell')).toHaveTextContent('↓ 340');
    expect(within(row).getByTestId('tokens-cell')).toHaveTextContent('cached 800');
    expect(within(row).getByTestId('cell-performance')).toHaveTextContent('460ms');
    expect(within(row).getByTestId('cell-routing')).toHaveTextContent('coding');
    expect(within(row).getByTestId('cell-serving')).toHaveTextContent('claude-team-a');
    expect(within(row).getByTestId('request-detail-link')).toHaveAttribute(
      'href',
      '/requests/tr_1',
    );
    expect(screen.queryByText('Request ID')).toBeNull();
  });

  it('uses the key-detail variant without repeating the already-scoped key', () => {
    render(RequestsTable, { items: [item()], detailHref, variant: 'key' });

    expect(screen.queryByText('Key')).toBeNull();
    expect(screen.queryByText('Request ID')).toBeNull();
    expect(screen.getByTestId('request-detail-link')).toHaveAttribute('href', '/requests/tr_1');
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Performance')).toBeInTheDocument();
    expect(screen.queryByText('Metrics')).toBeNull();
  });

  it('keeps unknown token usage as unknown in the shared token column', () => {
    render(RequestsTable, {
      items: [
        item({
          usage: {
            measurement: 'unknown',
            input: null,
            output: null,
            cached: null,
            cacheCreation: null,
            nonCached: null,
            total: null,
          },
        }),
      ],
      detailHref,
      variant: 'recent',
    });

    expect(screen.getByTestId('tokens-cell')).not.toHaveTextContent('— tok');
    expect(screen.getByTestId('tokens-cell')).toHaveTextContent('—');
  });

  it('does not repeat normal auto-routing requests as requested-model drift', () => {
    render(RequestsTable, {
      items: [item({ requested_model: 'auto', final_model: 'claude-x' })],
      detailHref,
      variant: 'full',
    });

    expect(screen.getByTestId('cell-model')).toHaveTextContent('claude-x');
    expect(screen.getByTestId('cell-model')).not.toHaveTextContent('requested: auto');
  });

  it('uses distinct badges for classification fallback and execution fallback', () => {
    render(RequestsTable, {
      items: [item({ decided_by: 'fallback', fallback_count: 2 })],
      detailHref,
      variant: 'full',
    });

    const row = screen.getByTestId('request-row');
    expect(within(row).getByTestId('decided-by')).toHaveClass('badge-classifier-fallback');
    expect(within(row).getByText('exec +2')).toHaveClass('badge-fallback');
  });
});
