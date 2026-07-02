import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView, KeyUsage } from '$lib/api/keys.js';
import KeysPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the keys API client (mocked). Hard security line (Principle 7 / docs/06):
// list & detail expose ONLY the prefix + sha256 reference — never plaintext.

const createKey = vi.fn();
const revokeKey = vi.fn();
const updateKey = vi.fn();
const deleteKey = vi.fn();
const revealKey = vi.fn();
const rotateKey = vi.fn();
vi.mock('$lib/api/keys.js', () => ({
  createKey: (...args: unknown[]) => createKey(...args),
  revokeKey: (...args: unknown[]) => revokeKey(...args),
  updateKey: (...args: unknown[]) => updateKey(...args),
  deleteKey: (...args: unknown[]) => deleteKey(...args),
  revealKey: (...args: unknown[]) => revealKey(...args),
  rotateKey: (...args: unknown[]) => rotateKey(...args),
}));

function key(keyId: string, overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    key_id: keyId,
    prefix: `helm_live_${keyId}`,
    role: 'user',
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
    allow_fast_mode: false,
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
    memory_mode: 'off' as const,
    memory_project_id: null,
    memory_thread_source: 'header' as const,
    ...overrides,
  };
}

function renderPage(
  keys: ApiKeyView[],
  lanes: string[] = ['economy', 'balanced', 'premium'],
  usage: KeyUsage[] = [],
) {
  return render(KeysPage, { data: { keys, lanes, usage } });
}

describe('keys page', () => {
  beforeEach(() => {
    createKey.mockReset();
    revokeKey.mockReset();
    updateKey.mockReset();
    deleteKey.mockReset();
    revealKey.mockReset();
    rotateKey.mockReset();
    updateKey.mockResolvedValue(undefined);
    revokeKey.mockResolvedValue({ revoked: '' });
    deleteKey.mockResolvedValue({ deleted: '' });
    revealKey.mockResolvedValue({ key_id: 'k1', plaintext: 'helm_live_REVEALEDSECRET0000' });
    rotateKey.mockResolvedValue({
      key_id: 'k1',
      plaintext: 'helm_live_ROTATEDSECRET0000',
      prefix: 'helm_live_rota',
      recoverable: true,
    });
  });

  it('lists each key by prefix/role/caps/status and shows NO plaintext-like secret', () => {
    renderPage([
      key('k1', { prefix: 'helm_live_ab12', role: 'user', allowed_lanes: ['balanced'] }),
      key('k2', { prefix: 'helm_live_cd34', disabled: true }),
    ]);
    expect(screen.getAllByTestId('key-row')).toHaveLength(2);
    expect(screen.getByText('helm_live_ab12')).toBeInTheDocument();
    expect(screen.getByText('helm_live_cd34')).toBeInTheDocument();
    // No long opaque secret string anywhere (prefixes are short helm_live_xxxx).
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/helm_live_[A-Za-z0-9]{16,}/);
  });

  it('shows each key Fast mode passthrough cap in the Caps column', () => {
    renderPage([key('k1', { allow_fast_mode: true }), key('k2', { allow_fast_mode: false })]);
    const rows = screen.getAllByTestId('key-row');
    expect(within(rows[0]).getByText(/Fast mode:\s*yes/i)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Fast mode:\s*no/i)).toBeInTheDocument();
  });

  it('shows the key name in the row, and an "unnamed" placeholder when null', () => {
    renderPage([key('k1', { name: 'Production backend' }), key('k2', { name: null })]);
    const rows = screen.getAllByTestId('key-row');
    expect(within(rows[0]).getByText('Production backend')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/unnamed/i)).toBeInTheDocument();
  });

  it('hides Edit/Revoke/Delete on the internal system key (k_internal) — only Details', () => {
    renderPage([key('k_internal', { name: 'internal-llm' }), key('k1', { name: 'Prod' })]);
    const rows = screen.getAllByTestId('key-row');
    // Internal system key (row 0): read-only — Details only, no destructive actions.
    expect(within(rows[0]).getByRole('link', { name: /details/i })).toBeInTheDocument();
    expect(within(rows[0]).queryByRole('button', { name: /edit/i })).toBeNull();
    expect(within(rows[0]).queryByRole('button', { name: /revoke/i })).toBeNull();
    expect(within(rows[0]).queryByRole('button', { name: /delete/i })).toBeNull();
    // A normal active key (row 1) still has Edit + Revoke.
    expect(within(rows[1]).getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('links each key name to its detail page (/admin/keys/:id)', () => {
    renderPage([key('k1', { name: 'Prod' })]);
    // `base` ('/admin' in prod) resolves to '' in the test env, like the requests
    // page test — so the rendered href is /keys/:id here.
    const link = screen.getByRole('link', { name: /prod/i });
    expect(link.getAttribute('href')).toBe('/keys/k1');
  });

  it('offers a "Details" link on every row (active + disabled) pointing at the detail page', () => {
    renderPage([key('k1', { name: 'Prod' }), key('k2', { disabled: true })]);
    const rows = screen.getAllByTestId('key-row');
    // Active row: an explicit Details action (not only the clickable name).
    expect(within(rows[0]).getByRole('link', { name: /details/i }).getAttribute('href')).toBe(
      '/keys/k1',
    );
    // Disabled (revoked) row still lets an operator inspect its history.
    expect(within(rows[1]).getByRole('link', { name: /details/i }).getAttribute('href')).toBe(
      '/keys/k2',
    );
  });

  it('reveals the full key in a modal without putting it in the list permanently', async () => {
    revealKey.mockResolvedValue({ key_id: 'k1', plaintext: 'helm_live_REVEALEDSECRET0000' });
    renderPage([key('k1', { prefix: 'helm_live_ab12' })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /view full key/i }));

    await waitFor(() => expect(revealKey).toHaveBeenCalledWith('k1'));
    const dialog = screen.getByRole('dialog', { name: /full api key/i });
    expect(within(dialog).getByTestId('revealed-key-value')).toHaveTextContent(
      'helm_live_REVEALEDSECRET0000',
    );
    await fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByTestId('revealed-key-value')).not.toBeInTheDocument());
    expect(screen.getByText('helm_live_ab12')).toBeInTheDocument();
  });

  it('rotates an active key in place: same row, new prefix, replacement plaintext modal', async () => {
    rotateKey.mockResolvedValue({
      key_id: 'k1',
      plaintext: 'helm_live_ROTATEDSECRET0000',
      prefix: 'helm_live_rota',
      recoverable: true,
    });
    renderPage([key('k1', { prefix: 'helm_live_ab12', name: 'Prod' })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^rotate$/i }));
    const confirm = screen.getByRole('dialog', { name: /rotate key/i });
    await fireEvent.click(within(confirm).getByRole('button', { name: /^rotate key$/i }));

    await waitFor(() => expect(rotateKey).toHaveBeenCalledWith('k1'));
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
    expect(screen.getByText('helm_live_rota')).toBeInTheDocument();
    const replacement = screen.getByRole('dialog', { name: /replacement key created/i });
    expect(within(replacement).getByTestId('rotated-key-value')).toHaveTextContent(
      'helm_live_ROTATEDSECRET0000',
    );
  });

  it('renders the 24h usage cell for a key with traffic, "—" for one without', () => {
    renderPage(
      [key('k1'), key('k2')],
      undefined,
      [{ key_id: 'k1', requests: 7, error_count: 1, cost_usd: 0.042, total_tokens: 1500 }],
    );
    const rows = screen.getAllByTestId('key-row');
    // k1 has usage: request count + error count + cost + tokens all render.
    expect(within(rows[0]).getByText(/7/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/1\.5K|1500/)).toBeInTheDocument();
    // k2 has no usage row → the cell shows the em dash placeholder.
    const k2Usage = within(rows[1]).getByText('—');
    expect(k2Usage).toBeInTheDocument();
  });

  it('Edit renames a key: PATCHes the new name; blank clears it to null', async () => {
    renderPage([key('k1', { name: 'Old name' })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    let dialog = screen.getByRole('dialog', { name: /edit key/i });
    // The name field is pre-filled and editable; set a new value.
    const nameInput = within(dialog).getByLabelText(/^name$/i);
    expect((nameInput as HTMLInputElement).value).toBe('Old name');
    await fireEvent.input(nameInput, { target: { value: 'New name' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith('k1', expect.objectContaining({ name: 'New name' })),
    );

    // Re-open and clear the name → PATCH sends null (cleared), not undefined.
    updateKey.mockClear();
    await fireEvent.click(
      within(screen.getByTestId('key-row')).getByRole('button', { name: /^edit$/i }),
    );
    dialog = screen.getByRole('dialog', { name: /edit key/i });
    await fireEvent.input(within(dialog).getByLabelText(/^name$/i), { target: { value: '   ' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith('k1', expect.objectContaining({ name: null })),
    );
  });

  it("flags a root key row with a 'management plane only' warning (docs/06)", () => {
    renderPage([key('root1', { role: 'root', prefix: 'helm_live_root' })]);
    const row = screen.getByTestId('key-row');
    expect(within(row).getByTestId('root-warning')).toBeInTheDocument();
  });

  it('revoking marks the row disabled in place — never removed (rotation semantics)', async () => {
    revokeKey.mockResolvedValue({ revoked: 'k1' });
    renderPage([key('k1', { prefix: 'helm_live_ab12' })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /revoke/i }));
    // Confirmation step before the destructive action.
    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith('k1'));
    // Still present, just disabled.
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
    await waitFor(() =>
      expect(within(screen.getByTestId('key-row')).getByText(/disabled/i)).toBeInTheDocument(),
    );
  });

  it('after creating a key the new row shows only the prefix (no plaintext in the list)', async () => {
    createKey.mockResolvedValue({
      key_id: 'key_new',
      plaintext: 'helm_live_TOPSECRETVALUE0000',
      prefix: 'helm_live_TOPS',
      recoverable: true,
    });
    renderPage([key('k1')]);
    await fireEvent.click(screen.getByRole('button', { name: /new key|create/i }));

    // Submit the dialog form.
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());

    // Close the reveal (operator stored it) — plaintext must vanish.
    await fireEvent.click(screen.getByRole('button', { name: /saved it|done/i }));
    await waitFor(() => expect(screen.queryByTestId('plaintext-reveal')).not.toBeInTheDocument());

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('helm_live_TOPSECRETVALUE0000');
    // The new key now appears in the list by prefix only.
    expect(screen.getAllByTestId('key-row').length).toBeGreaterThanOrEqual(2);
  });

  it('shows per-key rate limits in the row (number, and "default" when null)', () => {
    renderPage([
      key('k1', { rate_limit_rpm: 60, rate_limit_tpm: 0 }),
      key('k2'), // both null -> inherits the system default
    ]);
    const rows = screen.getAllByTestId('key-row');
    // k1 shows its explicit RPM; k2 (both null) shows the inherit/default copy
    // on both the RPM and TPM lines.
    expect(within(rows[0]).getByText(/60/)).toBeInTheDocument();
    expect(within(rows[1]).getAllByText(/default/i).length).toBeGreaterThan(0);
  });

  it('shows the concurrency limit in the row (number, and "unlimited" when null)', () => {
    renderPage([key('k1', { concurrency_limit: 5 }), key('k2', { concurrency_limit: null })]);
    const rows = screen.getAllByTestId('key-row');
    expect(within(rows[0]).getByText(/concurrency.*5/i)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/concurrency.*unlimited/i)).toBeInTheDocument();
  });

  it('shows the memory defaults in the row (mode + thread source + project; "Off" when off)', () => {
    renderPage([
      key('k1', {
        memory_mode: 'inject',
        memory_thread_source: 'auto',
        memory_project_id: 'proj-a',
      }),
      key('k2', { memory_mode: 'observe', memory_thread_source: 'header' }),
      key('k3', { memory_mode: 'off' }),
    ]);
    const rows = screen.getAllByTestId('key-row');
    expect(within(rows[0]).getByText(/inject/i)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/auto thread/i)).toBeInTheDocument();
    expect(within(rows[0]).getByText('proj-a')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/observe/i)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/auto thread/i)).not.toBeInTheDocument();
    expect(within(rows[2]).getByText(/^off$/i)).toBeInTheDocument();
  });

  it('shows the budget window alongside the caps in the budget cell, as a duration', () => {
    renderPage([key('k1', { budget_requests: 100, budget_window_seconds: 3600 })]);
    const row = screen.getByTestId('key-row');
    expect(within(row).getByText(/100 req/)).toBeInTheDocument();
    // The raw "3600s" is unreadable — the window renders as a coarse duration.
    expect(within(row).getByText(/1h/)).toBeInTheDocument();
    expect(within(row).queryByText(/3600/)).not.toBeInTheDocument();
  });

  it('abbreviates large budget caps and rate limits with K/M/B units', () => {
    renderPage([
      key('k1', {
        rate_limit_tpm: 2_000_000,
        budget_requests: 50_000,
        budget_tokens: 100_000_000,
        budget_spend_usd: 5,
        budget_window_seconds: 2_592_000, // 30 days
      }),
    ]);
    const row = screen.getByTestId('key-row');
    expect(within(row).getByText(/TPM.*2M/)).toBeInTheDocument();
    expect(within(row).getByText(/50K req/)).toBeInTheDocument();
    expect(within(row).getByText(/100M tok/)).toBeInTheDocument();
    expect(within(row).getByText(/\$5\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/30d/)).toBeInTheDocument();
    // No raw long number may leak through anywhere in the row.
    expect(row.textContent).not.toMatch(/\d{5,}/);
  });

  it('Edit opens a dialog and PATCHes the full editable cap set via updateKey', async () => {
    renderPage([key('k1', { rate_limit_rpm: null, rate_limit_tpm: null })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog', { name: /edit key/i });
    // The key value/prefix and role are shown read-only — never an editable field.
    expect(within(dialog).getByText('helm_live_k1')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/role/i)).not.toBeInTheDocument();
    // Edit caps: whitelist a lane, set an explicit RPM.
    await fireEvent.click(within(dialog).getByLabelText('economy'));
    await fireEvent.input(within(dialog).getByLabelText(/requests per minute/i), {
      target: { value: '120' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith('k1', {
        // Name untouched in this edit → still unnamed (null), never undefined.
        name: null,
        allowed_lanes: ['economy'],
        allow_custom_model: false,
        allow_fast_mode: false,
        rate_limit_rpm: 120,
        rate_limit_tpm: null, // untouched → still inherit (null), not undefined
        // Budgets untouched → still no cap (null) + default behavior.
        budget_requests: null,
        budget_tokens: null,
        budget_spend_usd: null,
        budget_window_seconds: null,
        over_budget_behavior: 'degrade',
        degrade_lane: null,
        // Concurrency untouched → still unlimited (null).
        concurrency_limit: null,
        // Memory defaults untouched → off / none / header (issue #97).
        memory_mode: 'off',
        memory_project_id: null,
        memory_thread_source: 'header',
      }),
    );
    // Dialog closes after a successful save.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /edit key/i })).not.toBeInTheDocument(),
    );
  });

  it('clearing a rate-limit field in the dialog sends null (clear → inherit), not undefined', async () => {
    renderPage([key('k1', { rate_limit_rpm: 120, rate_limit_tpm: null })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog', { name: /edit key/i });
    // Clear the pre-filled RPM field; an emptied number input binds to undefined.
    await fireEvent.input(within(dialog).getByLabelText(/requests per minute/i), {
      target: { value: '' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith(
        'k1',
        expect.objectContaining({ rate_limit_rpm: null }),
      ),
    );
  });

  it('presents the Edit dialog as a centered modal dismissible via scrim and Escape', async () => {
    renderPage([key('k1')]);
    await fireEvent.click(
      within(screen.getByTestId('key-row')).getByRole('button', { name: /^edit$/i }),
    );
    expect(screen.getByRole('dialog', { name: /edit key/i })).toBeInTheDocument();
    // Clicking the backdrop scrim closes the modal.
    await fireEvent.click(screen.getByTestId('modal-scrim'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /edit key/i })).not.toBeInTheDocument(),
    );

    // Re-open and close via Escape.
    await fireEvent.click(
      within(screen.getByTestId('key-row')).getByRole('button', { name: /^edit$/i }),
    );
    expect(screen.getByRole('dialog', { name: /edit key/i })).toBeInTheDocument();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /edit key/i })).not.toBeInTheDocument(),
    );
  });

  it('presents the revoke confirmation as a centered modal', async () => {
    renderPage([key('k1', { prefix: 'helm_live_ab12' })]);
    await fireEvent.click(
      within(screen.getByTestId('key-row')).getByRole('button', { name: /revoke/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /confirm revoke/i });
    expect(within(dialog).getByRole('button', { name: /confirm/i })).toBeInTheDocument();
    // The scrim dismisses the confirmation (same as Cancel) without revoking.
    await fireEvent.click(screen.getByTestId('modal-scrim'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /confirm revoke/i })).not.toBeInTheDocument(),
    );
    expect(revokeKey).not.toHaveBeenCalled();
  });

  it('does not offer Edit on a revoked (disabled) key', () => {
    renderPage([key('k1', { disabled: true })]);
    const row = screen.getByTestId('key-row');
    expect(within(row).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('offers Delete (not Edit/Revoke) only on a revoked key', () => {
    renderPage([key('active', { disabled: false }), key('revoked', { disabled: true })]);
    const rows = screen.getAllByTestId('key-row');
    // Active row: Edit + Revoke, no Delete.
    expect(within(rows[0]).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: /revoke/i })).toBeInTheDocument();
    expect(within(rows[0]).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    // Revoked row: Delete only.
    expect(within(rows[1]).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('confirming Delete permanently removes the row (calls deleteKey)', async () => {
    deleteKey.mockResolvedValue({ deleted: 'k1' });
    renderPage([key('k1', { prefix: 'helm_live_ab12', disabled: true })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^delete$/i }));
    // Confirmation step before the destructive action.
    const dialog = screen.getByRole('dialog', { name: /confirm delete/i });
    await fireEvent.click(within(dialog).getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(deleteKey).toHaveBeenCalledWith('k1'));
    // Row is gone — not merely disabled.
    await waitFor(() => expect(screen.queryAllByTestId('key-row')).toHaveLength(0));
  });

  it('on delete failure shows an error and keeps the row (fail-closed)', async () => {
    deleteKey.mockRejectedValue(new Error('409 key must be revoked before deletion'));
    renderPage([key('k1', { disabled: true })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^delete$/i }));
    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
  });

  it('on revoke failure shows an error and leaves the row unchanged (fail-closed)', async () => {
    revokeKey.mockRejectedValue(new Error('404 key not found'));
    renderPage([key('k1')]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /revoke/i }));
    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getAllByTestId('key-row')).toHaveLength(1);
  });
});
