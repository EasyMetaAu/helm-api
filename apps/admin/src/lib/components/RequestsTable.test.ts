import { fireEvent, render, screen } from '@testing-library/svelte';
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
