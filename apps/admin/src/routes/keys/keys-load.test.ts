import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page.js';

const mocks = vi.hoisted(() => ({
  getKeysUsage: vi.fn(),
  listKeys: vi.fn(),
  listLanes: vi.fn(),
}));

vi.mock('$lib/api/keys.js', () => ({
  getKeysUsage: (...args: unknown[]) => mocks.getKeysUsage(...args),
  listKeys: (...args: unknown[]) => mocks.listKeys(...args),
}));

vi.mock('$lib/api/lanes.js', () => ({
  listLanes: (...args: unknown[]) => mocks.listLanes(...args),
}));

describe('keys page loader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getKeysUsage.mockReset().mockResolvedValue([]);
    mocks.listKeys.mockReset().mockResolvedValue([]);
    mocks.listLanes.mockReset().mockResolvedValue([]);
  });

  it('loads the list usage from local midnight today, not a rolling 24h window', async () => {
    const now = new Date('2026-06-01T15:30:00').getTime();
    const localMidnight = new Date('2026-06-01T00:00:00').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await load({ url: new URL('https://admin.test/keys') } as never);

    expect(mocks.getKeysUsage).toHaveBeenCalledWith({ start: localMidnight });
    expect(mocks.getKeysUsage).not.toHaveBeenCalledWith({ start: now - 86_400_000 });
  });
});
