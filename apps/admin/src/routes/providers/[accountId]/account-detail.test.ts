import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAll } from '$app/navigation';
import type { AccountDetailData } from './+page.js';
import AccountDetailPage from './+page.svelte';

const invalidateAllMock = vi.mocked(invalidateAll);

const data: AccountDetailData = {
  providerId: 'openai-codex',
  account: 'account@example.com',
  periods: {
    current: [
      {
        windowKey: 'primary',
        periodStartMs: Date.UTC(2026, 7, 13, 4, 44, 41),
        periodEndMs: Date.UTC(2026, 7, 18, 14, 0),
        requests: 3_600,
        tokens: 383_000_000,
        costUsd: 369.37,
        usedPercent: 80,
        approximate: false,
        partial: false,
      },
    ],
    periods: [
      {
        windowKey: 'primary',
        periodStartMs: Date.UTC(2026, 7, 13, 3, 32, 4),
        periodEndMs: Date.UTC(2026, 7, 13, 4, 44, 41),
        requests: 0,
        tokens: 0,
        costUsd: null,
        usedPercent: null,
        approximate: false,
        partial: false,
      },
    ],
    daily: [],
    weekly: [],
  },
  quota: {
    providerId: 'openai-codex',
    account: 'account@example.com',
    windows: [
      {
        key: 'primary',
        usedPercent: 80,
        resetsAtMs: Date.UTC(2026, 7, 20, 4, 44, 41),
        windowMinutes: 10_080,
      },
    ],
    capturedAt: Date.UTC(2026, 7, 18, 14, 0),
    source: 'codex',
    usageLimitedUntilMs: null,
  },
};

describe('provider account detail', () => {
  beforeEach(() => {
    invalidateAllMock.mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 18, 14, 0));
  });

  afterEach(() => vi.restoreAllMocks());

  it('hides the window switcher when the account has a single reset window', () => {
    render(AccountDetailPage, { data });
    expect(screen.queryByRole('tablist', { name: 'Reset window' })).toBeNull();
  });

  it('shows the window switcher when there are several reset windows', () => {
    const second = { ...data.periods.current[0], windowKey: 'secondary' };
    render(AccountDetailPage, {
      data: {
        ...data,
        providerId: 'anthropic',
        periods: { ...data.periods, current: [...data.periods.current, second] },
      },
    });
    const tabs = screen.getByRole('tablist', { name: 'Reset window' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
  });

  it.each(['primary', 'secondary'])(
    'shows only the weekly Codex window when it is %s',
    async (weeklyKey) => {
      const shortKey = weeklyKey === 'primary' ? 'secondary' : 'primary';
      const now = Date.now();
      const weekly = { ...data.periods.current[0], windowKey: weeklyKey };
      const short = { ...weekly, windowKey: shortKey, tokens: 8_200_000, usedPercent: 100 };
      render(AccountDetailPage, {
        data: {
          ...data,
          periods: {
            ...data.periods,
            current: [short, weekly],
            periods: [
              { ...short, periodStartMs: short.periodStartMs - 5 * 3_600_000, tokens: 5_500_000 },
              { ...data.periods.periods[0], windowKey: weeklyKey },
            ],
            daily: [{ ...weekly, windowKey: 'day', tokens: 42_000 }],
          },
          quota: {
            ...data.quota!,
            windows: [
              {
                key: shortKey,
                windowMinutes: 300,
                resetsAtMs: now + 2 * 3_600_000,
                usedPercent: 100,
              },
              {
                key: weeklyKey,
                windowMinutes: 10_080,
                resetsAtMs: now + 3 * 86_400_000,
                usedPercent: 80,
              },
            ],
          },
        },
      });

      expect(screen.queryByRole('tablist', { name: 'Reset window' })).toBeNull();
      expect(screen.getByText('resets in 3d')).toBeInTheDocument();
      const table = screen.getByRole('table');
      expect(within(table).getByText('383M')).toBeInTheDocument();
      expect(within(table).getByText('80%')).toBeInTheDocument();
      expect(within(table).getAllByRole('row')).toHaveLength(3);
      expect(screen.queryByText('8.2M')).toBeNull();
      expect(screen.queryByText('5.5M')).toBeNull();
      expect(screen.queryByText('100%')).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      expect(within(table).getByText('42K')).toBeInTheDocument();
    },
  );

  it('includes the live current period in the period history', () => {
    render(AccountDetailPage, { data });

    const table = screen.getByRole('table');
    expect(within(table).getByText('Current period')).toBeInTheDocument();
    expect(within(table).getByText('383M')).toBeInTheDocument();
    expect(within(table).getByText('3.6K')).toBeInTheDocument();
    expect(within(table).getByText('80%')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('can reload the cache-only period aggregate from the shared refresh control', async () => {
    render(AccountDetailPage, { data });

    await fireEvent.click(screen.getByTestId('refresh-now'));

    expect(invalidateAllMock).toHaveBeenCalledOnce();
  });
});
