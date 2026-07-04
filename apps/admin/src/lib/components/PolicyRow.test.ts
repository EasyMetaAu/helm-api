import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPLEXITY_OPTIONS,
  type Policy,
  REASONING_EFFORTS,
  TASK_TYPE_OPTIONS,
} from '$lib/api/policies.js';
import PolicyRow from './PolicyRow.svelte';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return { match: {}, use_lane: 'balanced', ...overrides };
}

const LANES = ['economy', 'balanced', 'premium', 'coding'];

describe('PolicyRow', () => {
  it('shows the priority index passed in (1-based ordering)', () => {
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });
    expect(screen.getByTestId('policy-index')).toHaveTextContent('1');
  });

  it('edits match.task_type and match.complexity into the change payload', async () => {
    const onchange = vi.fn();
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange,
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    await fireEvent.change(screen.getByLabelText(/task type/i), {
      target: { value: 'coding' },
    });
    await fireEvent.change(screen.getByLabelText(/complexity/i), {
      target: { value: 'complex' },
    });

    const last = onchange.mock.calls.at(-1)?.[0] as Policy;
    expect(last.match.task_type).toBe('coding');
    expect(last.match.complexity).toBe('complex');
  });

  it('task_type / complexity dropdowns offer exactly the docs/03 + server enum sets (no free text)', () => {
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    const taskSelect = screen.getByLabelText(/task type/i) as HTMLSelectElement;
    const taskValues = Array.from(taskSelect.options)
      .map((o) => o.value)
      .filter((v) => v !== ''); // "" = unset/any
    expect(taskValues).toEqual([...TASK_TYPE_OPTIONS]);

    const complexitySelect = screen.getByLabelText(/complexity/i) as HTMLSelectElement;
    const complexityValues = Array.from(complexitySelect.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(complexityValues).toEqual([...COMPLEXITY_OPTIONS]);

    // it must be a <select>, not a free-text input
    expect(taskSelect.tagName).toBe('SELECT');
    expect(complexitySelect.tagName).toBe('SELECT');
  });

  it('force-lane select updates use_lane (no max_lane cap)', async () => {
    const onchange = vi.fn();
    render(PolicyRow, {
      policy: makePolicy({ use_lane: 'balanced' }),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange,
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    // the retired max_lane "cap" select is gone.
    expect(screen.queryByLabelText(/max lane/i)).toBeNull();

    await fireEvent.change(screen.getByLabelText(/use lane/i), {
      target: { value: 'premium' },
    });
    const last = onchange.mock.calls.at(-1)?.[0] as Policy;
    expect(last.use_lane).toBe('premium');
  });

  it('reasoning-effort select offers the lane options and updates reasoning_effort', async () => {
    const onchange = vi.fn();
    render(PolicyRow, {
      policy: makePolicy({ reasoning_effort: 'medium' }),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange,
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    const select = screen.getByLabelText(/policy reasoning effort/i) as HTMLSelectElement;
    const values = Array.from(select.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(values).toEqual([...REASONING_EFFORTS]);
    expect(select.value).toBe('medium');

    await fireEvent.change(select, { target: { value: 'xhigh' } });
    const last = onchange.mock.calls.at(-1)?.[0] as Policy;
    expect(last.reasoning_effort).toBe('xhigh');
  });

  it('empty match is flagged as a catch-all (warns it swallows later rules)', () => {
    render(PolicyRow, {
      policy: makePolicy({ match: {} }),
      index: 0,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });
    expect(screen.getByTestId('catch-all-warning')).toBeInTheDocument();
  });

  it('shows one drag handle for reordering instead of separate up/down buttons', () => {
    render(PolicyRow, {
      policy: makePolicy(),
      index: 1,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });
    const row = screen.getByTestId('policy-row');
    expect(within(row).getByRole('button', { name: /drag to reorder/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /move up/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /move down/i })).toBeNull();
  });

  it('drag handle supports keyboard reordering and remove still calls its callback', async () => {
    const onremove = vi.fn();
    const onmove = vi.fn();
    render(PolicyRow, {
      policy: makePolicy(),
      index: 1,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove,
      onmove,
    });
    const row = screen.getByTestId('policy-row');
    await fireEvent.keyDown(within(row).getByRole('button', { name: /drag to reorder/i }), {
      key: 'ArrowUp',
    });
    expect(onmove).toHaveBeenCalledWith(1, 0);
    await fireEvent.click(within(row).getByRole('button', { name: /remove/i }));
    expect(onremove).toHaveBeenCalledWith(1);
  });
});
