import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateKeyDialog from './CreateKeyDialog.svelte';

// The dialog owns the create form + the plaintext reveal. It calls the
// injected `createKey` and bubbles the new key view up via `oncreated`. The
// plaintext is wiped from component state on close; the server may also store
// encrypted recovery material for later admin reveal.

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
    createKey.mockResolvedValue({
      key_id: 'key_1',
      plaintext: PLAINTEXT,
      prefix: PREFIX,
      recoverable: true,
    });
  });

  it('submits the chosen allowed-lanes whitelist + independent model blacklist to createKey', async () => {
    setup();
    // Tick a subset of lanes; the whitelist is the only lane cap (no max-lane field).
    await fireEvent.click(screen.getByLabelText('economy'));
    await fireEvent.click(screen.getByLabelText('balanced'));
    await fireEvent.input(screen.getByLabelText('Blocked models'), {
      target: { value: 'gpt-4o\nanthropic/claude-sonnet-4-6' },
    });
    await fireEvent.click(screen.getByLabelText('allow client-requested Fast mode'));
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    const input = createKey.mock.calls[0][0];
    expect(input.allowed_lanes).toEqual(['economy', 'balanced']);
    expect(input.blocked_models).toEqual(['gpt-4o', 'anthropic/claude-sonnet-4-6']);
    expect(input.allow_custom_model).toBe(false);
    expect(input.allow_fast_mode).toBe(true);
  });

  it('omits allowed_lanes when no lane is checked (no whitelist = any lane)', async () => {
    setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    const input = createKey.mock.calls[0][0];
    expect(input.allowed_lanes).toBeUndefined();
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

  it('submits a request-content override when selected', async () => {
    setup();
    await fireEvent.change(screen.getByLabelText('Request content storage'), {
      target: { value: 'payload' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    expect(createKey.mock.calls[0][0].request_content_mode).toBe('payload');
  });

  it('collapses the optional cap sections by default, basics stay visible', async () => {
    setup();
    // Basics (lanes + blacklist + passthrough) are immediately visible — not inside a section.
    expect(screen.getByLabelText('economy')).toBeInTheDocument();
    expect(screen.getByLabelText('Blocked models')).toBeInTheDocument();
    expect(screen.getByLabelText('allow custom model')).toBeInTheDocument();
    expect(screen.getByLabelText('allow client-requested Fast mode')).toBeInTheDocument();
    // The three optional groups render as <details> sections, all closed.
    const sections = document.querySelectorAll('details');
    expect(sections).toHaveLength(4);
    for (const section of sections) expect(section.open).toBe(false);
    // Each closed section carries a one-line state summary so the operator can
    // see "nothing configured" without expanding.
    expect(screen.getByText(/rate & concurrency/i)).toBeInTheDocument();
    expect(screen.getByText('Using system defaults')).toBeInTheDocument();
    expect(screen.getByText('No budget')).toBeInTheDocument();
  });

  it('submits budget fields edited inside a collapsed section', async () => {
    setup();
    await fireEvent.input(screen.getByLabelText(/max spend/i), { target: { value: '5' } });
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    const input = createKey.mock.calls[0][0];
    expect(input.budget_spend_usd).toBe(5);
    expect(input.budget_requests).toBeUndefined();
  });

  it('reveals the plaintext exactly once with a copy button after creation', async () => {
    setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());
    expect(screen.getByTestId('plaintext-reveal')).toHaveTextContent(PLAINTEXT);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('offers a "Connect a client" guide carrying the freshly-minted plaintext', async () => {
    setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());

    // The reveal step offers a guide; opening it injects the real key into a snippet
    // (one-time), so the operator can copy a complete config without leaving the flow.
    await fireEvent.click(screen.getByRole('button', { name: /connect a client/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /connect a client/i })).toBeInTheDocument(),
    );
    expect(screen.getByTestId('snippet-claude')).toHaveTextContent(PLAINTEXT);
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

  it('renders the create form inside a dismissible modal (scrim + Escape close)', async () => {
    const { onclose } = setup();
    expect(screen.getByRole('dialog', { name: /create api key/i })).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('modal-scrim'));
    expect(onclose).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('locks the one-time plaintext reveal — modal is NOT dismissible (must acknowledge)', async () => {
    const { onclose } = setup();
    await fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument());
    // No scrim to click, and Escape must not dismiss the secret reveal.
    expect(screen.queryByTestId('modal-scrim')).not.toBeInTheDocument();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onclose).not.toHaveBeenCalled();
    expect(screen.getByTestId('plaintext-reveal')).toBeInTheDocument();
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
