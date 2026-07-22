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
    render(LaneEditor, { lane: makeLane(), onchange: vi.fn() });

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

  it('emits the complete lane when primary changes', async () => {
    const onchange = vi.fn();
    render(LaneEditor, { lane: makeLane(), onchange });

    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: 'new_code_model' } });

    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange.mock.calls[0][0].primary).toBe('new_code_model');
  });

  it('adds and removes a fallback entry, preserving order in emitted state', async () => {
    const onchange = vi.fn();
    render(LaneEditor, { lane: makeLane({ fallback: ['premium'] }), onchange });

    await fireEvent.input(screen.getByTestId('fallback-add-input'), {
      target: { value: 'economy' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /add fallback/i }));
    expect(screen.getAllByTestId('fallback-item')).toHaveLength(2);

    expect(onchange.mock.lastCall?.[0].fallback).toEqual(['premium', 'economy']);

    // remove the first
    onchange.mockClear();
    const firstItem = screen.getAllByTestId('fallback-item')[0];
    await fireEvent.click(within(firstItem).getByRole('button', { name: /remove/i }));
    expect(screen.getAllByTestId('fallback-item')).toHaveLength(1);
    expect(onchange.mock.lastCall?.[0].fallback).toEqual(['economy']);
  });

  it('toggles require_json into the emitted constraints', async () => {
    const onchange = vi.fn();
    render(LaneEditor, { lane: makeLane(), onchange });

    await fireEvent.click(screen.getByLabelText(/require json/i));

    expect(onchange.mock.lastCall?.[0].constraints.require_json).toBe(true);
  });

  it('reorders fallback by dragging its handle and supports keyboard fallback', async () => {
    const onchange = vi.fn();
    render(LaneEditor, { lane: makeLane({ fallback: ['premium', 'balanced'] }), onchange });
    const items = screen.getAllByTestId('fallback-item');
    const secondHandle = within(items[1]).getByRole('button', {
      name: /drag to reorder fallback/i,
    });

    await fireEvent.dragStart(secondHandle);
    await fireEvent.dragOver(items[0]);
    await fireEvent.drop(items[0]);
    expect(onchange.mock.lastCall?.[0].fallback).toEqual(['balanced', 'premium']);

    onchange.mockClear();
    const firstHandle = within(screen.getAllByTestId('fallback-item')[0]).getByRole('button', {
      name: /drag to reorder fallback/i,
    });
    await fireEvent.keyDown(firstHandle, { key: 'ArrowDown' });
    expect(onchange.mock.lastCall?.[0].fallback).toEqual(['premium', 'balanced']);
  });

  it('offers the model catalog as combobox suggestions on primary + fallback inputs', () => {
    const aliases = ['deepseek/deepseek-v4-flash', 'openai-codex/gpt-5.5', 'zenmux/auto'];
    const models = aliases.map((alias) => ({ alias, accounts: [] }));
    const { container } = render(LaneEditor, { lane: makeLane(), models, onchange: vi.fn() });

    // A <datalist> with one <option> per alias is rendered…
    const datalist = container.querySelector('datalist');
    expect(datalist).not.toBeNull();
    const options = Array.from(datalist?.querySelectorAll('option') ?? []).map((o) => o.value);
    expect(options).toEqual(aliases);

    // …and both inputs reference it via `list`, turning them into comboboxes.
    const primary = container.querySelector("input[name='primary']") as HTMLInputElement;
    const fallbackAdd = screen.getByTestId('fallback-add-input') as HTMLInputElement;
    const listId = datalist?.id;
    expect(listId).toBeTruthy();
    expect(primary.getAttribute('list')).toBe(listId);
    expect(fallbackAdd.getAttribute('list')).toBe(listId);
  });

  it('also offers other lanes (excluding itself) as combobox targets, labelled as lanes', () => {
    const aliases = ['deepseek/deepseek-v4-flash', 'openai-codex/gpt-5.5'];
    const models = aliases.map((alias) => ({ alias, accounts: [] }));
    const laneNames = ['economy', 'balanced', 'coding', 'premium'];
    const { container } = render(LaneEditor, {
      lane: makeLane({ name: 'coding' }),
      models,
      laneNames,
      onchange: vi.fn(),
    });

    const options = Array.from(
      container.querySelectorAll('datalist option'),
    ) as HTMLOptionElement[];
    const values = options.map((o) => o.value);

    // Other lanes are routable targets (the chain may point at another lane)…
    expect(values).toEqual(expect.arrayContaining(['economy', 'balanced', 'premium']));
    // …and the model aliases are still there too…
    expect(values).toEqual(expect.arrayContaining(aliases));
    // …but a lane can never target itself.
    expect(values).not.toContain('coding');

    // Lane suggestions carry a label so the operator can tell them apart from models.
    const laneOption = options.find((o) => o.value === 'balanced');
    expect(laneOption?.label).toBe('lane');
    const modelOption = options.find((o) => o.value === aliases[0]);
    expect(modelOption?.label ?? '').not.toBe('lane');
  });

  it('labels each model option: account(s) for OAuth, provider name for configured', () => {
    const models = [
      { alias: 'anthropic/claude-opus-4-8', accounts: ['default'] },
      { alias: 'openai-codex/gpt-5.5', accounts: ['default', 'mylukin'] },
      { alias: 'deepseek/deepseek-v4-flash', accounts: [] }, // configured → provider as label
    ];
    const { container } = render(LaneEditor, { lane: makeLane(), models, onchange: vi.fn() });
    const options = Array.from(
      container.querySelectorAll('datalist option'),
    ) as HTMLOptionElement[];
    const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? '';
    expect(labelOf('anthropic/claude-opus-4-8')).toBe('default');
    expect(labelOf('openai-codex/gpt-5.5')).toBe('default, mylukin');
    expect(labelOf('deepseek/deepseek-v4-flash')).toBe('deepseek');
  });

  it('still works as a plain text input when no models are provided (graceful default)', () => {
    const { container } = render(LaneEditor, { lane: makeLane(), onchange: vi.fn() });
    const datalist = container.querySelector('datalist');
    // datalist exists but is empty; the input is still typeable (combobox falls back to text).
    expect(datalist?.querySelectorAll('option')).toHaveLength(0);
    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    expect(primary.value).toBe('best_code_model');
  });

  it('clearing primary emits invalid state and shows a validation hint', async () => {
    const onchange = vi.fn();
    render(LaneEditor, {
      lane: makeLane({ name: 'balanced', primary: 'default_good_model' }),
      onchange,
    });

    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    await fireEvent.input(primary, { target: { value: '' } });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/cannot be empty|required/i);
    expect(onchange.mock.lastCall?.[0].primary).toBe('');
  });

  it('can delete optional lanes and protects only the configured default lane', async () => {
    const ondelete = vi.fn();
    const { unmount } = render(LaneEditor, {
      lane: makeLane({ name: 'coding' }),
      onchange: vi.fn(),
      ondelete,
    });
    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(ondelete).toHaveBeenCalledWith('coding');

    unmount();
    render(LaneEditor, {
      lane: makeLane({ name: 'premium' }),
      onchange: vi.fn(),
      ondelete,
      canDelete: false,
    });
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled();
  });
});
