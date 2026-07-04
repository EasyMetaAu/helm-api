import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function firePointer(
  target: Document | Node | Element | Window,
  type: string,
  init: { button?: number; clientY: number; pointerId?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, ...init });
  await fireEvent(target, event);
}

describe('policies page', () => {
  beforeEach(() => {
    savePolicies.mockReset();
    savePolicies.mockImplementation((list: Policy[]) => Promise.resolve(list));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('auto-scrolls and continues reordering while pointer dragging near the list edge', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) =>
      window.clearTimeout(handle),
    );

    const main = document.createElement('main');
    let scrollTop = 0;
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(main, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    main.getBoundingClientRect = () =>
      ({ top: 0, bottom: 300, height: 300, left: 0, right: 600, width: 600 }) as DOMRect;
    const scrollBy = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
      scrollTop += typeof optionsOrX === 'number' ? Number(y ?? 0) : Number(optionsOrX?.top ?? 0);
    });
    main.scrollBy = scrollBy as unknown as typeof main.scrollBy;
    document.body.append(main);

    render(
      PoliciesPage,
      {
        target: main,
        props: {
          data: {
            policies: [
              policy({ match: { task_type: 'coding' }, use_lane: 'coding' }),
              policy({ match: { task_type: 'math' }, use_lane: 'premium' }),
              policy({ match: { task_type: 'chat' }, use_lane: 'economy' }),
            ],
          },
        },
      },
    );

    const rowRect = (row: HTMLElement): DOMRect => {
      const rows = Array.from(document.querySelectorAll('[data-testid="policy-row"]'));
      const index = rows.indexOf(row);
      const top = 80 + index * 100 - scrollTop;
      return { top, bottom: top + 80, height: 80, left: 0, right: 600, width: 600 } as DOMRect;
    };

    for (const row of screen.getAllByTestId('policy-row')) {
      row.getBoundingClientRect = () => rowRect(row);
    }

    const rows = screen.getAllByTestId('policy-row');
    const firstHandle = within(rows[0]).getByRole('button', { name: /drag to reorder/i });
    firstHandle.getBoundingClientRect = () =>
      ({ top: 96, bottom: 128, height: 32, left: 16, right: 48, width: 32 }) as DOMRect;

    await firePointer(firstHandle, 'pointerdown', { button: 0, clientY: 112 });
    await firePointer(window, 'pointermove', { clientY: 280 });
    await vi.advanceTimersByTimeAsync(80);
    await firePointer(window, 'pointerup', { clientY: 280 });

    expect(scrollBy).toHaveBeenCalled();
    expect(scrollTop).toBeGreaterThan(0);
    const nextRows = screen.getAllByTestId('policy-row');
    expect((within(nextRows[0]).getByLabelText(/task type/i) as HTMLSelectElement).value).toBe(
      'math',
    );
    expect(nextRows.map((row) => within(row).getByTestId('policy-index').textContent?.trim()))
      .toEqual(['1', '2', '3']);
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
