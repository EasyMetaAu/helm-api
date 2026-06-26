import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactCreateResult } from '$lib/api/memory.js';
import AddFactDialog from './AddFactDialog.svelte';

// AddFactDialog authors a fact directly (no status field — new facts are 'active').
// createFact is mocked; we assert the trimmed fields + scope reach it, success bubbles
// up via onsaved, a server error is surfaced inline, and cancel closes.

const createFact = vi.fn();
vi.mock('$lib/api/memory.js', () => ({
  createFact: (...args: unknown[]) => createFact(...args),
}));

const SCOPE = { accountId: 'acct', projectId: 'proj-a', resourceId: null, threadId: null };

function result(): FactCreateResult {
  return { fact: null, added: ['id'], resurrected: [], superseded: [], deduped: false };
}

describe('AddFactDialog', () => {
  beforeEach(() => {
    createFact.mockReset();
    // A benign default so the mock always has an implementation (mirrors
    // CreateKeyDialog.test): resetting without one makes a later mockRejectedValue
    // surface as an unhandled rejection under vitest. The reject test overrides this.
    createFact.mockResolvedValue(result());
  });

  it('renders Subject + Fact text inputs and no Status field', () => {
    render(AddFactDialog, { scope: SCOPE, onsaved: vi.fn(), onclose: vi.fn() });
    expect(screen.getByLabelText(/^subject$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^fact text$/i)).toBeInTheDocument();
    // Editing status is an edit-only affordance; creating a fact never sets it.
    expect(screen.queryByLabelText(/^status$/i)).toBeNull();
  });

  it('creates a fact with trimmed values + the scope, then calls onsaved', async () => {
    createFact.mockResolvedValue(result());
    const onsaved = vi.fn();
    render(AddFactDialog, { scope: SCOPE, onsaved, onclose: vi.fn() });
    await fireEvent.input(screen.getByLabelText(/^subject$/i), { target: { value: '  pet  ' } });
    await fireEvent.input(screen.getByLabelText(/^fact text$/i), {
      target: { value: '  Has a cat.  ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /^add fact$/i }));
    await waitFor(() =>
      expect(createFact).toHaveBeenCalledWith({
        accountId: 'acct',
        projectId: 'proj-a',
        subjectText: 'pet',
        factText: 'Has a cat.',
        importance: 0.5,
      }),
    );
    await waitFor(() => expect(onsaved).toHaveBeenCalled());
  });

  it('surfaces a server error inline and does NOT close', async () => {
    createFact.mockRejectedValue(new Error('that fact already exists'));
    render(AddFactDialog, { scope: SCOPE, onsaved: vi.fn(), onclose: vi.fn() });
    await fireEvent.input(screen.getByLabelText(/^subject$/i), { target: { value: 'pet' } });
    await fireEvent.input(screen.getByLabelText(/^fact text$/i), { target: { value: 'x' } });
    await fireEvent.click(screen.getByRole('button', { name: /^add fact$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/i);
  });

  it('Cancel closes without creating', async () => {
    const onclose = vi.fn();
    render(AddFactDialog, { scope: SCOPE, onsaved: vi.fn(), onclose });
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onclose).toHaveBeenCalled();
    expect(createFact).not.toHaveBeenCalled();
  });
});
