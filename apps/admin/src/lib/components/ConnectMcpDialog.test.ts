import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectMcpDialog from './ConnectMcpDialog.svelte';

// "Connect via MCP" guide on the Memory page — mirrors ConnectClientDialog but for
// Helm's memory MCP server (docs/13). The server lives at POST /mcp on the BARE
// origin (the MCP Streamable HTTP transport), authed by the same API key as a
// bearer token. The footgun guarded here is the inverse of the /v1 one: /mcp must
// sit on the bare origin, never /v1/mcp (that path is the chat surface).
//
// The base URL is read from window.location.origin (admin is same-origin with the
// gateway). The key is a copy-and-replace placeholder unless a freshly-minted
// plaintext is injected (one-time), mirroring CLAUDE.md 原则7.

const ORIGIN = 'https://helm.example.test';
const MCP_URL = `${ORIGIN}/mcp`;

function stubOrigin(value: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, origin: value, href: `${value}/admin/memory` },
  });
}

function setup(props: { plaintextKey?: string } = {}) {
  const onclose = vi.fn();
  render(ConnectMcpDialog, { onclose, ...props });
  return { onclose };
}

describe('ConnectMcpDialog', () => {
  beforeEach(() => {
    stubOrigin(ORIGIN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders inside a labelled, dismissible modal', async () => {
    const { onclose } = setup();
    expect(screen.getByRole('dialog', { name: /connect via mcp/i })).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('modal-scrim'));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('defaults to the Claude Code tab and registers /mcp on the BARE origin (no /v1)', () => {
    setup();
    const claudeTab = screen.getByRole('tab', { name: /claude code/i });
    expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    const snippet = screen.getByTestId('snippet-mcp-claude').textContent ?? '';
    expect(snippet).toContain(`claude mcp add --transport http helm-memory ${MCP_URL}`);
    expect(snippet).toContain('--header "Authorization: Bearer <your-helm-key>"');
    // The endpoint must be the bare origin + /mcp. A /v1/mcp here is the 404 footgun.
    expect(snippet).not.toContain(`${ORIGIN}/v1`);
  });

  it('renders the JSON config tab with type "http" and the bearer header', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /json config/i }));
    const snippet = screen.getByTestId('snippet-mcp-json').textContent ?? '';
    expect(snippet).toContain('"mcpServers"');
    expect(snippet).toContain('"type": "http"');
    expect(snippet).toContain(`"url": "${MCP_URL}"`);
    expect(snippet).toContain('"Authorization": "Bearer <your-helm-key>"');
    expect(snippet).not.toContain(`${ORIGIN}/v1`);
  });

  it('renders the Codex tab as an mcp-remote stdio bridge', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /codex/i }));
    const snippet = screen.getByTestId('snippet-mcp-codex').textContent ?? '';
    expect(snippet).toContain('[mcp_servers.helm-memory]');
    expect(snippet).toContain('mcp-remote');
    expect(snippet).toContain(MCP_URL);
    // No space around the header colon — Codex arg parsing trips on it otherwise.
    expect(snippet).toContain('"Authorization:Bearer <your-helm-key>"');
  });

  it('renders the curl tab with a tools/list JSON-RPC probe to /mcp', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /^curl$/i }));
    const snippet = screen.getByTestId('snippet-mcp-curl').textContent ?? '';
    expect(snippet).toContain(`curl -X POST "${MCP_URL}"`);
    expect(snippet).toContain('Authorization: Bearer <your-helm-key>');
    expect(snippet).toContain('"method":"tools/list"');
  });

  it('shows a placeholder key when no plaintext is supplied (opened from the header)', () => {
    setup();
    expect(screen.getByTestId('snippet-mcp-claude').textContent ?? '').toContain('<your-helm-key>');
    expect(screen.queryByTestId('connect-secret-note')).not.toBeInTheDocument();
  });

  it('injects the freshly-minted plaintext into every tab when supplied', async () => {
    const KEY = 'helm_live_FRESH_ONE_TIME';
    setup({ plaintextKey: KEY });
    expect(screen.getByTestId('snippet-mcp-claude').textContent ?? '').toContain(KEY);
    expect(screen.getByTestId('snippet-mcp-claude').textContent ?? '').not.toContain(
      '<your-helm-key>',
    );
    await fireEvent.click(screen.getByRole('tab', { name: /json config/i }));
    expect(screen.getByTestId('snippet-mcp-json').textContent ?? '').toContain(KEY);
    expect(screen.getByTestId('connect-secret-note')).toBeInTheDocument();
  });

  it('copies the active snippet to the clipboard and flips the button to "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setup();
    const copyBtn = screen.getAllByRole('button', { name: /^copy$/i })[0];
    await fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain(`helm-memory ${MCP_URL}`);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /copied/i }).length).toBeGreaterThan(0),
    );
  });

  it('exposes Claude Code, JSON config, Codex and curl tabs', () => {
    setup();
    expect(screen.getByRole('tab', { name: /claude code/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /json config/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /codex/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^curl$/i })).toBeInTheDocument();
  });
});
