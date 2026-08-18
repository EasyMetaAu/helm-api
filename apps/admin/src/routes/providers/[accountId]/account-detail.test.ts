import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => invalidateAllMock.mockReset());

  it('includes the live current period in the period history', () => {
    render(AccountDetailPage, { data });

    const table = screen.getByRole('table');
    expect(within(table).getByText('Current period')).toBeInTheDocument();
    expect(within(table).getByText('383M')).toBeInTheDocument();
    expect(within(table).getByText('3.6K')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('can reload the cache-only period aggregate from the shared refresh control', async () => {
    render(AccountDetailPage, { data });

    await fireEvent.click(screen.getByTestId('refresh-now'));

    expect(invalidateAllMock).toHaveBeenCalledOnce();
  });
});
