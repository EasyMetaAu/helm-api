import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModels } from './models.js';

// The model-alias catalog client. A UI convenience that must degrade gracefully:
// it GETs /admin/api/models, and on any failure resolves to [] (never throws) so
// the Lanes combobox falls back to a plain text input instead of crashing the page.

describe('models api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listModels GETs /admin/api/models and returns the alias array', async () => {
    const rows = ['openai-crs/gpt-5.4-mini', 'deepseek-crs/deepseek-pro'];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const models = await listModels();

    expect(fetch).toHaveBeenCalledWith('/admin/api/models', expect.objectContaining({}));
    expect(models).toEqual(rows);
  });

  it('returns [] (no throw) on a non-2xx response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(listModels()).resolves.toEqual([]);
  });

  it('returns [] (no throw) on a network error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    await expect(listModels()).resolves.toEqual([]);
  });

  it('filters out non-string entries defensively', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(['a/b', 42, null, 'c/d']), { status: 200 }),
    );
    await expect(listModels()).resolves.toEqual(['a/b', 'c/d']);
  });
});
