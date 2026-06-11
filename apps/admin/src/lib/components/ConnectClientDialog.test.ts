import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectClientDialog from './ConnectClientDialog.svelte';

// The "Connect a client" guide: a tabbed, copy-paste integration reference shown
// on the API Keys page. It teaches the asymmetric base-URL convention that is the
// #1 onboarding footgun — Claude Code wants the BARE origin (no /v1), Codex wants
// origin + /v1 (see docs/08, helm-claude-code-base-url + codex-helm-setup memos).
//
// The base URL is read from window.location.origin (admin is same-origin with the
// gateway). The API key is a placeholder by default; when opened right after key
// creation the freshly-minted plaintext is injected (one-time) — but never
// persisted, mirroring CreateKeyDialog's reveal discipline (CLAUDE.md 原则7).

const ORIGIN = 'https://helm.example.test';

function stubOrigin(value: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, origin: value, href: `${value}/admin/keys` },
  });
}

function setup(props: { plaintextKey?: string } = {}) {
  const onclose = vi.fn();
  render(ConnectClientDialog, { onclose, ...props });
  return { onclose };
}

describe('ConnectClientDialog', () => {
  beforeEach(() => {
    stubOrigin(ORIGIN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders inside a labelled, dismissible modal', async () => {
    const { onclose } = setup();
    expect(screen.getByRole('dialog', { name: /connect a client/i })).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('modal-scrim'));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('defaults to the Claude Code tab and shows the BARE origin with no /v1 suffix', () => {
    setup();
    const claudeTab = screen.getByRole('tab', { name: /claude code/i });
    expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    // The env snippet must point ANTHROPIC_BASE_URL at the bare origin. A trailing
    // /v1 here is the exact bug that 404s every model — assert it is absent.
    const snippet = screen.getByTestId('snippet-claude').textContent ?? '';
    expect(snippet).toContain(`ANTHROPIC_BASE_URL="${ORIGIN}"`);
    expect(snippet).not.toContain(`${ORIGIN}/v1`);
    expect(snippet).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('renders the Codex tab with base_url ending in /v1 and wire_api = "responses"', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /codex/i }));
    const snippet = screen.getByTestId('snippet-codex').textContent ?? '';
    expect(snippet).toContain(`base_url = "${ORIGIN}/v1"`);
    expect(snippet).toContain('wire_api = "responses"');
  });

  it('renders the Gemini tab with the native /v1beta path and x-goog-api-key auth', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /gemini/i }));
    const snippet = screen.getByTestId('snippet-gemini').textContent ?? '';
    expect(snippet).toContain(`${ORIGIN}/v1beta/models/auto:generateContent`);
    expect(snippet).toContain('x-goog-api-key');
    expect(snippet).not.toContain(`${ORIGIN}/v1/`);
  });

  it('renders a Gemini CLI env snippet with GOOGLE_GEMINI_BASE_URL at the bare origin', async () => {
    // The official Gemini CLI / Google GenAI SDK reads GOOGLE_GEMINI_BASE_URL and
    // appends /v1beta/models/{model}:generateContent itself — so the base URL must
    // be the BARE origin. A trailing /v1 (or /v1beta) here double-prefixes the path.
    setup({ plaintextKey: 'helm_live_GEMINI' });
    await fireEvent.click(screen.getByRole('tab', { name: /gemini/i }));
    const env = screen.getByTestId('snippet-gemini-env').textContent ?? '';
    expect(env).toContain(`export GOOGLE_GEMINI_BASE_URL="${ORIGIN}"`);
    expect(env).not.toContain(`${ORIGIN}/v1`);
    expect(env).toContain('export GEMINI_API_KEY="helm_live_GEMINI"');
  });

  it('shows a placeholder key when no plaintext is supplied (opened from the header)', () => {
    setup();
    expect(screen.getByTestId('snippet-claude').textContent ?? '').toContain('<your-helm-key>');
    // No one-time-secret caption when we are only showing a placeholder.
    expect(screen.queryByTestId('connect-secret-note')).not.toBeInTheDocument();
  });

  it('injects the freshly-minted plaintext into every tab when supplied', async () => {
    const KEY = 'helm_live_FRESH_ONE_TIME';
    setup({ plaintextKey: KEY });
    // Claude (default) tab carries it…
    expect(screen.getByTestId('snippet-claude').textContent ?? '').toContain(KEY);
    expect(screen.getByTestId('snippet-claude').textContent ?? '').not.toContain('<your-helm-key>');
    // …and so does the Codex tab.
    await fireEvent.click(screen.getByRole('tab', { name: /codex/i }));
    expect(screen.getByTestId('snippet-codex').textContent ?? '').toContain(KEY);
    // A one-time-secret caption warns the operator to copy now.
    expect(screen.getByTestId('connect-secret-note')).toBeInTheDocument();
  });

  it('copies the active snippet to the clipboard and flips the button to "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setup();
    const copyBtn = screen.getAllByRole('button', { name: /^copy$/i })[0];
    await fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain(`ANTHROPIC_BASE_URL="${ORIGIN}"`);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /copied/i }).length).toBeGreaterThan(0));
  });

  it('exposes Claude Code, Codex, Gemini, OpenClaw and SDK tabs', () => {
    setup();
    expect(screen.getByRole('tab', { name: /claude code/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /codex/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /gemini/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /openclaw/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sdk/i })).toBeInTheDocument();
  });
});
