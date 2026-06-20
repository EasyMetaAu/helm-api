import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from '$lib/api/keys.js';
import type { Fact, MemoryScope, Reflection } from '$lib/api/memory.js';
import MemoryPage from './+page.svelte';

// The page consumes scopes + keys from `load` (mocked via the `data` prop) and
// reads facts/reflections through the memory API client (mocked). It is a pure
// consumer of /admin/api/memory/* (Principle 1) — this test asserts the two-tab
// shell renders and a selected scope drives the facts/reflections tables.

const listFacts = vi.fn();
const listReflections = vi.fn();
const resolveKey = vi.fn();
const updateFact = vi.fn();
const updateReflection = vi.fn();
const deleteFact = vi.fn();
const deleteReflection = vi.fn();
vi.mock('$lib/api/memory.js', () => ({
  listFacts: (...args: unknown[]) => listFacts(...args),
  listReflections: (...args: unknown[]) => listReflections(...args),
  resolveKey: (...args: unknown[]) => resolveKey(...args),
  updateFact: (...args: unknown[]) => updateFact(...args),
  updateReflection: (...args: unknown[]) => updateReflection(...args),
  deleteFact: (...args: unknown[]) => deleteFact(...args),
  deleteReflection: (...args: unknown[]) => deleteReflection(...args),
}));

function scope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    accountId: 'acct',
    projectId: 'proj-a',
    resourceId: null,
    threadId: null,
    factCount: 2,
    reflectionCount: 1,
    lastUpdated: '2026-06-18T10:00:00.000Z',
    ...overrides,
  };
}

function fact(id: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    ownerId: 'acct',
    projectId: 'proj-a',
    resourceId: null,
    threadId: null,
    subjectKey: 'favorite_color',
    factText: 'User prefers blue',
    contentHash: 'hash',
    importance: 0.6,
    referenceCount: 0,
    referencedAt: null,
    validFrom: '2026-06-01T00:00:00.000Z',
    invalidAt: null,
    expiredAt: null,
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function reflection(id: string, overrides: Partial<Reflection> = {}): Reflection {
  return {
    id,
    projectId: 'proj-a',
    resourceId: null,
    threadId: null,
    reflectionText: 'The user is a backend engineer working on a gateway.',
    version: 3,
    tokenEstimate: 12,
    updatedAt: '2026-06-10T00:00:00.000Z',
    referencedAt: null,
    referenceCount: 0,
    status: 'active',
    ...overrides,
  };
}

function key(keyId: string, overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    key_id: keyId,
    prefix: `helm_live_${keyId}`,
    role: 'user',
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: 'degrade',
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: 'inject' as const,
    memory_project_id: 'proj-a',
    memory_thread_source: 'auto' as const,
    ...overrides,
  };
}

function renderPage(scopes: MemoryScope[], keys: ApiKeyView[] = [key('k1')]) {
  return render(MemoryPage, { data: { scopes, keys } });
}

describe('memory page', () => {
  beforeEach(() => {
    listFacts.mockReset();
    listReflections.mockReset();
    resolveKey.mockReset();
    updateFact.mockReset();
    updateReflection.mockReset();
    deleteFact.mockReset();
    deleteReflection.mockReset();
    listFacts.mockResolvedValue({ rows: [fact('f1'), fact('f2')], total: 2 });
    listReflections.mockResolvedValue({ rows: [reflection('r1')], total: 1 });
    resolveKey.mockResolvedValue({ key_id: 'k1', accountId: 'acct', projectId: 'proj-a' });
  });

  it('renders both tabs and the By Scope table of scopes', () => {
    renderPage([scope(), scope({ projectId: 'proj-b', factCount: 1, reflectionCount: 0 })]);
    expect(screen.getByRole('tab', { name: /by scope/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /by key/i })).toBeInTheDocument();
    // The By Scope tab is active by default: scope rows are listed.
    expect(screen.getAllByTestId('scope-row')).toHaveLength(2);
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('proj-b')).toBeInTheDocument();
  });

  it('selecting a scope loads and renders the facts and reflections tables', async () => {
    renderPage([scope()]);
    await fireEvent.click(screen.getAllByTestId('scope-row')[0]);

    await waitFor(() => expect(listFacts).toHaveBeenCalled());
    expect(listReflections).toHaveBeenCalled();

    // Facts table renders a row per fact with its text.
    await waitFor(() => expect(screen.getAllByTestId('fact-row')).toHaveLength(2));
    expect(screen.getAllByText('User prefers blue').length).toBeGreaterThan(0);

    // Reflections table renders too.
    expect(screen.getByTestId('reflection-row')).toBeInTheDocument();
    expect(
      screen.getByText('The user is a backend engineer working on a gateway.'),
    ).toBeInTheDocument();
  });

  it('switching to the By Key tab shows a key selector and resolves a scope on pick', async () => {
    renderPage([scope()], [key('k1', { name: 'Prod backend' })]);
    await fireEvent.click(screen.getByRole('tab', { name: /by key/i }));

    const select = screen.getByLabelText(/^key$/i);
    expect(select).toBeInTheDocument();
    expect(within(select).getByText('Prod backend')).toBeInTheDocument();

    await fireEvent.change(select, { target: { value: 'k1' } });
    await waitFor(() => expect(resolveKey).toHaveBeenCalledWith('k1'));
    // Resolving the key loads that account/project scope's facts.
    await waitFor(() => expect(listFacts).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByTestId('fact-row').length).toBeGreaterThan(0));
  });

  it('delete on an ACTIVE reflection warns it is a soft-delete (archive)', async () => {
    renderPage([scope()]);
    await fireEvent.click(screen.getAllByTestId('scope-row')[0]);
    await waitFor(() => expect(screen.getByTestId('reflection-row')).toBeInTheDocument());
    const row = screen.getByTestId('reflection-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^delete$/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/soft-deleted \(archived\)/i)).toBeInTheDocument();
  });

  it('delete on an ARCHIVED reflection warns it is permanent and purges it', async () => {
    listReflections.mockResolvedValue({ rows: [reflection('r1', { status: 'archived' })], total: 1 });
    deleteReflection.mockResolvedValue(undefined);
    renderPage([scope()]);
    await fireEvent.click(screen.getAllByTestId('scope-row')[0]);
    await waitFor(() => expect(screen.getByTestId('reflection-row')).toBeInTheDocument());
    const row = screen.getByTestId('reflection-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^delete$/i }));
    const dialog = screen.getByRole('dialog');
    // Archived rows get the permanent-delete copy, not the soft-delete copy.
    expect(within(dialog).getByText(/already archived/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/permanently/i)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteReflection).toHaveBeenCalledWith('r1'));
  });

  it('shows an empty state when there are no scopes', () => {
    renderPage([]);
    expect(screen.getByText(/no memory yet/i)).toBeInTheDocument();
  });

  it('deep link (initialKeyId) lands on the By Key tab pre-selected and loads that key', async () => {
    render(MemoryPage, {
      data: { scopes: [scope()], keys: [key('k1', { name: 'Prod backend' })], initialKeyId: 'k1' },
    });
    // Opens on By Key (not the default By Scope) with the key resolved + facts loaded.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /by key/i }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    await waitFor(() => expect(resolveKey).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(listFacts).toHaveBeenCalled());
  });

  it('ignores an initialKeyId that is not in the key list (no crash, stays on By Scope)', async () => {
    render(MemoryPage, {
      data: { scopes: [scope()], keys: [key('k1')], initialKeyId: 'ghost' },
    });
    expect(screen.getByRole('tab', { name: /by scope/i }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(resolveKey).not.toHaveBeenCalled();
  });
});
