import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Lane } from '$lib/api/lanes.js';
import LaneEditor from './LaneEditor.svelte';

function makeLane(overrides: Partial<Lane> = {}): Lane {
  return {
    name: 'coding',
    purpose: 'Coding tasks',
    primary: 'best_code_model',
    fallback: ['premium', 'balanced'],
    constraints: { require_tools: false, require_json: false, max_latency_ms: null },
    ...overrides,
  };
}

describe('LaneEditor', () => {
  it('renders name (read-only), primary and ordered fallback', () => {
    render(LaneEditor, { lane: makeLane(), onsave: vi.fn() });

    expect(screen.getByText('coding')).toBeInTheDocument();
    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    expect(primary.value).toBe('best_code_model');

    const items = screen.getAllByTestId('fallback-item');
    expect(items.map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('premium')]),
    );
    // ordered: premium before balanced
    const idxPremium = items.findIndex((el) => el.textContent?.includes('premium'));
    const idxBalanced = items.findIndex((el) => el.textContent?.includes('balanced'));
    expect(idxPremium).toBeLessThan(idxBalanced);
  });

  it('edits primary and calls onsave with the new value', async () => {
    const onsave = vi.fn();
    render(LaneEditor, { lane: makeLane(), onsave });

    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: 'new_code_model' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onsave).toHaveBeenCalledTimes(1);
    const [name, body] = onsave.mock.calls[0];
    expect(name).toBe('coding');
    expect(body.primary).toBe('new_code_model');
  });

  it('adds and removes a fallback entry, preserving order in the saved body', async () => {
    const onsave = vi.fn();
    render(LaneEditor, { lane: makeLane({ fallback: ['premium'] }), onsave });

    await fireEvent.input(screen.getByTestId('fallback-add-input'), {
      target: { value: 'economy' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /add fallback/i }));
    expect(screen.getAllByTestId('fallback-item')).toHaveLength(2);

    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onsave.mock.calls[0][1].fallback).toEqual(['premium', 'economy']);

    // remove the first
    onsave.mockClear();
    const firstItem = screen.getAllByTestId('fallback-item')[0];
    await fireEvent.click(within(firstItem).getByRole('button', { name: /remove/i }));
    expect(screen.getAllByTestId('fallback-item')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onsave.mock.calls[0][1].fallback).toEqual(['economy']);
  });

  it('toggles require_json into the saved constraints', async () => {
    const onsave = vi.fn();
    render(LaneEditor, { lane: makeLane(), onsave });

    await fireEvent.click(screen.getByLabelText(/require json/i));
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onsave.mock.calls[0][1].constraints.require_json).toBe(true);
  });

  it('balanced guard: clearing primary disables save and shows a validation hint', async () => {
    const onsave = vi.fn();
    render(LaneEditor, {
      lane: makeLane({ name: 'balanced', primary: 'default_good_model' }),
      onsave,
    });

    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: '' } });

    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeDisabled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/balanced/i);
    expect(alert).toHaveTextContent(/cannot be empty|required/i);

    await fireEvent.click(save);
    expect(onsave).not.toHaveBeenCalled();
  });
});
