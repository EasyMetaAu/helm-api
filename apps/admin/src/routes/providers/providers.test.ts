import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import type { OAuthProviderStatus, OAuthQuotaSnapshot, OAuthUsageRow } from '$lib/api/oauth.js';
import ProvidersPage from './+page.svelte';

const logoutOAuth = vi.fn();
const resetUsageLimit = vi.fn();
const setAccountSchedule = vi.fn();
const streamAccountTest = vi.fn();
const consumeCodexResetCredit = vi.fn();
vi.mock('$lib/api/oauth.js', () => ({
  completeManualPaste: vi.fn(),
  consumeCodexResetCredit: (...args: unknown[]) => consumeCodexResetCredit(...args),
  getAccountModels: vi.fn(),
  getAccountProxy: vi.fn(),
  getAccountSchedule: vi.fn(),
  logoutOAuth: (...args: unknown[]) => logoutOAuth(...args),
  pollDeviceCode: vi.fn(),
  resetUsageLimit: (...args: unknown[]) => resetUsageLimit(...args),
  setAccountModels: vi.fn(),
  setAccountProxy: vi.fn(),
  setAccountSchedule: (...args: unknown[]) => setAccountSchedule(...args),
  startDeviceCode: vi.fn(),
  startManualPaste: vi.fn(),
  streamAccountTest: (...args: unknown[]) => streamAccountTest(...args),
}));

const invalidateAllMock = vi.mocked(invalidateAll);

function provider(overrides: Partial<OAuthProviderStatus> = {}): OAuthProviderStatus {
  return {
    id: 'anthropic',
    name: 'Claude Max',
    flow: 'manual_paste',
    accounts: [
      {
        account: 'acct-claude',
        expiresAt: null,
        updatedAt: Date.now(),
        healthy: true,
        priority: 10,
        schedulable: true,
        // Redacted egress proxy (password never crosses) + effective routable models,
        // both folded onto the row by the gateway — the two new list columns.
        proxy: { type: 'socks5', host: '10.0.0.1', port: 1080, hasPassword: true },
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
      },
    ],
    ...overrides,
  };
}

const usage: OAuthUsageRow[] = [
  {
    providerId: 'anthropic',
    account: 'acct-claude',
    requests: 42,
    tokens: 1536,
    costUsd: 0.034,
    rpm: 0.7,
  },
];

const quota: OAuthQuotaSnapshot[] = [
  {
    providerId: 'anthropic',
    account: 'acct-claude',
    windows: [
      { key: '5h', usedPercent: 74, resetsAtMs: Date.now() + 3_600_000, windowMinutes: 300 },
    ],
    capturedAt: Date.now(),
    source: 'anthropic',
    usageLimitedUntilMs: null,
  },
];

function renderPage(
  overrides: Partial<{
    configured: boolean;
    providers: OAuthProviderStatus[];
    usage: OAuthUsageRow[];
    quota: OAuthQuotaSnapshot[];
    loadError?: string;
  }> = {},
) {
  return render(ProvidersPage, {
    data: {
      configured: true,
      providers: [provider()],
      usage,
      quota,
      ...overrides,
    },
  });
}

describe('providers page', () => {
  beforeEach(() => {
    logoutOAuth.mockReset();
    setAccountSchedule.mockReset();
    streamAccountTest.mockReset();
    consumeCodexResetCredit.mockReset();
    invalidateAllMock.mockReset();
    logoutOAuth.mockResolvedValue(undefined);
    setAccountSchedule.mockResolvedValue(undefined);
  });

  it('renders connected subscription accounts with usage, quota, and scheduling controls', () => {
    renderPage();

    expect(screen.getByText('Subscription Providers')).toBeInTheDocument();
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Claude Max')).toBeInTheDocument();
    expect(within(row).getByText('acct-claude')).toBeInTheDocument();
    expect(within(row).getByText('connected')).toBeInTheDocument();
    expect(within(row).getByText('42 req')).toBeInTheDocument();
    expect(within(row).getByText('1.5K tok')).toBeInTheDocument();
    expect(within(row).getByText('$0.034')).toBeInTheDocument();
    expect(within(row).getByText('74%')).toBeInTheDocument();
    expect(within(row).getByDisplayValue('10')).toBeInTheDocument();
    expect(within(row).getByRole('checkbox', { name: /schedulable/i })).toBeChecked();
    // Proxy column: the redacted egress hop, compact "type · host:port".
    expect(within(row).getByText('socks5 · 10.0.0.1:1080')).toBeInTheDocument();
    // Models column: each effective model as a pill (3 ≤ cap, so all show, no "+N").
    expect(within(row).getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(within(row).getByText('claude-haiku-4-5')).toBeInTheDocument();
  });

  it('renders "Direct" and caps the models list with a +N pill', () => {
    renderPage({
      providers: [
        provider({
          accounts: [
            {
              account: 'acct-copilot',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null, // direct connection
              models: ['m1', 'm2', 'm3', 'm4', 'm5'], // 5 > cap of 3 → "+2"
            },
          ],
        }),
      ],
    });
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Direct')).toBeInTheDocument();
    expect(within(row).getByText('m3')).toBeInTheDocument();
    expect(within(row).queryByText('m4')).not.toBeInTheDocument(); // collapsed
    expect(within(row).getByText('+2')).toBeInTheDocument();
  });

  it('shows the not-configured warning and disables Connect when OAuth is unavailable', () => {
    renderPage({ configured: false, providers: [], usage: [], quota: [] });

    expect(screen.getByText(/OAuth login is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
  });

  it('saves a non-negative integer priority and refreshes the page data', async () => {
    renderPage();
    const row = screen.getByTestId('provider-account-row');
    const priority = within(row).getByRole('spinbutton', { name: /priority/i });

    await fireEvent.change(priority, { target: { value: '3' } });

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('anthropic', 'acct-claude', {
        priority: 3,
      }),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid priority input without calling the gateway', async () => {
    renderPage();
    const row = screen.getByTestId('provider-account-row');
    const priority = within(row).getByRole('spinbutton', { name: /priority/i });

    await fireEvent.change(priority, { target: { value: '-1' } });

    expect(screen.getByRole('alert')).toHaveTextContent('Priority must be a non-negative integer');
    expect(setAccountSchedule).not.toHaveBeenCalled();
  });

  it('toggles schedulability through the scheduling endpoint', async () => {
    renderPage();
    const checkbox = within(screen.getByTestId('provider-account-row')).getByRole('checkbox', {
      name: /schedulable/i,
    });

    await fireEvent.click(checkbox);

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('anthropic', 'acct-claude', {
        schedulable: false,
      }),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('opens the Test dialog seeded with the account’s routable models', async () => {
    renderPage();
    const row = screen.getByTestId('provider-account-row');

    await fireEvent.click(within(row).getByRole('button', { name: /^test$/i }));

    const dialog = screen.getByRole('dialog', { name: /test connection/i });
    expect(within(dialog).getByText('acct-claude')).toBeInTheDocument();
    // The picker offers the row's effective models; the first is selected by default.
    expect(within(dialog).getByRole('option', { name: 'claude-opus-4-6' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /run test/i })).toBeInTheDocument();
  });

  it('streams the test reply through the gateway and reports success', async () => {
    streamAccountTest.mockImplementation(async function* () {
      yield { type: 'content', text: 'Hello' };
      yield { type: 'content', text: ' there' };
      yield { type: 'done', durationMs: 12 };
    });
    renderPage();
    await fireEvent.click(
      within(screen.getByTestId('provider-account-row')).getByRole('button', { name: /^test$/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /test connection/i });

    await fireEvent.click(within(dialog).getByRole('button', { name: /run test/i }));

    await waitFor(() =>
      expect(streamAccountTest).toHaveBeenCalledWith(
        'anthropic',
        { account: 'acct-claude', model: 'claude-opus-4-6', prompt: undefined },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId('test-response')).toHaveTextContent('Hello there'),
    );
    expect(within(dialog).getByText('Success')).toBeInTheDocument();
  });

  it('confirms and disconnects a stored account credential', async () => {
    renderPage();
    await fireEvent.click(
      within(screen.getByTestId('provider-account-row')).getByRole('button', {
        name: /disconnect/i,
      }),
    );

    const dialog = screen.getByRole('dialog', { name: /confirm disconnect/i });
    await fireEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));

    await waitFor(() => expect(logoutOAuth).toHaveBeenCalledWith('anthropic', 'acct-claude'));
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  // ── Codex "Reset limit" (rate-limit reset credit) ──────────────────────────
  // One Codex account + a quota snapshot carrying the live reset-credit count.
  function renderCodex(resetCredits: number | null) {
    renderPage({
      providers: [
        provider({
          id: 'openai-codex',
          name: 'Codex',
          accounts: [
            {
              account: 'acct-codex',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null,
              models: ['gpt-5.5'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [
        {
          providerId: 'openai-codex',
          account: 'acct-codex',
          windows: [
            { key: 'primary', usedPercent: 80, resetsAtMs: Date.now() + 3_600_000, windowMinutes: 300 },
          ],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits,
        },
      ],
    });
  }

  it('consumes a Codex reset credit and refreshes when "Reset limit" is clicked', async () => {
    consumeCodexResetCredit.mockResolvedValue({ code: 'ok', windowsReset: 2 });
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    // The available reset-credit count renders in the Quota cell.
    expect(within(row).getByText('2 reset credits')).toBeInTheDocument();

    const resetBtn = within(row).getByRole('button', { name: /reset limit/i });
    expect(resetBtn).toBeEnabled();
    await fireEvent.click(resetBtn);

    await waitFor(() =>
      expect(consumeCodexResetCredit).toHaveBeenCalledWith('openai-codex', 'acct-codex'),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
    // Success banner reflects how many windows were restored.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Reset 2 window(s)'),
    );
  });

  it('disables "Reset limit" for a Codex account with no reset credits', () => {
    renderCodex(0);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByRole('button', { name: /reset limit/i })).toBeDisabled();
    expect(consumeCodexResetCredit).not.toHaveBeenCalled();
  });

  it('does not render "Reset limit" for non-Codex accounts', () => {
    renderPage(); // default anthropic account
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).queryByRole('button', { name: /reset limit/i })).not.toBeInTheDocument();
  });
});
