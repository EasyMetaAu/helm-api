import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '$lib/api/policies.js';
import PoliciesPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the `savePolicies` API client, which we mock here. The page owns NO
// matching logic — order is priority (first-match), enforced by the ordered PUT.
const savePolicies = vi.fn();
vi.mock('$lib/api/policies.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/policies.js')>();
  return { ...actual, savePolicies: (...args: unknown[]) => savePolicies(...args) };
});

function policy(overrides: Partial<Policy> = {}): Policy {
  return { match: { task_type: 'chat' }, use_lane: 'balanced', ...overrides };
}

function renderPage(policies: Policy[]) {
  return render(PoliciesPage, { data: { policies } });
}

describe('policies page', () => {
  beforeEach(() => {
    savePolicies.mockReset();
    savePolicies.mockImplementation((list: Policy[]) => Promise.resolve(list));
  });

  it('renders the policies in order with 1-based priority numbers', () => {
    renderPage([
      policy({ match: { task_type: 'coding' } }),
      policy({ match: { complexity: 'complex' } }),
      policy({ match: {} }),
    ]);
    const rows = screen.getAllByTestId('policy-row');
    expect(rows).toHaveLength(3);
    const indices = screen.getAllByTestId('policy-index').map((el) => el.textContent?.trim());
    expect(indices).toEqual(['1', '2', '3']);
  });

  it('makes the first-match semantics visible (no scoring language)', () => {
    renderPage([policy()]);
    const explainer = screen.getByTestId('first-match-explainer');
    expect(explainer.textContent ?? '').toMatch(/first[- ]?match|top to bottom/i);
    expect(explainer.textContent ?? '').not.toMatch(/score|scoring/i);
  });

  it("editing a row's match and saving PUTs the whole ordered list", async () => {
    renderPage([policy({ match: { task_type: 'chat' } })]);
    await fireEvent.change(screen.getByLabelText(/task type/i), {
      target: { value: 'coding' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /save policies/i }));

    await waitFor(() => expect(savePolicies).toHaveBeenCalledTimes(1));
    const sent = savePolicies.mock.calls[0][0] as Policy[];
    expect(sent[0].match.task_type).toBe('coding');
  });

  it('adding a row grows the list by one', async () => {
    renderPage([policy()]);
    expect(screen.getAllByTestId('policy-row')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: /add policy/i }));
    expect(screen.getAllByTestId('policy-row')).toHaveLength(2);
  });

  it('dragging a row changes the visible order and saved array order', async () => {
    renderPage([
      policy({ match: { task_type: 'coding' }, use_lane: 'coding' }),
      policy({ match: { task_type: 'math' }, use_lane: 'premium' }),
    ]);
    let rows = screen.getAllByTestId('policy-row');
    const dragHandle = within(rows[1]).getByRole('button', { name: /drag to reorder/i });

    await fireEvent.dragStart(dragHandle);
    await fireEvent.dragOver(rows[0]);
    await fireEvent.drop(rows[0]);

    rows = screen.getAllByTestId('policy-row');
    expect((within(rows[0]).getByLabelText(/task type/i) as HTMLSelectElement).value).toBe('math');
    expect((within(rows[1]).getByLabelText(/task type/i) as HTMLSelectElement).value).toBe(
      'coding',
    );

    await fireEvent.click(screen.getByRole('button', { name: /save policies/i }));

    await waitFor(() => expect(savePolicies).toHaveBeenCalledTimes(1));
    const sent = savePolicies.mock.calls[0][0] as Policy[];
    expect(sent.map((p) => p.match.task_type)).toEqual(['math', 'coding']);
  });

  it('on save failure shows an error and keeps the pre-save list (fail-closed, no dirty write)', async () => {
    savePolicies.mockRejectedValue(new Error('400 invalid policies'));
    renderPage([policy({ match: { task_type: 'coding' } })]);

    await fireEvent.change(screen.getByLabelText(/task type/i), {
      target: { value: 'math' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /save policies/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // still exactly one row; the page did not crash or duplicate
    expect(screen.getAllByTestId('policy-row')).toHaveLength(1);
  });
});
