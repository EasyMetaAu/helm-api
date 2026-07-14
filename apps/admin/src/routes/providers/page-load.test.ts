import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOAuthOverview } from '$lib/api/oauth.js';
import { load } from './+page.js';

vi.mock('$lib/api/oauth.js', () => ({
  getOAuthOverview: vi.fn(),
}));

const getOAuthOverviewMock = vi.mocked(getOAuthOverview);

describe('providers page load', () => {
  beforeEach(() => {
    getOAuthOverviewMock.mockReset();
  });

  it('loads one cache-only overview instead of three blocking requests', async () => {
    getOAuthOverviewMock.mockResolvedValue({
      configured: true,
      selectionStrategy: 'balanced',
      providers: [],
      usage: [],
      quota: [],
      refresh: {
        state: 'idle',
        jobId: null,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        lastSuccessAt: null,
        nextAllowedAt: null,
        error: null,
      },
    });

    await expect(load({} as Parameters<typeof load>[0])).resolves.toMatchObject({
      configured: true,
      refresh: { state: 'idle' },
    });
    expect(getOAuthOverviewMock).toHaveBeenCalledOnce();
  });

  it('returns a renderable cached-page fallback when the overview request fails', async () => {
    getOAuthOverviewMock.mockRejectedValue(new Error('gateway unavailable'));

    await expect(load({} as Parameters<typeof load>[0])).resolves.toMatchObject({
      configured: false,
      providers: [],
      usage: [],
      quota: [],
      refresh: { state: 'idle' },
      loadError: 'gateway unavailable',
    });
  });
});
