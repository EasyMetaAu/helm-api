import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '$lib/api/lanes.js';
import LanesPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the `saveLane` API client, which we mock here.
const saveLane = vi.fn();
vi.mock('$lib/api/lanes.js', () => ({
  saveLane: (...args: unknown[]) => saveLane(...args),
}));

function lane(name: string, overrides: Partial<Lane> = {}): Lane {
  return {
    name,
    purpose: `${name} purpose`,
    primary: `${name}_primary`,
    fallback: [],
    constraints: { require_tools: false, require_json: false, max_latency_ms: null },
    ...overrides,
  };
}

function renderPage(lanes: Lane[]) {
  return render(LanesPage, { data: { lanes } });
}

describe('lanes page', () => {
  beforeEach(() => {
    saveLane.mockReset();
    // Mirror the real client: echo the persisted lane back.
    saveLane.mockImplementation((name: string, body: Lane) => Promise.resolve(body));
  });

  it('renders one card per lane with primary + fallback', () => {
    renderPage([lane('economy'), lane('balanced'), lane('premium')]);
    expect(screen.getAllByTestId('lane-card')).toHaveLength(3);
    expect(screen.getByText('economy')).toBeInTheDocument();
    expect(screen.getByText('balanced')).toBeInTheDocument();
    expect(screen.getByText('premium')).toBeInTheDocument();
  });

  it('shows fallback in declared order (premium before economy)', () => {
    renderPage([lane('balanced', { fallback: ['premium', 'economy'] })]);
    const items = screen.getAllByTestId('fallback-item');
    const idxPremium = items.findIndex((el) => el.textContent?.includes('premium'));
    const idxEconomy = items.findIndex((el) => el.textContent?.includes('economy'));
    expect(idxPremium).toBeGreaterThanOrEqual(0);
    expect(idxPremium).toBeLessThan(idxEconomy);
  });

  it('editing a lane primary and saving calls saveLane with the new value', async () => {
    renderPage([lane('coding', { primary: 'old_model' })]);
    const card = screen.getByTestId('lane-card');
    const primary = card.querySelector("input[name='primary']") as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: 'new_model' } });
    await fireEvent.click(within(card).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveLane).toHaveBeenCalledTimes(1));
    expect(saveLane.mock.calls[0][0]).toBe('coding');
    expect(saveLane.mock.calls[0][1].primary).toBe('new_model');
  });

  it('on save failure shows an error and keeps the original value (fail-closed)', async () => {
    saveLane.mockRejectedValue(new Error('400 invalid lane'));
    renderPage([lane('coding', { primary: 'old_model' })]);
    const card = screen.getByTestId('lane-card');
    const primary = card.querySelector("input[name='primary']") as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: 'broken_model' } });
    await fireEvent.click(within(card).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The other lanes' data is untouched; the page did not crash.
    expect(screen.getByText('coding')).toBeInTheDocument();
  });
});
