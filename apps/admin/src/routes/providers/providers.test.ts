import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import type {
  OAuthAdminRefreshStatus,
  OAuthOverview,
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
const getAnthropicResetStatus = vi.fn();
const consumeAnthropicReset = vi.fn();
const getOAuthOverview = vi.fn();
const requestOAuthRefresh = vi.fn();
const startManualPaste = vi.fn();
vi.mock('$lib/api/oauth.js', () => ({
  completeManualPaste: vi.fn(),
  getAnthropicResetStatus: (...args: unknown[]) => getAnthropicResetStatus(...args),
  consumeAnthropicReset: (...args: unknown[]) => consumeAnthropicReset(...args),
  consumeCodexResetCredit: (...args: unknown[]) => consumeCodexResetCredit(...args),
  getAccountModels: (...args: unknown[]) => getAccountModels(...args),
  getAccountProxy: (...args: unknown[]) => getAccountProxy(...args),
  getAccountSchedule: (...args: unknown[]) => getAccountSchedule(...args),
  getOAuthOverview: (...args: unknown[]) => getOAuthOverview(...args),
  logoutOAuth: (...args: unknown[]) => logoutOAuth(...args),
  pollDeviceCode: vi.fn(),
  resetUsageLimit: (...args: unknown[]) => resetUsageLimit(...args),
  requestOAuthRefresh: (...args: unknown[]) => requestOAuthRefresh(...args),
  setAccountModels: (...args: unknown[]) => setAccountModels(...args),
  setAccountProxy: vi.fn(),
  setAccountSchedule: (...args: unknown[]) => setAccountSchedule(...args),
  setSelectionStrategy: (...args: unknown[]) => setSelectionStrategy(...args),
  startDeviceCode: vi.fn(),
  startManualPaste: (...args: unknown[]) => startManualPaste(...args),
  streamAccountTest: (...args: unknown[]) => streamAccountTest(...args),
}));

const invalidateAllMock = vi.mocked(invalidateAll);

function provider(overrides: Partial<OAuthProviderStatus> = {}): OAuthProviderStatus {
  return {
    id: 'anthropic',
    name: 'Anthropic (Claude Pro/Max)',
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

const idleRefresh: OAuthAdminRefreshStatus = {
  state: 'idle',
  jobId: null,
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: null,
  nextAllowedAt: null,
  error: null,
};

function renderPage(
  overrides: Partial<{
    configured: boolean;
    selectionStrategy: OAuthSelectionStrategy;
    providers: OAuthProviderStatus[];
    usage: OAuthUsageRow[];
    quota: OAuthQuotaSnapshot[];
    refresh: OAuthAdminRefreshStatus;
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
      refresh: idleRefresh,
      ...overrides,
    },
  });
}

describe('providers page', () => {
  it('hides the upstream usage disclosure when no upstream is configured', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const summary = [...container.querySelectorAll('summary')].find(
      (element) => element.textContent?.trim() === 'Upstream usage',
    );
    expect(summary).not.toBeVisible();
  });
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/admin/api/upstream/provider-usage'))
          return Response.json({ configured: false });
        if (url === '/admin/api/api-key-pools') return Response.json({ pools: [] });
        if (url === '/admin/api/providers')
          return Response.json({ configured: true, providers: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    logoutOAuth.mockReset();
    getAnthropicResetStatus.mockReset();
    consumeAnthropicReset.mockReset();
    getAccountModels.mockReset();
    getAccountProxy.mockReset();
    getAccountSchedule.mockReset();
    setAccountModels.mockReset();
    setAccountSchedule.mockReset();
    setSelectionStrategy.mockReset();
    streamAccountTest.mockReset();
    consumeCodexResetCredit.mockReset();
    getOAuthOverview.mockReset();
    requestOAuthRefresh.mockReset();
    startManualPaste.mockReset();
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
      allowSpendRemainingCredits: false,
      fastMode: false,
    });
    setAccountModels.mockResolvedValue(undefined);
    setAccountSchedule.mockResolvedValue(undefined);
    setSelectionStrategy.mockResolvedValue(undefined);
    getOAuthOverview.mockResolvedValue({
      configured: true,
      selectionStrategy: 'balanced',
      providers: [provider()],
      usage,
      quota,
      refresh: idleRefresh,
    } satisfies OAuthOverview);
    requestOAuthRefresh.mockResolvedValue({
      accepted: true,
      coalesced: false,
      retryAfterMs: 0,
      status: { ...idleRefresh, state: 'queued', jobId: 'refresh-1', requestedAt: Date.now() },
    });
    startManualPaste.mockResolvedValue({
      sessionId: 'reconnect-session',
      authorizeUrl: 'https://auth.example/reconnect',
    });
  });

  it('uses one provider list with an authentication field instead of separate provider sections', async () => {
    renderPage();
    await screen.findByTestId('provider-account-row');
    expect(screen.getByRole('columnheader', { name: /Quota and balance/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Subscription Providers' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Provider connections' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Key providers' })).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('lists shared key pools once and filters keyless connections without duplicating tables', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/admin/api/providers')
          return Response.json({
            configured: true,
            providers: [
              ...['openai', 'responses'].map((id) => ({
                id,
                label: id,
                type: 'openai',
                base_url: 'https://api.example.test/v1',
                models: [],
                poolId: 'shared',
                managed: true,
                legacyCredentialAvailable: false,
              })),
              {
                id: 'home',
                label: 'Home GPU',
                type: 'openai',
                base_url: 'http://192.168.1.2/v1',
                models: [],
                poolId: 'home',
                keyless: true,
                managed: false,
                legacyCredentialAvailable: false,
              },
            ],
          });
        if (url === '/admin/api/api-key-pools')
          return Response.json({
            pools: [
              {
                id: 'shared',
                type: 'openai',
                configured: true,
                timezone: 'UTC',
                strategy: 'round_robin',
                models: ['m'],
                accounts: [],
                usage: [],
              },
            ],
          });
        return original(url, init);
      }),
    );
    renderPage();
    await screen.findByText('Home GPU');
    expect(screen.getAllByTestId('key-provider-row')).toHaveLength(1);
    expect(
      within(screen.getByTestId('key-provider-row')).getByTestId('provider-account-cell')
        .firstElementChild,
    ).toHaveAttribute('title', expect.stringContaining('Shared by 2 connections'));
    expect(screen.getAllByRole('table')).toHaveLength(1);
    await fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'keyless' },
    });
    expect(screen.queryByTestId('provider-account-row')).toBeNull();
    expect(screen.queryByTestId('key-provider-row')).toBeNull();
    expect(screen.getByTestId('unpooled-provider-row')).toHaveTextContent('No key required');
    expect(screen.queryByText('No saved keys')).toBeNull();
  });

  it('requires the explicit Claude confirmation and cannot dismiss by backdrop or Escape', async () => {
    getAnthropicResetStatus.mockResolvedValue({
      eligible: true,
      at_limit: false,
      pending: false,
      next_grant_id: 'launch',
      grants: [
        {
          id: 'launch',
          label: 'Launch reset',
          resets_total: 1,
          resets_left: 1,
          ends_at: new Date(Date.now() + 86_400_000).toISOString(),
          clears: ['five_hour', 'seven_day'],
          paused: false,
          usable_now: true,
          use_requires_limit: false,
          blocking: [],
        },
      ],
    });
    consumeAnthropicReset.mockResolvedValue({
      result: 'reset',
      status: null,
      quotaRefreshed: true,
    });
    renderPage();
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(await within(row).findByRole('button', { name: /Reset weekly limit/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Reset weekly limit' });
    expect(consumeAnthropicReset).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/1 resets remaining/)).toBeInTheDocument();
    expect(screen.queryByTestId('modal-scrim')).not.toBeInTheDocument();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Confirm Reset weekly limit' })).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(consumeAnthropicReset).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const resetButton = await within(row).findByRole('button', { name: /Reset weekly limit/ });
    expect(within(resetButton).getByTestId('anthropic-reset-meta')).toHaveTextContent(
      '1 resets remaining',
    );
    await fireEvent.click(resetButton);
    const confirmation = await screen.findByRole('dialog', { name: 'Confirm Reset weekly limit' });
    await fireEvent.click(within(confirmation).getByRole('button', { name: 'Reset weekly limit' }));
    await waitFor(() => expect(consumeAnthropicReset).toHaveBeenCalledTimes(1));
  });

  it('accepts refreshed route data without entering a reactive update loop', async () => {
    const view = renderPage();

    await view.rerender({
      data: {
        configured: true,
        selectionStrategy: 'balanced',
        providers: [provider()],
        usage: [{ ...usage[0], requests: 43 }],
        quota,
        refresh: idleRefresh,
      },
    });

    expect(screen.getByTestId('provider-calls-cell')).toHaveTextContent('43');
  });

  it('labels the Grok subscription provider as experimental', () => {
    renderPage({
      providers: [
        provider({
          id: 'xai',
          name: 'xAI (SuperGrok/X Premium) · Experimental',
          flow: 'device_code',
          accounts: [
            {
              account: 'heavy',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null,
              models: ['grok-composer-2.5-fast'],
            },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });
    expect(screen.getByText('Subscription · Experimental')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Enterprise domain (optional)')).not.toBeInTheDocument();
  });

  it('renders connected subscription accounts with usage, quota, and scheduling controls', () => {
    renderPage();

    expect(screen.getByLabelText('Account usage strategy')).toHaveValue('balanced');
    expect(
      screen.getByTitle('Spread new sessions across accounts while keeping sessions sticky.'),
    ).toBeInTheDocument();
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByText('Anthropic (Claude Pro/Max)')).toBeInTheDocument();
    expect(within(row).getByTestId('provider-type-cell')).toHaveTextContent(/^\s*Subscription\s*$/);
    expect(within(row).getByText('acct-claude')).toBeInTheDocument();
    expect(within(row).getByTestId('provider-status-cell')).toHaveTextContent('Normal');
    expect(within(row).getByTestId('provider-calls-cell')).toHaveTextContent('42');
    expect(within(row).getByTestId('provider-calls-cell')).toHaveAttribute(
      'title',
      '0.7 per minute',
    );
    expect(within(row).getByTestId('provider-used-cell')).toHaveTextContent('1.5K');
    expect(within(row).getByTestId('provider-used-cell')).toHaveTextContent('$0.034');
    expect(within(row).getByText('26% left')).toBeInTheDocument();
    // Every adjustable setting is edited right in the list.
    expect(within(row).getByRole('spinbutton', { name: 'Priority' })).toHaveValue(10);
    expect(within(row).getByRole('switch', { name: 'Schedulable' })).toBeChecked();
    expect(within(row).getByRole('button', { name: 'Fast mode' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(row).getByRole('button', { name: 'Use credits when limited' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Connection: proxy shown as a short label; the redacted address is in the tooltip.
    const connection = within(row).getByTestId('provider-connection-cell');
    // Hovering the small icon shows its tooltip at once (no native title delay).
    fireEvent.mouseEnter(within(connection).getByText('Proxy'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Via proxy: socks5://10.0.0.1:1080 · ••••',
    );
    fireEvent.mouseLeave(within(connection).getByText('Proxy'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(within(row).getByRole('button', { name: 'Fast mode' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Off');
    // Models live in the account tooltip instead of taking a column.
    expect(within(row).getByText('acct-claude')).toHaveAttribute(
      'title',
      expect.stringContaining('claude-haiku-4-5'),
    );
  });

  it('shows each Claude account authoritative plan independently', () => {
    const base = provider();
    renderPage({
      providers: [
        provider({
          accounts: [
            { ...base.accounts[0], account: 'pro-account', anthropicPlanType: 'pro' },
            { ...base.accounts[0], account: 'max-account', anthropicPlanType: 'max' },
            { ...base.accounts[0], account: 'unknown-account', anthropicPlanType: null },
          ],
        }),
      ],
    });
    const rows = screen.getAllByTestId('provider-account-row');
    const typeOf = (accountName: string) =>
      within(rows.find((r) => within(r).queryByText(accountName)) as HTMLElement).getByTestId(
        'provider-type-cell',
      );
    expect(typeOf('pro-account')).toHaveTextContent('Subscription · Pro');
    expect(typeOf('max-account')).toHaveTextContent('Subscription · Max');
    expect(typeOf('unknown-account')).toHaveTextContent(/^\s*Subscription\s*$/);
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
    const title = within(row).getByText('acct-codex').getAttribute('title') ?? '';
    expect(title).toContain('lukin@example.com');
    expect(title).toContain('Plan: Plus');
    expect(title).toContain('ChatGPT ID: chatgpt-account-123');
    expect(title).toContain('FedRAMP');
    expect(within(row).getByTestId('provider-type-cell')).toHaveTextContent('Subscription · Plus');
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
    expect(within(row).getByTestId('provider-type-cell')).toHaveTextContent('Subscription · Plus');
    expect(within(row).getByText('acct-codex')).toHaveAttribute(
      'title',
      expect.stringContaining('Plan: Plus'),
    );
  });

  it('labels Codex quota windows by their real duration across plan shapes', () => {
    const capturedAt = Date.now();
    renderPage({
      providers: [
        provider({
          id: 'openai-codex',
          name: 'Codex',
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
          windows: [
            {
              // Some live plans now expose their weekly allowance as `primary`.
              key: 'primary',
              usedPercent: 7,
              resetsAtMs: Date.now() + 6 * 86_400_000,
              windowMinutes: 10_080,
            },
            {
              // Live headers emit this already-expired zero-usage placeholder.
              key: 'secondary',
              usedPercent: 0,
              resetsAtMs: capturedAt,
              windowMinutes: null,
            },
          ],
          capturedAt,
          source: 'codex-headers',
          usageLimitedUntilMs: null,
          resetCredits: 2,
          planType: 'pro',
        },
      ],
    });

    const quotaCell = within(screen.getByTestId('provider-account-row')).getByTestId(
      'provider-quota-cell',
    );
    expect(within(quotaCell).getByText('Weekly')).toBeInTheDocument();
    expect(within(quotaCell).queryByText('Secondary')).not.toBeInTheDocument();
    expect(within(quotaCell).queryByText('5h')).not.toBeInTheDocument();
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

    const title =
      within(screen.getByTestId('provider-account-row'))
        .getByText('acct-codex')
        .getAttribute('title') ?? '';
    expect(title).not.toContain('ChatGPT ID');
    expect(title).not.toContain('FedRAMP');
  });

  it('adds and saves a custom model id in manual mode', async () => {
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

    await fireEvent.input(within(dialog).getByPlaceholderText('Add a model id…'), {
      target: { value: 'gpt-6-astra' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: /^add$/i }));

    await fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(setAccountModels).toHaveBeenCalledWith('openai-codex', 'acct-codex', {
        mode: 'manual',
        models: ['gpt-5.6-sol', 'gpt-6-astra'],
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
    await waitFor(() => expect(requestOAuthRefresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(getOAuthOverview).toHaveBeenCalledOnce());
    expect(invalidateAllMock).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    expect(screen.getByTestId('refresh-menu')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-interval-10')).toHaveTextContent('10s');
  });

  it('automatically requests one upstream refresh when the cached quota is one hour old', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 25, 15, 0);
      vi.setSystemTime(now);
      renderPage({
        quota: [
          {
            ...quota[0]!,
            capturedAt: now - 60 * 60_000,
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(requestOAuthRefresh).toHaveBeenCalledOnce();
      expect(getOAuthOverview).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a missing quota snapshot for a quota provider as stale', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 7, 25, 15, 0));
      renderPage({ quota: [] });

      await vi.advanceTimersByTimeAsync(0);

      expect(requestOAuthRefresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a stale background tab to become visible before refreshing upstream', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const now = Date.UTC(2026, 7, 25, 15, 0);
      vi.setSystemTime(now);
      renderPage({
        quota: [
          {
            ...quota[0]!,
            capturedAt: now - 60 * 60_000,
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(requestOAuthRefresh).not.toHaveBeenCalled();

      visibility.mockReturnValue('visible');
      await fireEvent(document, new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(requestOAuthRefresh).toHaveBeenCalledOnce();
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a fresh quota cache until its one-hour freshness window expires', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 25, 15, 0);
      vi.setSystemTime(now);
      renderPage({
        quota: [
          {
            ...quota[0]!,
            capturedAt: now,
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
      expect(requestOAuthRefresh).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(requestOAuthRefresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the latest cached data after the queued refresh completes', async () => {
    const refreshedAt = Date.now();
    getOAuthOverview.mockResolvedValue({
      configured: true,
      selectionStrategy: 'balanced',
      providers: [provider()],
      usage: [{ ...usage[0]!, requests: 99 }],
      quota,
      refresh: {
        ...idleRefresh,
        state: 'succeeded',
        jobId: 'refresh-1',
        requestedAt: refreshedAt - 100,
        startedAt: refreshedAt - 80,
        finishedAt: refreshedAt,
        lastSuccessAt: refreshedAt,
        nextAllowedAt: refreshedAt + 90_000,
      },
    } satisfies OAuthOverview);
    renderPage();

    await fireEvent.click(screen.getByTestId('refresh-now'));

    await waitFor(() => expect(screen.getByTestId('provider-calls-cell')).toHaveTextContent('99'));
    expect(screen.getByTestId('provider-refresh-status')).toHaveTextContent(
      'refresh available again in 1.5min',
    );
  });

  it('does not enqueue a second automatic refresh after a manual refresh of stale data', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 25, 15, 0);
      vi.setSystemTime(now);
      renderPage({
        quota: [
          {
            ...quota[0]!,
            capturedAt: now - 60 * 60_000,
          },
        ],
      });

      await fireEvent.click(screen.getByTestId('refresh-now'));
      await vi.advanceTimersByTimeAsync(0);

      expect(requestOAuthRefresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps timer-driven auto refresh cache-only', async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-5'));
      await vi.advanceTimersByTimeAsync(5000);

      expect(getOAuthOverview).toHaveBeenCalledOnce();
      expect(requestOAuthRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    const quotaCell = within(row).getByTestId('provider-quota-cell');
    expect(within(quotaCell).getByText('7d · Fable')).toBeInTheDocument();
    expect(within(quotaCell).getByText('95% left')).toBeInTheDocument();
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
    expect(within(row).getAllByText('0% left')).toHaveLength(2);
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
    expect(within(row).getByText('2% left')).toBeInTheDocument();
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

  it('shows the same columns for every account and tucks rare actions into a row menu', () => {
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
              proxy: null,
              models: ['m1'],
            },
          ],
        }),
      ],
    });
    expect(
      screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/[↑↓]/g, '').trim()),
    ).toEqual([
      'Account',
      'Quota and balance',
      'Usage',
      'Priority',
      'Enabled',
      'Options',
      'Actions',
    ]);
    const row = screen.getByTestId('provider-account-row');
    // Status and connection sit under the account, not in their own columns.
    const accountCell = within(row).getByTestId('provider-account-cell');
    expect(within(accountCell).getByTestId('provider-status-cell')).toHaveTextContent('Normal');
    expect(within(accountCell).getByTestId('provider-connection-cell')).toHaveTextContent('Direct');
    expect(within(row).getByRole('button', { name: 'Test' })).toBeVisible();
    const menu = within(row).getByTestId('provider-actions');
    expect(menu.tagName).toBe('DETAILS');
    expect(within(menu).getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('renders "Direct" and keeps the model list in the account tooltip', () => {
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
    expect(within(row).queryByText('m4')).not.toBeInTheDocument();
    expect(within(row).getByText('acct-copilot')).toHaveAttribute(
      'title',
      expect.stringContaining('m1, m2, m3, m4, m5'),
    );
  });

  it('shows the OAuth warning without hiding the unified add-provider entry', () => {
    renderPage({ configured: false, providers: [], usage: [], quota: [] });

    expect(screen.getByText(/OAuth login is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeEnabled();
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
    const checkbox = within(screen.getByTestId('provider-account-row')).getByRole('switch', {
      name: 'Schedulable',
    });

    await fireEvent.click(checkbox);

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('anthropic', 'acct-claude', {
        schedulable: false,
      }),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('toggles per-account Fast mode through the scheduling endpoint', async () => {
    renderPage();
    const checkbox = within(screen.getByTestId('provider-account-row')).getByRole('button', {
      name: 'Fast mode',
    });

    await fireEvent.click(checkbox);

    await waitFor(() =>
      expect(setAccountSchedule).toHaveBeenCalledWith('anthropic', 'acct-claude', {
        fastMode: true,
      }),
    );
    expect(invalidateAllMock).toHaveBeenCalledTimes(1);
  });

  it('marks credential-failed accounts as needing sign-in', async () => {
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
    expect(within(row).getByTestId('provider-status-cell')).toHaveTextContent('Needs sign-in');
    expect(within(row).getByRole('switch', { name: 'Schedulable' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: /^reconnect$/i })).toBeInTheDocument();
    expect(setAccountSchedule).not.toHaveBeenCalled();
  });

  it('offers reconnect for unhealthy accounts and starts that account flow', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage({
      providers: [
        provider({
          accounts: [
            {
              account: 'acct-claude',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: false,
              priority: 10,
              schedulable: false,
              proxy: null,
              models: ['claude-opus-4-6'],
            },
          ],
        }),
      ],
    });

    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByRole('button', { name: /^reconnect$/i }));

    await waitFor(() =>
      expect(startManualPaste).toHaveBeenCalledWith('anthropic', undefined, 'acct-claude'),
    );
    expect(screen.getByRole('heading', { name: 'Reconnect subscription' })).toBeInTheDocument();
  });

  it('opens the Test dialog seeded with the account’s routable models', async () => {
    renderPage();
    const row = screen.getByTestId('provider-account-row');

    await fireEvent.click(within(row).getByRole('button', { name: /^test$/i }));

    const dialog = screen.getByRole('dialog', { name: /test connection/i });
    expect(within(dialog).getByText('acct-claude')).toBeInTheDocument();
    // The picker offers the row's effective models; the first is selected by default.
    expect(within(dialog).getByRole('combobox', { name: /^model$/i })).toHaveValue(
      'claude-opus-4-6',
    );
    expect(dialog.querySelector('option[value="claude-opus-4-6"]')).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: /run test/i })).toBeInTheDocument();
  });

  it('keeps Grok media aliases out of the chat connectivity test', async () => {
    renderPage({
      providers: [
        provider({
          id: 'xai',
          accounts: [
            {
              account: 'media',
              expiresAt: null,
              updatedAt: Date.now(),
              healthy: true,
              priority: 50,
              schedulable: true,
              proxy: null,
              models: [
                'grok-4.5',
                'grok-imagine-image',
                'grok-imagine-image-quality',
                'grok-imagine-video-1.5-preview',
                'grok-imagine-video',
              ],
            },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });

    await fireEvent.click(
      within(screen.getByTestId('provider-account-row')).getByRole('button', { name: /^test$/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /test connection/i });
    expect(dialog.querySelector('option[value="grok-4.5"]')).not.toBeNull();
    expect(dialog.querySelector('option[value="grok-imagine-image"]')).toBeNull();
    expect(dialog.querySelector('option[value="grok-imagine-image-quality"]')).toBeNull();
    expect(dialog.querySelector('option[value="grok-imagine-video-1.5-preview"]')).toBeNull();
    expect(dialog.querySelector('option[value="grok-imagine-video"]')).toBeNull();
  });

  it('streams the test reply through the gateway and reports success', async () => {
    streamAccountTest.mockImplementation(async function* () {
      yield { type: 'content', text: 'Hello' };
      yield { type: 'content', text: ' there' };
      yield { type: 'done', durationMs: 1200 };
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
    expect(within(dialog).getByText('Done in 1.2s')).toBeInTheDocument();

    await fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(screen.queryByRole('dialog', { name: /test connection/i })).not.toBeInTheDocument();
  });

  it('tests a custom model id without adding it to the account allowlist', async () => {
    streamAccountTest.mockImplementation(async function* () {
      yield { type: 'done', durationMs: 100 };
    });
    renderPage();
    await fireEvent.click(
      within(screen.getByTestId('provider-account-row')).getByRole('button', { name: /^test$/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /test connection/i });

    await fireEvent.input(within(dialog).getByRole('combobox', { name: /^model$/i }), {
      target: { value: 'gpt-6-astra' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: /run test/i }));

    await waitFor(() =>
      expect(streamAccountTest).toHaveBeenCalledWith(
        'anthropic',
        { account: 'acct-claude', model: 'gpt-6-astra', prompt: undefined },
        expect.any(AbortSignal),
      ),
    );
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

  it('shows the Auto-reset switch on when the account opted in', async () => {
    renderCodex(2, true);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByRole('button', { name: 'Auto-reset' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('recognizes a duration-backed primary window as the Codex weekly allowance', async () => {
    renderCodexCooldown(
      [
        {
          key: 'primary',
          usedPercent: 95,
          resetsAtMs: Date.now() + 3 * 86_400_000,
          windowMinutes: 10_080,
        },
      ],
      Date.now() + 60_000,
    );

    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByRole('button', { name: /reset limit \(2\)/i })).toBeEnabled();
  });

  it('shows the Auto-reset switch off when the account has not opted in', async () => {
    renderCodex(2, false);
    const row = screen.getByTestId('provider-account-row');
    expect(within(row).getByRole('button', { name: 'Auto-reset' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
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
    // Every balance fact is shown in the list: credits, reset credits, reached limit.
    const quotaCell = within(row).getByTestId('provider-quota-cell');
    expect(quotaCell).toHaveTextContent(/Reset credits\s*2/);
    expect(quotaCell).toHaveTextContent(/Credits\s*9\.99/);
    expect(quotaCell).toHaveTextContent('Rate limit reached');
    expect(within(row).getByTestId('provider-type-cell')).toHaveTextContent('Subscription · Pro');

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

  it('shows reset success and saves auto-reset for alreadyRedeemed', async () => {
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
    expect(screen.getByRole('status')).toHaveTextContent('Reset completed successfully');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    const quotaCell = within(row).getByTestId('provider-quota-cell');
    expect(within(quotaCell).getByText('GPT-5.6-Codex-Luna · 30m')).toBeInTheDocument();
    expect(quotaCell).not.toHaveTextContent('GPT-5.6-Codex-Spark');
    expect(within(row).getByTestId('codex-individual-limit')).toHaveTextContent(
      '8,000 of 25,000 credits used',
    );
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
    expect(quotaCell).toHaveTextContent(/Additional limits\s*GPT-5.6-Codex-Terra/);
    expect(quotaCell).not.toHaveTextContent('GPT-5.6-Codex-Spark');
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
    expect(quotaCell).toHaveTextContent(/Credits\s*24524\.04/);
    expect(quotaCell).toHaveTextContent('Rate limit reached');
    expect(within(quotaCell).queryByText('—')).not.toBeInTheDocument();
  });

  it('shows a zero Codex credit balance', () => {
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
    // A zero balance is still a balance: show it rather than hide it.
    expect(quotaCell).toHaveTextContent(/Credits\s*0\.00/);
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

  it('opens the account detail when any part of a subscription row is clicked', async () => {
    const { goto } = await import('$app/navigation');
    renderPage();
    const row = screen.getByTestId('provider-account-row');
    await fireEvent.click(within(row).getByTestId('provider-calls-cell'));
    expect(vi.mocked(goto)).toHaveBeenCalledWith(expect.stringContaining('/providers/'));
    vi.mocked(goto).mockClear();
    // Its own controls keep their own behaviour.
    await fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    expect(vi.mocked(goto)).not.toHaveBeenCalled();
  });

  it('keeps search, type filter and sort in the URL without reloading the page', async () => {
    const { replaceState } = await import('$app/navigation');
    renderPage();
    await fireEvent.input(screen.getByLabelText('Search providers'), {
      target: { value: 'claude' },
    });
    expect(vi.mocked(replaceState)).toHaveBeenLastCalledWith('?q=claude', {});
    await fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'subscription' },
    });
    expect(vi.mocked(replaceState)).toHaveBeenLastCalledWith('?q=claude&type=subscription', {});
    await fireEvent.click(screen.getByRole('button', { name: 'Sort by Usage' }));
    expect(vi.mocked(replaceState)).toHaveBeenLastCalledWith(
      '?q=claude&type=subscription&sort=used&dir=desc',
      {},
    );
    expect(invalidateAllMock).not.toHaveBeenCalled();
  });

  it('lists subscription accounts in priority order with the lowest number first', () => {
    const base = provider();
    renderPage({
      providers: [
        provider({
          accounts: [
            { ...base.accounts[0], account: 'later', priority: 30 },
            { ...base.accounts[0], account: 'first', priority: 5 },
          ],
        }),
      ],
      usage: [],
      quota: [],
    });
    const names = screen
      .getAllByTestId('provider-account-row')
      .map(
        (row) => within(row).getByTestId('provider-account-cell').querySelector('a')?.textContent,
      );
    expect(names).toEqual(['first', 'later']);
  });

  it('edits API key priority and pause straight from the list', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') {
          calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
          return Response.json({});
        }
        if (url === '/admin/api/api-key-pools')
          return Response.json({
            pools: [
              {
                id: 'openai',
                type: 'openai',
                configured: true,
                timezone: 'UTC',
                strategy: 'round_robin',
                models: ['m'],
                accounts: [
                  {
                    id: 'k1',
                    name: 'Key one',
                    mask: '••••1234',
                    enabled: true,
                    priority: 50,
                    models: null,
                    state: 'ready',
                    reason: null,
                    nextRetryAt: null,
                    probeUntil: null,
                    deniedModels: [],
                  },
                ],
                usage: [],
              },
            ],
          });
        return original(url, init);
      }),
    );
    renderPage();
    const row = await screen.findByTestId('key-provider-row');
    const priority = within(row).getByRole('spinbutton', { name: 'Priority' });
    await fireEvent.change(priority, { target: { value: '1001' } });
    expect(screen.getByRole('alert')).toHaveTextContent('from 0 to 1000');
    expect(calls).toHaveLength(0);
    await fireEvent.change(priority, { target: { value: '7' } });
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/admin/api/api-key-pools/openai/accounts/k1',
        method: 'PATCH',
        body: { priority: 7 },
      }),
    );
    await fireEvent.click(within(row).getByRole('switch', { name: 'Schedulable' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/admin/api/api-key-pools/openai/accounts/k1',
        method: 'PATCH',
        body: { enabled: false },
      }),
    );
  });

  it('lists accounts grouped by vendor with a label row per group', () => {
    const claude = provider();
    renderPage({
      providers: [
        provider({
          id: 'openai-codex',
          name: 'ChatGPT Plus/Pro (Codex)',
          accounts: [{ ...claude.accounts[0], account: 'codex-1' }],
        }),
        claude,
      ],
      usage: [],
      quota: [],
    });
    const groups = screen.getAllByTestId('provider-family-row').map((r) => r.textContent ?? '');
    expect(groups[0]).toContain('Claude');
    expect(groups[1]).toContain('OpenAI');
    const names = screen
      .getAllByTestId('provider-account-row')
      .map((r) => within(r).getByTestId('provider-account-cell').querySelector('a')?.textContent);
    expect(names).toEqual(['acct-claude', 'codex-1']);
  });

  it('labels a Fable-only Claude reset as such and counts every available grant', async () => {
    const fable = (id: string) => ({
      id,
      label: 'Fable reset',
      resets_total: 1,
      resets_left: 1,
      ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      clears: ['seven_day_overage_included'],
      paused: false,
      usable_now: true,
      use_requires_limit: false,
      blocking: [],
    });
    getAnthropicResetStatus.mockResolvedValue({
      eligible: true,
      at_limit: false,
      pending: false,
      next_grant_id: 'fable-a',
      grants: [fable('fable-a'), fable('fable-b')],
    });
    renderPage();
    const row = screen.getByTestId('provider-account-row');
    const action = await within(row).findByRole('button', { name: /Reset Fable allowance/ });
    expect(within(action).getByTestId('anthropic-reset-meta')).toHaveTextContent(
      '2 resets remaining',
    );
    await waitFor(() =>
      expect(within(row).getByTestId('provider-quota-cell')).toHaveTextContent(/Fable resets\s*2/),
    );
    await fireEvent.click(action);
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Reset Fable allowance' });
    expect(within(dialog).getByTestId('anthropic-reset-effect')).toHaveTextContent(
      'It does not reset the whole week.',
    );
  });
});
