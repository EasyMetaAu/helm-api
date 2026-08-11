import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMemoryStats: vi.fn(),
  listScopes: vi.fn(),
  listKeys: vi.fn(),
}));

vi.mock('$lib/api/memory.js', () => ({
  getMemoryStats: (...args: unknown[]) => mocks.getMemoryStats(...args),
  listScopes: (...args: unknown[]) => mocks.listScopes(...args),
}));
vi.mock('$lib/api/keys.js', () => ({
  listKeys: (...args: unknown[]) => mocks.listKeys(...args),
}));

import { load } from './+page.js';

describe('memory page loader', () => {
  beforeEach(() => {
    mocks.getMemoryStats.mockReset().mockResolvedValue({ generatedAt: 'now' });
    mocks.listScopes.mockReset().mockResolvedValue({ rows: [], total: 0 });
    mocks.listKeys.mockReset().mockResolvedValue([]);
  });

  it('loads only the first scope page and stats, leaving keys lazy', async () => {
    const data = await load({ url: new URL('https://helm.test/memory') } as never);

    expect(mocks.listScopes).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(mocks.getMemoryStats).toHaveBeenCalledWith();
    expect(mocks.listKeys).not.toHaveBeenCalled();
    expect(data).toMatchObject({ scopePage: { rows: [], total: 0 }, initialKeyId: null });
  });
});
