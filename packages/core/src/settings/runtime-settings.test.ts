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

// Only `runtime.rate_limit.enabled` is read by the seeder; cast a minimal tree.
function cfg(rateLimitEnabled: boolean): HelmConfig {
  return { runtime: { rate_limit: { enabled: rateLimitEnabled } } } as unknown as HelmConfig;
}

describe("defaultSettingsFromConfig", () => {
  it("seeds rate_limit_enabled from runtime config, schema defaults for the rest", () => {
    expect(defaultSettingsFromConfig(cfg(true))).toEqual({
      capture_payloads: true,
      payload_retention_days: 30,
      rate_limit_enabled: true,
      log_level: "info",
    });
    expect(defaultSettingsFromConfig(cfg(false)).rate_limit_enabled).toBe(false);
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

  it("fails OPEN on invalid JSON (returns defaults + logs warn)", async () => {
    const store = fakeConfigStore({ [RUNTIME_SETTINGS_KEY]: "{not json" });
    const log = vi.fn();
    const out = await loadRuntimeSettings(store, cfg(false), log);
    expect(out).toEqual(defaultSettingsFromConfig(cfg(false)));
    expect(log).toHaveBeenCalledWith("warn", "settings.load_fallback", { reason: "invalid_json" });
  });

  it("fails OPEN on a schema-mismatched row (returns defaults + logs warn)", async () => {
    const store = fakeConfigStore({
      [RUNTIME_SETTINGS_KEY]: JSON.stringify({ log_level: "verbose" }),
    });
    const log = vi.fn();
    const out = await loadRuntimeSettings(store, cfg(true), log);
    expect(out).toEqual(defaultSettingsFromConfig(cfg(true)));
    expect(log).toHaveBeenCalledWith("warn", "settings.load_fallback", {
      reason: "schema_mismatch",
    });
  });
});

describe("saveRuntimeSettings", () => {
  it("validates then persists the JSON blob and echoes it back", async () => {
    const store = fakeConfigStore();
    const saved = await saveRuntimeSettings(store, {
      capture_payloads: false,
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
