import type { HelmConfig } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../store/ports.js";
import {
  defaultSettingsFromConfig,
  loadRuntimeSettings,
  RUNTIME_SETTINGS_KEY,
  saveRuntimeSettings,
} from "./runtime-settings.js";

// In-memory ConfigStore double — the port is just a string key/value bag.
function fakeConfigStore(seed: Record<string, string> = {}): ConfigStore & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
  };
}

// The seeder reads runtime.rate_limit.{enabled,default}; cast a minimal tree.
function cfg(rateLimitEnabled: boolean, dflt: { rpm: number; tpm: number } = { rpm: 0, tpm: 0 }) {
  return {
    runtime: { rate_limit: { enabled: rateLimitEnabled, default: dflt } },
  } as unknown as HelmConfig;
}

describe("defaultSettingsFromConfig", () => {
  it("seeds rate_limit_enabled from runtime config, schema defaults for the rest", () => {
    expect(defaultSettingsFromConfig(cfg(true))).toEqual({
      capture_payloads: true,
      native_protocol_passthrough: true,
      payload_retention_days: 30,
      rate_limit_enabled: true,
      rate_limit_default_rpm: 0,
      rate_limit_default_tpm: 0,
      log_level: "info",
      default_lane: "balanced",
      // Queueing fields (issue #93) come straight from the schema defaults.
      concurrency_queue_enabled: false,
      concurrency_queue_min_size: 5,
      concurrency_queue_size_multiplier: 0,
      concurrency_queue_wait_timeout_ms: 10_000,
      user_message_queue_enabled: false,
      user_message_queue_delay_ms: 200,
      user_message_queue_wait_timeout_ms: 5_000,
      // Data-cleanup fields come straight from the schema defaults.
      cleanup_enabled: true,
      cleanup_interval_hours: 24,
      cleanup_archive_enabled: false,
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
      vacuum_enabled: false,
      vacuum_hour: 4,
    });
    expect(defaultSettingsFromConfig(cfg(false)).rate_limit_enabled).toBe(false);
  });

  it("seeds the default rpm/tpm quota from runtime.rate_limit.default", () => {
    const seeded = defaultSettingsFromConfig(cfg(true, { rpm: 60, tpm: 90000 }));
    expect(seeded.rate_limit_default_rpm).toBe(60);
    expect(seeded.rate_limit_default_tpm).toBe(90000);
  });
});

describe("loadRuntimeSettings", () => {
  it("returns config-seeded defaults when no row is persisted", async () => {
    const store = fakeConfigStore();
    const out = await loadRuntimeSettings(store, cfg(true));
    expect(out).toEqual(defaultSettingsFromConfig(cfg(true)));
  });

  it("lets a persisted row override the defaults, field-by-field", async () => {
    const store = fakeConfigStore({
      [RUNTIME_SETTINGS_KEY]: JSON.stringify({ capture_payloads: false, log_level: "debug" }),
    });
    const out = await loadRuntimeSettings(store, cfg(true));
    expect(out.capture_payloads).toBe(false);
    expect(out.log_level).toBe("debug");
    // Untouched fields fall back to the config-seeded defaults.
    expect(out.rate_limit_enabled).toBe(true);
    expect(out.payload_retention_days).toBe(30);
  });

  it("defaults default_lane to 'balanced' and lets a persisted row override it", async () => {
    // unset -> schema default
    const seeded = await loadRuntimeSettings(fakeConfigStore(), cfg(true));
    expect(seeded.default_lane).toBe("balanced");
    // persisted -> wins
    const store = fakeConfigStore({
      [RUNTIME_SETTINGS_KEY]: JSON.stringify({ default_lane: "economy" }),
    });
    const out = await loadRuntimeSettings(store, cfg(true));
    expect(out.default_lane).toBe("economy");
  });

  it("fails OPEN on invalid JSON (returns defaults + logs warn)", async () => {
    const store = fakeConfigStore({ [RUNTIME_SETTINGS_KEY]: "{not json" });
    const log = vi.fn();
    const out = await loadRuntimeSettings(store, cfg(false), log);
    expect(out).toEqual({ ...defaultSettingsFromConfig(cfg(false)), capture_payloads: false });
    expect(log).toHaveBeenCalledWith("warn", "settings.load_fallback", { reason: "invalid_json" });
  });

  it("fails OPEN on a schema-mismatched row with capture disabled (returns defaults + logs warn)", async () => {
    const store = fakeConfigStore({
      [RUNTIME_SETTINGS_KEY]: JSON.stringify({ log_level: "verbose" }),
    });
    const log = vi.fn();
    const out = await loadRuntimeSettings(store, cfg(true), log);
    expect(out).toEqual({ ...defaultSettingsFromConfig(cfg(true)), capture_payloads: false });
    expect(log).toHaveBeenCalledWith("warn", "settings.load_fallback", {
      reason: "schema_mismatch",
    });
  });
});

describe("saveRuntimeSettings", () => {
  it("validates then persists the JSON blob and echoes it back", async () => {
    const store = fakeConfigStore();
    const saved = await saveRuntimeSettings(store, {
      ...defaultSettingsFromConfig(cfg(true)),
      capture_payloads: false,
      native_protocol_passthrough: false,
      payload_retention_days: 7,
      rate_limit_enabled: true,
      log_level: "warn",
    });
    expect(saved.payload_retention_days).toBe(7);
    expect(JSON.parse(store.map.get(RUNTIME_SETTINGS_KEY) ?? "{}")).toEqual(saved);
  });

  it("throws (fail-closed) on an invalid object so the admin PUT can 400", async () => {
    const store = fakeConfigStore();
    await expect(
      saveRuntimeSettings(store, { payload_retention_days: -1 } as never),
    ).rejects.toThrow();
    expect(store.map.has(RUNTIME_SETTINGS_KEY)).toBe(false);
  });
});
