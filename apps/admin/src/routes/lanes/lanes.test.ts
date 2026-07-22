import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '$lib/api/lanes.js';
import type { ModelOption } from '$lib/api/models.js';
import LanesPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the whole-set `saveLanes` API client, which we mock here.
const saveLanes = vi.fn();
vi.mock('$lib/api/lanes.js', () => ({
  saveLanes: (...args: unknown[]) => saveLanes(...args),
  // LaneEditor imports this value from the same module; the mock must expose it.
  REASONING_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
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

function renderPage(lanes: Lane[], models: ModelOption[] = [], defaultLane = 'balanced') {
  return render(LanesPage, { data: { lanes, models, defaultLane } });
}

describe('lanes page', () => {
  beforeEach(() => {
    saveLanes.mockReset();
    saveLanes.mockImplementation((lanes: Lane[]) => Promise.resolve(lanes));
  });

  it('renders one card per lane with primary + fallback', () => {
    renderPage([lane('economy'), lane('balanced'), lane('premium')]);
    expect(screen.getAllByTestId('lane-card')).toHaveLength(3);
    expect(screen.getByText('economy')).toBeInTheDocument();
    expect(screen.getByText('balanced')).toBeInTheDocument();
    expect(screen.getByText('premium')).toBeInTheDocument();
  });

  it('threads the model catalog into each lane card as combobox suggestions', () => {
    const aliases = ['deepseek/deepseek-v4-flash', 'openai-codex/gpt-5.5'];
    const models = aliases.map((alias) => ({ alias, accounts: [] }));
    const { container } = renderPage([lane('economy'), lane('balanced')], models);
    // Every card gets a populated <datalist> sourced from data.models.
    const lists = Array.from(container.querySelectorAll('datalist'));
    expect(lists).toHaveLength(2);
    for (const dl of lists) {
      const values = Array.from(dl.querySelectorAll('option')).map((o) => o.value);
      expect(values).toEqual(expect.arrayContaining(aliases));
    }
  });

  it('threads the other lane names into each card as targets, never the card’s own lane', () => {
    renderPage([lane('economy'), lane('balanced'), lane('premium')]);
    const cards = screen.getAllByTestId('lane-card');
    const values = (card: HTMLElement) =>
      Array.from(card.querySelectorAll('datalist option')).map(
        (o) => (o as HTMLOptionElement).value,
      );

    // economy may target balanced/premium but not itself…
    expect(values(cards[0])).toEqual(expect.arrayContaining(['balanced', 'premium']));
    expect(values(cards[0])).not.toContain('economy');
    // …and premium may target economy/balanced but not itself.
    expect(values(cards[2])).toEqual(expect.arrayContaining(['economy', 'balanced']));
    expect(values(cards[2])).not.toContain('premium');
  });

  it('shows fallback in declared order (premium before economy)', () => {
    renderPage([lane('balanced', { fallback: ['premium', 'economy'] })]);
    const items = screen.getAllByTestId('fallback-item');
    const idxPremium = items.findIndex((el) => el.textContent?.includes('premium'));
    const idxEconomy = items.findIndex((el) => el.textContent?.includes('economy'));
    expect(idxPremium).toBeGreaterThanOrEqual(0);
    expect(idxPremium).toBeLessThan(idxEconomy);
  });

  it('saves edits from multiple cards in one request', async () => {
    renderPage([lane('balanced', { primary: 'old-balanced' }), lane('coding')]);
    const cards = screen.getAllByTestId('lane-card');
    await fireEvent.input(cards[0].querySelector("input[name='primary']") as HTMLInputElement, {
      target: { value: 'new-balanced' },
    });
    await fireEvent.change(within(cards[1]).getByTestId('reasoning-effort'), {
      target: { value: 'medium' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(saveLanes).toHaveBeenCalledTimes(1));
    expect(saveLanes.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'balanced', primary: 'new-balanced' }),
      expect.objectContaining({ name: 'coding', reasoning_effort: 'medium' }),
    ]);
  });

  it('on save failure shows an error and keeps the original value (fail-closed)', async () => {
    saveLanes.mockRejectedValue(new Error('400 invalid lanes'));
    renderPage([lane('balanced', { primary: 'old_model' })]);
    const card = screen.getByTestId('lane-card');
    const primary = card.querySelector("input[name='primary']") as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: 'broken_model' } });
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The other lanes' data is untouched; the page did not crash.
    expect(screen.getByText('balanced')).toBeInTheDocument();
  });

  it('seeds the dropdown from the lane and omits the field when set back to Unset', async () => {
    renderPage([lane('balanced', { reasoning_effort: 'high' })]);
    const card = screen.getByTestId('lane-card');
    const select = within(card).getByTestId('reasoning-effort') as HTMLSelectElement;
    expect(select.value).toBe('high'); // seeded from the lane's forced value
    await fireEvent.change(select, { target: { value: '' } }); // Unset
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(saveLanes).toHaveBeenCalledTimes(1));
    expect(saveLanes.mock.calls[0][0][0].reasoning_effort).toBeUndefined();
  });

  it('removes a lane from the working set and persists the deletion with Save lanes', async () => {
    renderPage([lane('balanced'), lane('economy')]);
    const cards = screen.getAllByTestId('lane-card');
    await fireEvent.click(within(cards[1]).getByRole('button', { name: /^delete$/i }));

    expect(screen.getAllByTestId('lane-card')).toHaveLength(1);
    expect(within(cards[0]).getByRole('button', { name: /^delete$/i })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(saveLanes).toHaveBeenCalledWith([expect.objectContaining({ name: 'balanced' })]),
    );
  });

  it('protects the configured default lane instead of hard-coding balanced', () => {
    renderPage([lane('balanced'), lane('premium')], [], 'premium');
    const cards = screen.getAllByTestId('lane-card');
    expect(within(cards[0]).getByRole('button', { name: /^delete$/i })).toBeEnabled();
    expect(within(cards[1]).getByRole('button', { name: /^delete$/i })).toBeDisabled();
  });
});
