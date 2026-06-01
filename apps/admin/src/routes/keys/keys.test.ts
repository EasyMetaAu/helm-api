import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from '$lib/api/keys.js';
import KeysPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the keys API client (mocked). Hard security line (Principle 7 / docs/06):
// list & detail expose ONLY the prefix + sha256 reference — never plaintext.

const createKey = vi.fn();
const revokeKey = vi.fn();
const updateKey = vi.fn();
vi.mock('$lib/api/keys.js', () => ({
  createKey: (...args: unknown[]) => createKey(...args),
  revokeKey: (...args: unknown[]) => revokeKey(...args),
  updateKey: (...args: unknown[]) => updateKey(...args),
}));

function key(keyId: string, overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    key_id: keyId,
    prefix: `helm_live_${keyId}`,
    role: 'user',
    max_lane: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    ...overrides,
  };
}

function renderPage(keys: ApiKeyView[], lanes: string[] = ['economy', 'balanced', 'premium']) {
  return render(KeysPage, { data: { keys, lanes } });
}

describe('keys page', () => {
  beforeEach(() => {
    createKey.mockReset();
    revokeKey.mockReset();
    updateKey.mockReset();
    updateKey.mockResolvedValue(undefined);
    revokeKey.mockResolvedValue({ revoked: '' });
  });

  it('lists each key by prefix/role/caps/status and shows NO plaintext-like secret', () => {
    renderPage([
      key('k1', { prefix: 'helm_live_ab12', role: 'user', max_lane: 'balanced' }),
      key('k2', { prefix: 'helm_live_cd34', disabled: true }),
    ]);
    expect(screen.getAllByTestId('key-row')).toHaveLength(2);
    expect(screen.getByText('helm_live_ab12')).toBeInTheDocument();
    expect(screen.getByText('helm_live_cd34')).toBeInTheDocument();
    // No long opaque secret string anywhere (prefixes are short helm_live_xxxx).
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/helm_live_[A-Za-z0-9]{16,}/);
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
    createKey.mockResolvedValue({ key_id: 'key_new', plaintext: 'helm_live_TOPSECRETVALUE0000' });
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

  it('Edit opens a dialog and PATCHes the full editable cap set via updateKey', async () => {
    renderPage([key('k1', { rate_limit_rpm: null, rate_limit_tpm: null })]);
    const row = screen.getByTestId('key-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog', { name: /edit key/i });
    // The key value/prefix and role are shown read-only — never an editable field.
    expect(within(dialog).getByText('helm_live_k1')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/role/i)).not.toBeInTheDocument();
    // Edit caps: set a max-lane cap, whitelist a lane, set an explicit RPM.
    await fireEvent.change(within(dialog).getByLabelText(/max lane/i), {
      target: { value: 'balanced' },
    });
    await fireEvent.click(within(dialog).getByLabelText('economy'));
    await fireEvent.input(within(dialog).getByLabelText(/requests per minute/i), {
      target: { value: '120' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith('k1', {
        max_lane: 'balanced',
        allowed_lanes: ['economy'],
        allow_custom_model: false,
        rate_limit_rpm: 120,
        rate_limit_tpm: null, // untouched → still inherit (null), not undefined
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

  it('does not offer Edit on a revoked (disabled) key', () => {
    renderPage([key('k1', { disabled: true })]);
    const row = screen.getByTestId('key-row');
    expect(within(row).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
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
