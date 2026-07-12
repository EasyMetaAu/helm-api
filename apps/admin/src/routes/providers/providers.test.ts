import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import type {
  OAuthProviderStatus,
  OAuthQuotaSnapshot,
  OAuthSelectionStrategy,
  OAuthUsageRow,
} from '$lib/api/oauth.js';
import ProvidersPage from './+page.svelte';

const logoutOAuth = vi.fn();
const resetUsageLimit = vi.fn();
const getAccountModels = vi.fn();
const getAccountProxy = vi.fn();
const getAccountSchedule = vi.fn();
const setAccountModels = vi.fn();
const setAccountSchedule = vi.fn();
const setSelectionStrategy = vi.fn();
const streamAccountTest = vi.fn();
const consumeCodexResetCredit = vi.fn();
vi.mock('$lib/api/oauth.js', () => ({
  completeManualPaste: vi.fn(),
  consumeCodexResetCredit: (...args: unknown[]) => consumeCodexResetCredit(...args),
  getAccountModels: (...args: unknown[]) => getAccountModels(...args),
  getAccountProxy: (...args: unknown[]) => getAccountProxy(...args),
  getAccountSchedule: (...args: unknown[]) => getAccountSchedule(...args),
  logoutOAuth: (...args: unknown[]) => logoutOAuth(...args),
  pollDeviceCode: vi.fn(),
  resetUsageLimit: (...args: unknown[]) => resetUsageLimit(...args),
  setAccountModels: (...args: unknown[]) => setAccountModels(...args),
  setAccountProxy: vi.fn(),
  setAccountSchedule: (...args: unknown[]) => setAccountSchedule(...args),
  setSelectionStrategy: (...args: unknown[]) => setSelectionStrategy(...args),
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
        fastMode: false,
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
    selectionStrategy: OAuthSelectionStrategy;
    providers: OAuthProviderStatus[];
    usage: OAuthUsageRow[];
    quota: OAuthQuotaSnapshot[];
    loadError?: string;
  }> = {},
) {
  return render(ProvidersPage, {
    data: {
      configured: true,
      selectionStrategy: 'balanced',
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
    getAccountModels.mockReset();
    getAccountProxy.mockReset();
    getAccountSchedule.mockReset();
    setAccountModels.mockReset();
    setAccountSchedule.mockReset();
    setSelectionStrategy.mockReset();
    streamAccountTest.mockReset();
    consumeCodexResetCredit.mockReset();
    invalidateAllMock.mockReset();
    logoutOAuth.mockResolvedValue(undefined);
    getAccountModels.mockResolvedValue({
      available: [],
      enabled: [],
      canPull: true,
      modelsMode: 'auto',
    });
    getAccountProxy.mockResolvedValue(null);
    getAccountSchedule.mockResolvedValue({
      priority: 50,
      schedulable: true,
      autoReset: false,
      fastMode: false,
    });
    setAccountModels.mockResolvedValue(undefined);
    setAccountSchedule.mockResolvedValue(undefined);
    setSelectionStrategy.mockResolvedValue(undefined);
  });

  it('renders connected subscription accounts with usage, quota, and scheduling controls', () => {
    renderPage();

    expect(screen.getByText('Subscription Providers')).toBeInTheDocument();
    expect(screen.getByLabelText('Account usage strategy')).toHaveValue('balanced');
    expect(
      screen.getByText(
        'Applies to all connected subscription accounts. Per-account controls stay limited to priority and scheduling.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Spread new sessions across accounts while keeping sessions sticky.'),
    ).toBeInTheDocument();
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
    expect(within(row).getByRole('checkbox', { name: /fast mode/i })).not.toBeChecked();
    // Proxy column: the redacted egress hop, compact "type · host:port".
    expect(within(row).getByText('socks5 · 10.0.0.1:1080')).toBeInTheDocument();
    // Models column: each effective model as a pill (3 ≤ cap, so all show, no "+N").
    expect(within(row).getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(within(row).getByText('claude-haiku-4-5')).toBeInTheDocument();
  });

  it('renders Codex subscription identity details only when present', () => {
    renderPage({
      providers: [
        provider({
          id: 'openai-codex',
          name: 'Codex',
          accounts: [
            {
              account: 'acct-codex',
              email: 'lukin@example.com',
              chatgptPlanType: 'plus',
              chatgptAccountId: 'chatgpt-account-123',
              isFedramp: true,
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null,
              models: ['gpt-5.6-sol'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });

    const row = screen.getByTestId('provider-account-row');
    const details = within(row).getByTestId('codex-subscription-details');
    expect(within(details).getByText('lukin@example.com')).toBeInTheDocument();
    expect(within(details).getByText('Plus')).toBeInTheDocument();
    expect(within(details).getByText('ChatGPT ID: chatgpt-account-123')).toBeInTheDocument();
    expect(within(details).getByText('FedRAMP')).toBeInTheDocument();
  });

  it('prefers the live Codex quota plan over a stale identity plan', () => {
    renderPage({
      providers: [
        provider({
          id: 'openai-codex',
          name: 'ChatGPT Plus/Pro (Codex)',
          accounts: [
            {
              account: 'acct-codex',
              chatgptPlanType: 'pro',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null,
              models: ['gpt-5.6-sol'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [
        {
          providerId: 'openai-codex',
          account: 'acct-codex',
          windows: [],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits: null,
          planType: 'plus',
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    const details = within(row).getByTestId('codex-subscription-details');
    const quotaCell = within(row).getByTestId('provider-quota-cell');
    expect(within(details).getByText('Plus')).toBeInTheDocument();
    expect(within(details).queryByText('Pro')).not.toBeInTheDocument();
    expect(within(quotaCell).getByText('Plan: Plus')).toBeInTheDocument();
  });

  it('does not reserve subscription-detail space when Codex claims are absent', () => {
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
              models: ['gpt-5.6-sol'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });

    expect(
      within(screen.getByTestId('provider-account-row')).queryByTestId(
        'codex-subscription-details',
      ),
    ).not.toBeInTheDocument();
  });

  it('edits model lists only in manual mode and saves mode with models', async () => {
    getAccountModels.mockResolvedValue({
      available: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      enabled: ['gpt-5.6-sol'],
      canPull: true,
      modelsMode: 'auto',
    });
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
              models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });

    await fireEvent.click(
      within(screen.getByTestId('provider-account-row')).getByRole('button', {
        name: /manage/i,
      }),
    );

    const dialog = screen.getByRole('dialog', { name: /manage account/i });
    const automatic = await within(dialog).findByRole('radio', { name: /automatic/i });
    const manual = within(dialog).getByRole('radio', { name: /manual/i });
    expect(automatic).toBeChecked();
    expect(within(dialog).queryByPlaceholderText('Add a model id…')).not.toBeInTheDocument();
    expect(within(dialog).getByText('gpt-5.6-terra')).toBeInTheDocument();

    await fireEvent.click(manual);

    expect(manual).toBeChecked();
    expect(within(dialog).getByPlaceholderText('Add a model id…')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Pull from provider (2)' }),
    ).toBeInTheDocument();

    await fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(setAccountModels).toHaveBeenCalledWith('openai-codex', 'acct-codex', {
        mode: 'manual',
        models: ['gpt-5.6-sol'],
      }),
    );
  });

  it('updates the global account selection strategy', async () => {
    renderPage();

    await fireEvent.change(screen.getByLabelText('Account usage strategy'), {
      target: { value: 'use_expiring' },
    });

    await waitFor(() => expect(setSelectionStrategy).toHaveBeenCalledWith('use_expiring'));
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('renders the shared refresh control with auto-refresh intervals', async () => {
    renderPage();

    await fireEvent.click(screen.getByTestId('refresh-now'));
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    expect(screen.getByTestId('refresh-menu')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-interval-10')).toHaveTextContent('10s');
  });

  it('labels the current Claude scoped weekly Fable quota window', () => {
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            { key: '5h', usedPercent: 11, resetsAtMs: Date.now() + 3_600_000, windowMinutes: null },
            {
              key: '7d',
              usedPercent: 7,
              resetsAtMs: Date.now() + 86_400_000,
              windowMinutes: null,
            },
            {
              key: '7d-fable',
              usedPercent: 5,
              resetsAtMs: Date.now() + 86_400_000,
              windowMinutes: null,
            },
          ],
          capturedAt: Date.now(),
          source: 'anthropic',
          usageLimitedUntilMs: null,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('7d · Fable')).toBeInTheDocument();
    expect(within(row).getByText('5%')).toBeInTheDocument();
  });

  it('uses the saturated quota window as the rate-limit recovery source', () => {
    const now = Date.now();
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            { key: '5h', usedPercent: 0, resetsAtMs: now + 30 * 60_000, windowMinutes: null },
            {
              key: '7d',
              usedPercent: 100,
              resetsAtMs: now + 8 * 60 * 60_000 + 11 * 60_000,
              windowMinutes: null,
            },
          ],
          capturedAt: now,
          source: 'anthropic',
          usageLimitedUntilMs: now + 60_000,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Rate limited')).toBeInTheDocument();
    expect(within(row).getByText(/7d.*auto-recovers in 8h/i)).toBeInTheDocument();
  });

  it('uses a near-full 5h quota window over the generic 429 fallback', () => {
    const now = Date.now();
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            {
              key: '5h',
              usedPercent: 98,
              resetsAtMs: now + 2 * 60 * 60_000 + 57 * 60_000,
              windowMinutes: null,
            },
            {
              key: '7d',
              usedPercent: 61,
              resetsAtMs: now + 5 * 86_400_000 + 10 * 60 * 60_000,
              windowMinutes: null,
            },
            {
              key: '7d-sonnet',
              usedPercent: 37,
              resetsAtMs: now + 5 * 86_400_000 + 10 * 60 * 60_000,
              windowMinutes: null,
            },
          ],
          capturedAt: now,
          source: 'anthropic',
          usageLimitedUntilMs: now + 60_000,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Rate limited')).toBeInTheDocument();
    expect(within(row).getByText(/5h.*auto-recovers in 2h/i)).toBeInTheDocument();
    expect(within(row).queryByText(/auto-recovers in 0m/i)).not.toBeInTheDocument();
  });

  it('does not treat saturated scoped Claude model windows as a global account limit', () => {
    const now = Date.now();
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            { key: '5h', usedPercent: 8, resetsAtMs: now + 3 * 60 * 60_000, windowMinutes: null },
            {
              key: '7d',
              usedPercent: 75,
              resetsAtMs: now + 2 * 86_400_000,
              windowMinutes: null,
            },
            {
              key: '7d-fable',
              usedPercent: 100,
              resetsAtMs: now + 2 * 86_400_000,
              windowMinutes: null,
            },
            {
              key: '7d-sonnet',
              usedPercent: 100,
              resetsAtMs: now + 2 * 86_400_000,
              windowMinutes: null,
            },
          ],
          capturedAt: now,
          source: 'anthropic',
          usageLimitedUntilMs: now + 2 * 86_400_000,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('7d · Fable')).toBeInTheDocument();
    expect(within(row).getAllByText('100%')).toHaveLength(2);
    expect(within(row).queryByText('Rate limited')).not.toBeInTheDocument();
  });

  it('does not mark a healthy account rate-limited from a near-full window alone', () => {
    const now = Date.now();
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            {
              key: '5h',
              usedPercent: 98,
              resetsAtMs: now + 2 * 60 * 60_000 + 57 * 60_000,
              windowMinutes: null,
            },
          ],
          capturedAt: now,
          source: 'anthropic',
          usageLimitedUntilMs: null,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('98%')).toBeInTheDocument();
    expect(within(row).queryByText('Rate limited')).not.toBeInTheDocument();
  });

  it('does not render the local retry action for a rate-limited Anthropic account', () => {
    const now = Date.now();
    renderPage({
      quota: [
        {
          providerId: 'anthropic',
          account: 'acct-claude',
          windows: [
            {
              key: '5h',
              usedPercent: 100,
              resetsAtMs: now + 2 * 60 * 60_000,
              windowMinutes: null,
            },
          ],
          capturedAt: now,
          source: 'anthropic',
          usageLimitedUntilMs: now + 2 * 60 * 60_000,
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Rate limited')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /reset usage/i })).not.toBeInTheDocument();
    expect(resetUsageLimit).not.toHaveBeenCalled();
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

  it('disables schedulability for credential-failed accounts', async () => {
    renderPage({
      providers: [
        provider({
          accounts: [
            {
              account: 'acct-claude',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: false,
              credentialFailed: true,
              priority: 10,
              schedulable: false,
              fastMode: false,
              proxy: null,
              models: ['claude-opus-4-6'],
            },
          ],
        }),
      ],
    });
    const row = screen.getByTestId('provider-account-row');
    const checkbox = within(row).getByRole('checkbox', { name: /schedulable/i });

    expect(within(row).getByText('needs reconnect')).toBeInTheDocument();
    expect(checkbox).toBeDisabled();

    expect(setAccountSchedule).not.toHaveBeenCalled();
  });

  it('toggles per-account Fast mode through the scheduling endpoint', async () => {
    renderPage();
    const checkbox = within(screen.getByTestId('provider-account-row')).getByRole('checkbox', {
      name: /fast mode/i,
    });

    await fireEvent.click(checkbox);

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('anthropic', 'acct-claude', {
        fastMode: true,
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
  function renderCodex(
    resetCredits: number | null,
    autoReset = false,
    weeklyUsedPercent = 95,
    rateLimitReachedType: OAuthQuotaSnapshot['rateLimitReachedType'] = 'rate_limit_reached',
  ) {
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
              autoReset,
              fastMode: false,
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
            {
              key: 'primary',
              usedPercent: 80,
              resetsAtMs: Date.now() + 3_600_000,
              windowMinutes: 300,
            },
            {
              key: 'secondary',
              usedPercent: weeklyUsedPercent,
              resetsAtMs: Date.now() + 3 * 86_400_000,
              windowMinutes: 10_080,
            },
          ],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits,
          planType: 'pro',
          credits: { hasCredits: true, unlimited: false, balance: '9.99' },
          rateLimitReachedType,
          resetCreditDetails: [
            {
              id: 'credit-1',
              resetType: 'codexRateLimits',
              status: 'available',
              grantedAt: Math.floor(Date.now() / 1000),
              expiresAt: Math.floor(Date.now() / 1000) + 86_400,
              title: 'Full reset',
              description: 'Restore Codex rate limits',
            },
          ],
        },
      ],
    });
  }

  function renderCodexCooldown(
    windows: OAuthQuotaSnapshot['windows'],
    usageLimitedUntilMs: number,
  ) {
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
              autoReset: false,
              fastMode: false,
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
          windows,
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs,
          resetCredits: 2,
        },
      ],
    });
  }

  it('shows the Auto-reset badge on the list only when the account opted in', async () => {
    renderCodex(2, true);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByTestId('auto-reset-badge')).toBeInTheDocument();
  });

  it('hides the Auto-reset badge when the account has not opted in', async () => {
    renderCodex(2, false);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).queryByTestId('auto-reset-badge')).not.toBeInTheDocument();
  });

  it('does not show a local retry action for a Codex account still blocked by a quota window', () => {
    const now = Date.now();
    renderCodexCooldown(
      [
        {
          key: 'primary',
          usedPercent: 100,
          resetsAtMs: now + 2 * 60 * 60_000,
          windowMinutes: 300,
        },
        {
          key: 'secondary',
          usedPercent: 95,
          resetsAtMs: now + 3 * 86_400_000,
          windowMinutes: 10_080,
        },
      ],
      now + 2 * 60 * 60_000,
    );

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Rate limited')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /retry account/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /reset usage/i })).not.toBeInTheDocument();
  });

  it('shows a local retry action only for a Codex cooldown without an active quota window', async () => {
    resetUsageLimit.mockResolvedValue(undefined);
    const now = Date.now();
    renderCodexCooldown(
      [
        {
          key: 'primary',
          usedPercent: 54,
          resetsAtMs: now + 2 * 60 * 60_000,
          windowMinutes: 300,
        },
        {
          key: 'secondary',
          usedPercent: 42,
          resetsAtMs: now + 3 * 86_400_000,
          windowMinutes: 10_080,
        },
      ],
      now + 60_000,
    );

    const row = screen.getByTestId('provider-account-row');
    const button = within(row).getByRole('button', { name: /retry account/i });
    expect(button).toHaveAttribute('title', 'Clear Helm local cooldown and try this account again');
    expect(within(row).queryByRole('button', { name: /reset usage/i })).not.toBeInTheDocument();

    await fireEvent.click(button);

    await waitFor(() => expect(resetUsageLimit).toHaveBeenCalledWith('openai-codex', 'acct-codex'));
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('confirms before consuming a Codex reset credit, then refreshes on success', async () => {
    consumeCodexResetCredit.mockResolvedValue({
      code: 'reset',
      outcome: 'reset',
      windowsReset: 2,
      redeemRequestId: 'idem-1',
    });
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    // The available reset-credit count renders in the Quota cell AND on the button.
    expect(within(row).getByText('2 reset credits')).toBeInTheDocument();
    expect(within(row).getByText('Plan: Pro')).toBeInTheDocument();
    expect(within(row).getByText('Credits: 9.99')).toBeInTheDocument();
    expect(within(row).getByText('Rate limit reached')).toBeInTheDocument();

    // Clicking the row button only OPENS the confirm dialog — no consume yet (the
    // credit is a scarce, irreversible spend; a single click must never trigger it).
    const resetBtn = within(row).getByRole('button', { name: /reset limit \(2\)/i });
    expect(resetBtn).toBeEnabled();
    await fireEvent.click(resetBtn);
    expect(consumeCodexResetCredit).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Full reset')).toBeInTheDocument();
    // Confirm from WITHIN the dialog (its button reads just "Reset limit").
    await fireEvent.click(within(dialog).getByRole('button', { name: /^reset limit$/i }));

    await waitFor(() =>
      expect(consumeCodexResetCredit).toHaveBeenCalledWith(
        'openai-codex',
        'acct-codex',
        expect.objectContaining({
          creditId: 'credit-1',
          idempotencyKey: expect.any(String),
        }),
      ),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
    expect(setAccountSchedule).toHaveBeenCalledWith('openai-codex', 'acct-codex', {
      autoReset: false,
    });
    // Success banner reflects how many windows were restored.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reset 2 window(s)'));
    // Dialog is dismissed after a successful reset.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not show success or save auto-reset when there is nothing to reset', async () => {
    consumeCodexResetCredit.mockResolvedValue({
      code: 'nothing_to_reset',
      outcome: 'nothingToReset',
      windowsReset: 0,
      redeemRequestId: 'idem-1',
    });
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /reset limit \(2\)/i }));

    const dialog = screen.getByRole('dialog');
    await fireEvent.click(within(dialog).getByTestId('reset-auto-reset-toggle'));
    await fireEvent.click(within(dialog).getByRole('button', { name: /^reset limit$/i }));

    await waitFor(() => expect(consumeCodexResetCredit).toHaveBeenCalled());
    expect(setAccountSchedule).not.toHaveBeenCalled();
    expect(invalidateAllMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No rate-limit window needed resetting');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('refreshes quota after noCredit so stale positive credit is not left on screen', async () => {
    consumeCodexResetCredit.mockResolvedValue({
      code: 'no_credit',
      outcome: 'noCredit',
      windowsReset: 0,
      redeemRequestId: 'idem-1',
    });
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /reset limit \(2\)/i }));

    const dialog = screen.getByRole('dialog');
    await fireEvent.click(within(dialog).getByTestId('reset-auto-reset-toggle'));
    await fireEvent.click(within(dialog).getByRole('button', { name: /^reset limit$/i }));

    await waitFor(() => expect(consumeCodexResetCredit).toHaveBeenCalled());
    expect(setAccountSchedule).not.toHaveBeenCalled();
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No reset credits available');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows an idempotent notice and saves auto-reset for alreadyRedeemed', async () => {
    consumeCodexResetCredit.mockResolvedValue({
      code: 'already_redeemed',
      outcome: 'alreadyRedeemed',
      windowsReset: 0,
      redeemRequestId: 'idem-1',
    });
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /reset limit \(2\)/i }));

    const dialog = screen.getByRole('dialog');
    await fireEvent.click(within(dialog).getByTestId('reset-auto-reset-toggle'));
    await fireEvent.click(within(dialog).getByRole('button', { name: /^reset limit$/i }));

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('openai-codex', 'acct-codex', {
        autoReset: true,
      }),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Reset credit was already redeemed');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders active model-scoped limits and the individual monthly credit limit', () => {
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
              autoReset: false,
              fastMode: false,
              proxy: null,
              models: ['gpt-5.6-luna'],
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
            {
              key: 'codex_luna-primary',
              usedPercent: 88,
              resetsAtMs: Date.now() + 3_600_000,
              windowMinutes: 30,
              limitId: 'codex_luna',
              limitName: 'GPT-5.6-Codex-Luna',
            },
            {
              key: 'codex_spark-primary',
              usedPercent: 99,
              resetsAtMs: Date.now() + 7_200_000,
              windowMinutes: 30,
              limitId: 'codex_spark',
              limitName: 'GPT-5.6-Codex-Spark',
            },
          ],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits: 0,
          individualLimit: {
            limit: '25000',
            used: '8000',
            remainingPercent: 68,
            resetsAtMs: Date.now() + 86_400_000,
          },
        },
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('GPT-5.6-Codex-Luna · 30m')).not.toHaveClass('text-[9px]');
    expect(within(row).queryByText('GPT-5.6-Codex-Spark · 30m')).not.toBeInTheDocument();
    const individualLimit = within(row).getByTestId('codex-individual-limit');
    expect(within(individualLimit).getByText('Monthly credit limit')).toBeInTheDocument();
    expect(within(individualLimit).getByText('8,000 of 25,000 credits used')).toBeInTheDocument();
    expect(within(individualLimit).getByText('32%')).toBeInTheDocument();
  });

  it('renders additional-limit names without fake usage bars when quota windows are absent', () => {
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
              autoReset: false,
              fastMode: false,
              proxy: null,
              models: ['gpt-5.6-terra'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [
        {
          providerId: 'openai-codex',
          account: 'acct-codex',
          windows: [],
          additionalLimits: [
            { limitId: 'codex_spark', limitName: 'GPT-5.6-Codex-Spark' },
            { limitId: 'codex_terra', limitName: 'GPT-5.6-Codex-Terra' },
          ],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits: null,
        },
      ],
    });

    const quotaCell = within(screen.getByTestId('provider-account-row')).getByTestId(
      'provider-quota-cell',
    );
    expect(within(quotaCell).getByText('Additional limits')).toBeInTheDocument();
    expect(within(quotaCell).queryByText('GPT-5.6-Codex-Spark')).not.toBeInTheDocument();
    expect(within(quotaCell).getByText('GPT-5.6-Codex-Terra')).toBeInTheDocument();
    expect(within(quotaCell).queryByText('0%')).not.toBeInTheDocument();
    expect(quotaCell.querySelector('.progress-track')).toBeNull();
    expect(within(quotaCell).queryByText('—')).not.toBeInTheDocument();
  });

  it('does not render the empty quota marker alongside Codex metadata', () => {
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
              autoReset: false,
              fastMode: false,
              proxy: null,
              models: ['gpt-5.6-sol'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [
        {
          providerId: 'openai-codex',
          account: 'acct-codex',
          windows: [],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits: null,
          planType: 'pro',
          credits: { hasCredits: true, unlimited: false, balance: '24524.0366637500' },
          rateLimitReachedType: 'rate_limit_reached',
        },
      ],
    });

    const quotaCell = within(screen.getByTestId('provider-account-row')).getByTestId(
      'provider-quota-cell',
    );
    expect(within(quotaCell).getByText('Plan: Pro')).toBeInTheDocument();
    expect(within(quotaCell).getByText('Credits: 24524.04')).toBeInTheDocument();
    expect(within(quotaCell).getByText('Rate limit reached')).toBeInTheDocument();
    expect(within(quotaCell).queryByText('—')).not.toBeInTheDocument();
  });

  it('hides a zero Codex credit balance', () => {
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
              autoReset: false,
              fastMode: false,
              proxy: null,
              models: ['gpt-5.6-sol'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [
        {
          providerId: 'openai-codex',
          account: 'acct-codex',
          windows: [],
          capturedAt: Date.now(),
          source: 'codex',
          usageLimitedUntilMs: null,
          resetCredits: null,
          planType: 'pro',
          credits: { hasCredits: false, unlimited: false, balance: '0.0000000000' },
        },
      ],
    });

    const quotaCell = within(screen.getByTestId('provider-account-row')).getByTestId(
      'provider-quota-cell',
    );
    expect(within(quotaCell).getByText('Plan: Pro')).toBeInTheDocument();
    expect(within(quotaCell).queryByText(/^Credits:/)).not.toBeInTheDocument();
  });

  it('does NOT consume when the reset confirmation is cancelled', async () => {
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /reset limit \(2\)/i }));

    const dialog = screen.getByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(consumeCodexResetCredit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not persist auto-reset from the reset dialog when the consume fails', async () => {
    consumeCodexResetCredit.mockRejectedValue(new Error('no credits'));
    renderCodex(2);
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /reset limit \(2\)/i }));

    const dialog = screen.getByRole('dialog');
    await fireEvent.click(within(dialog).getByTestId('reset-auto-reset-toggle'));
    await fireEvent.click(within(dialog).getByRole('button', { name: /^reset limit$/i }));

    await waitFor(() => expect(consumeCodexResetCredit).toHaveBeenCalled());
    expect(setAccountSchedule).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('no credits');
  });

  it('disables "Reset limit" for a Codex account with no reset credits', () => {
    renderCodex(0);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByRole('button', { name: /reset limit/i })).toBeDisabled();
    expect(consumeCodexResetCredit).not.toHaveBeenCalled();
  });

  it('disables "Reset limit" until the Codex weekly window reaches 90%', () => {
    renderCodex(2, false, 89);
    const row = screen.getByTestId('provider-account-row');
    const button = within(row).getByRole('button', { name: /reset limit \(2\)/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Weekly usage must reach 90% before reset credits can be used',
    );
    expect(consumeCodexResetCredit).not.toHaveBeenCalled();
  });

  it('disables "Reset limit" when the reached type is a workspace credit or spend limit', () => {
    renderCodex(2, false, 100, 'workspace_member_usage_limit_reached');
    const row = screen.getByTestId('provider-account-row');
    const button = within(row).getByRole('button', { name: /reset limit \(2\)/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'This limit cannot be restored with a Codex reset credit',
    );
  });

  it('does not render "Reset limit" for non-Codex accounts', () => {
    renderPage(); // default anthropic account
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).queryByRole('button', { name: /reset limit/i })).not.toBeInTheDocument();
  });
});
