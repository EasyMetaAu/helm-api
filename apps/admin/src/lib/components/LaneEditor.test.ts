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

  it('offers the model catalog as combobox suggestions on primary + fallback inputs', () => {
    const aliases = ['deepseek/deepseek-v4-flash', 'openai-codex/gpt-5.5', 'zenmux/auto'];
    const models = aliases.map((alias) => ({ alias, accounts: [] }));
    const { container } = render(LaneEditor, { lane: makeLane(), models, onsave: vi.fn() });

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
      onsave: vi.fn(),
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
    const { container } = render(LaneEditor, { lane: makeLane(), models, onsave: vi.fn() });
    const options = Array.from(
      container.querySelectorAll('datalist option'),
    ) as HTMLOptionElement[];
    const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? '';
    expect(labelOf('anthropic/claude-opus-4-8')).toBe('default');
    expect(labelOf('openai-codex/gpt-5.5')).toBe('default, mylukin');
    expect(labelOf('deepseek/deepseek-v4-flash')).toBe('deepseek');
  });

  it('still works as a plain text input when no models are provided (graceful default)', () => {
    const { container } = render(LaneEditor, { lane: makeLane(), onsave: vi.fn() });
    const datalist = container.querySelector('datalist');
    // datalist exists but is empty; the input is still typeable (combobox falls back to text).
    expect(datalist?.querySelectorAll('option')).toHaveLength(0);
    const primary = screen.getByLabelText(/primary/i) as HTMLInputElement;
    expect(primary.value).toBe('best_code_model');
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
