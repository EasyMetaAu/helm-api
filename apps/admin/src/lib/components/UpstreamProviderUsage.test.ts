import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpstreamProviderUsage from './UpstreamProviderUsage.svelte';

const response = {
  configured: true,
  source: 'https://helm.example',
  snapshot: {
    schemaVersion: 1,
    generatedAt: Date.now(),
    providers: [
      {
        id: 'anthropic',
        name: 'Claude upstream',
        accounts: [
          { account: 'remote-account', healthy: true, schedulable: true, anthropicPlanType: 'max' },
        ],
      },
    ],
    usage: [
      {
        providerId: 'anthropic',
        account: 'remote-account',
        requests: 42,
        tokens: 1536,
        costUsd: null,
        rpm: 0.7,
      },
    ],
    quota: [
      {
        providerId: 'anthropic',
        account: 'remote-account',
        capturedAt: Date.now(),
        source: 'anthropic',
        usageLimitedUntilMs: null,
        windows: [
          { key: '5h', usedPercent: 74, resetsAtMs: Date.now() + 3600000, windowMinutes: 300 },
        ],
      },
    ],
    apiKeyPools: [],
  },
};

describe('upstream provider usage', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows upstream source, quota, scoped history link and no account mutations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    vi.stubGlobal('fetch', fetcher);
    render(UpstreamProviderUsage);
    await screen.findByText('Claude upstream');
    expect(screen.getByText('https://helm.example')).toBeInTheDocument();
    expect(screen.getByText('74%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /remote-account/ })).toHaveAttribute(
      'href',
      expect.stringContaining('source=upstream'),
    );
    expect(
      screen.queryByRole('button', { name: /reset|disconnect|test|manage/i }),
    ).not.toBeInTheDocument();
    expect(
      fetcher.mock.calls.every(
        (call) => call.length === 1 || !Reflect.get(call[1] ?? {}, 'method'),
      ),
    ).toBe(true);
  });
  it('keeps different subscription providers in one table with the original column order', async () => {
    const fixture = structuredClone(response);
    fixture.snapshot.providers.push({
      id: 'other',
      name: 'Other upstream',
      accounts: [
        { account: 'other-account', healthy: false, schedulable: false, anthropicPlanType: 'max' },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(fixture)),
    );
    const { container } = render(UpstreamProviderUsage);
    await screen.findByText('other-account');
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(
      screen
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim())
        .slice(0, 3),
    ).toEqual(['Provider', 'Today', 'Quota']);
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('needs reconnect')).toBeInTheDocument();
    expect(screen.getByText('parked')).toBeInTheDocument();
    expect(container.querySelector('.cards-table-frame.compact')).toBeNull();
  });

  it('shows exhausted quota in danger colors with a readable weekly reset', async () => {
    const fixture = structuredClone(response);
    fixture.snapshot.quota[0].windows = [
      {
        key: 'primary',
        usedPercent: 100,
        resetsAtMs: Date.now() + 5 * 86400000 + 4 * 3600000 + 1800000,
        windowMinutes: 10080,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(fixture)),
    );
    const { container } = render(UpstreamProviderUsage);
    await screen.findByText('100%');
    expect(screen.getAllByText('Weekly')[0]).toBeVisible();
    expect(screen.getByText(/resets in 5d 4h/)).toBeInTheDocument();
    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '100');
    expect(progress).toHaveAccessibleName(/Used/i);
    expect(container.querySelector('.progress-bar.bg-red-500')).toBeInTheDocument();
    expect(container.querySelector('progress')).toBeNull();
  });

  it('keeps the last successful snapshot and shows failure instead of zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(response))
        .mockRejectedValue(new Error('offline')),
    );
    render(UpstreamProviderUsage);
    await screen.findByText('Claude upstream');
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh upstream usage' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('unavailable'));
    expect(screen.getByText('74%')).toBeInTheDocument();
  });
  it('hides the view when upstream usage is not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ configured: false })),
    );
    const { container } = render(UpstreamProviderUsage);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(container.querySelector('section')).toBeNull();
  });
});
