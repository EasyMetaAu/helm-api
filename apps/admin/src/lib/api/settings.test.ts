import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, type RuntimeSettings, saveSettings } from './settings.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the System Settings client contract against a mocked
// fetch — GET reads the live settings, PUT sends the whole object.

const FULL: RuntimeSettings = {
  capture_payloads: false,
  payload_retention_days: 7,
  native_protocol_passthrough: true,
  rate_limit_enabled: true,
  rate_limit_default_rpm: 60,
  rate_limit_default_tpm: 90000,
  log_level: 'debug',
  default_lane: 'premium',
  concurrency_queue_enabled: true,
  concurrency_queue_min_size: 8,
  concurrency_queue_size_multiplier: 1.5,
  concurrency_queue_wait_timeout_ms: 20000,
  user_message_queue_enabled: true,
  user_message_queue_delay_ms: 300,
  user_message_queue_wait_timeout_ms: 8000,
  cleanup_enabled: false,
  cleanup_interval_hours: 12,
  cleanup_archive_enabled: false,
  telemetry_cleanup_enabled: false,
  telemetry_retention_days: 45,
  payloads_cleanup_enabled: false,
  oauth_usage_cleanup_enabled: false,
  oauth_usage_retention_days: 60,
  memory_jobs_cleanup_enabled: false,
  memory_jobs_retention_days: 14,
  memory_messages_cleanup_enabled: true,
  memory_messages_retention_days: 200,
  memory_derived_cleanup_enabled: true,
  memory_derived_retention_days: 400,
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
      native_protocol_passthrough: true,
      rate_limit_enabled: false,
      rate_limit_default_rpm: 0,
      rate_limit_default_tpm: 0,
      log_level: 'info',
      default_lane: 'balanced',
      // Queueing fields default to the schema's documented values (both OFF).
      concurrency_queue_enabled: false,
      concurrency_queue_min_size: 5,
      concurrency_queue_size_multiplier: 0,
      concurrency_queue_wait_timeout_ms: 10000,
      user_message_queue_enabled: false,
      user_message_queue_delay_ms: 200,
      user_message_queue_wait_timeout_ms: 5000,
      // Data-cleanup defaults (master/archive + always-on categories ON; the two
      // memory categories opt-in OFF).
      cleanup_enabled: true,
      cleanup_interval_hours: 24,
      cleanup_archive_enabled: true,
      telemetry_cleanup_enabled: true,
      telemetry_retention_days: 90,
      payloads_cleanup_enabled: true,
      oauth_usage_cleanup_enabled: true,
      oauth_usage_retention_days: 180,
      memory_jobs_cleanup_enabled: true,
      memory_jobs_retention_days: 30,
      memory_messages_cleanup_enabled: false,
      memory_messages_retention_days: 180,
      memory_derived_cleanup_enabled: false,
      memory_derived_retention_days: 365,
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

  it('preserves native protocol passthrough when saving an unrelated field', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify(FULL), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...FULL, log_level: 'warn' }), { status: 200 }),
      );

    const current = await getSettings();
    await saveSettings({ ...current, log_level: 'warn' });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(JSON.parse(init.body as string)).toMatchObject({
      log_level: 'warn',
      native_protocol_passthrough: true,
    });
  });

  it('throws on a non-OK response (fail-closed surfacing)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid settings' }), { status: 400 }),
    );
    await expect(saveSettings(FULL)).rejects.toThrow(/settings api 400/);
  });
});
