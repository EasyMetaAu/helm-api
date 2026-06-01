import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, type RuntimeSettings, saveSettings } from './settings.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the System Settings client contract against a mocked
// fetch — GET reads the live settings, PUT sends the whole object.

const FULL: RuntimeSettings = {
  capture_payloads: false,
  payload_retention_days: 7,
  rate_limit_enabled: true,
  log_level: 'debug',
};

describe('settings api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getSettings GETs /admin/api/settings and normalizes the result', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(FULL), { status: 200 }),
    );
    const s = await getSettings();
    expect(fetch).toHaveBeenCalledWith('/admin/api/settings', expect.objectContaining({}));
    expect(s).toEqual(FULL);
  });

  it('getSettings defaults missing fields (legacy/partial response)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const s = await getSettings();
    expect(s).toEqual({
      capture_payloads: true,
      payload_retention_days: 30,
      rate_limit_enabled: false,
      log_level: 'info',
    });
  });

  it('saveSettings PUTs the whole settings object', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(FULL), { status: 200 }),
    );
    const saved = await saveSettings(FULL);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(FULL);
    expect(saved).toEqual(FULL);
  });

  it('throws on a non-OK response (fail-closed surfacing)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid settings' }), { status: 400 }),
    );
    await expect(saveSettings(FULL)).rejects.toThrow(/settings api 400/);
  });
});
