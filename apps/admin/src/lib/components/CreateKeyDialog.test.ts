import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateKeyDialog from './CreateKeyDialog.svelte';

// The dialog owns the create form + the ONE-TIME plaintext reveal. It calls the
// injected `createKey` and bubbles the new key view up via `oncreated`. The
// plaintext is shown exactly once and wiped from component state on close
// (CLAUDE.md Principle 7 / docs/06: plaintext returns once, never re-viewable).

const createKey = vi.fn();
vi.mock('$lib/api/keys.js', () => ({
  createKey: (...args: unknown[]) => createKey(...args),
}));

const PLAINTEXT = 'helm_live_PLAINTEXT_ONLY_ONCE';
// Deliberately NOT equal to PLAINTEXT.slice(0,14) so the test fails if the dialog
// reverts to slicing the plaintext instead of using the server-minted prefix.
const PREFIX = 'helm_live_ab12';

function setup() {
  const oncreated = vi.fn();
  const onclose = vi.fn();
  const lanes = ['economy', 'balanced', 'premium'];
  render(CreateKeyDialog, { lanes, oncreated, onclose });
  return { oncreated, onclose };
}

describe('CreateKeyDialog', () => {
  beforeEach(() => {
    createKey.mockReset();
    createKey.mockResolvedValue({ key_id: 'key_1', plaintext: PLAINTEXT, prefix: PREFIX });
  });

  it('submits the chosen caps (max_lane + allow_custom_model) to createKey', async () => {
    setup();
    await fireEvent.change(screen.getByLabelText(/max lane/i), { target: { value: 'balanced' } });
    // allow_custom_model defaults to false; leave the checkbox unchecked.
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    const input = createKey.mock.calls[0][0];
    expect(input.max_lane).toBe('balanced');
    expect(input.allow_custom_model).toBe(false);
  });

  it('submits per-key rate limits when filled, and omits them when left blank', async () => {
    setup();
    await fireEvent.input(screen.getByLabelText(/requests per minute|rpm/i), {
      target: { value: '60' },
    });
    // Leave TPM blank -> it must be omitted (inherit the system default).
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    const input = createKey.mock.calls[0][0];
    expect(input.rate_limit_rpm).toBe(60);
    expect(input.rate_limit_tpm).toBeUndefined();
  });

  it('reveals the plaintext exactly once with a copy button after creation', async () => {
    setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());
    expect(screen.getByTestId('plaintext-reveal')).toHaveTextContent(PLAINTEXT);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('wipes the plaintext from the DOM once saved/closed — not re-viewable', async () => {
    const { oncreated, onclose } = setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());

    // Confirm the operator has stored the secret.
    await fireEvent.click(screen.getByRole('button', { name: /saved it|done/i }));

    await waitFor(() => expect(screen.queryByTestId('plaintext-reveal')).not.toBeInTheDocument());
    expect(document.body.textContent ?? '').not.toContain(PLAINTEXT);
    // The dialog bubbles the redacted view up (prefix only) and asks to close.
    expect(oncreated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(oncreated.mock.calls[0][0])).not.toContain(PLAINTEXT);
    // The bubbled view uses the server-minted prefix, NOT a slice of the plaintext.
    expect(oncreated.mock.calls[0][0].prefix).toBe(PREFIX);
    expect(onclose).toHaveBeenCalled();
  });

  it('shows an error and reveals no plaintext when createKey fails (fail-closed)', async () => {
    createKey.mockRejectedValue(new Error('400 invalid key request'));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('plaintext-reveal')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(PLAINTEXT);
  });
});
