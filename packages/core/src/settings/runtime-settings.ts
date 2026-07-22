import { type HelmConfig, type RuntimeSettings, RuntimeSettingsSchema } from "@helm/shared";
import type { ConfigStore } from "../store/ports.js";

// Storage key for the single JSON blob in the config_kv store. One row holds the
// whole RuntimeSettings object (validated by RuntimeSettingsSchema on read/write).
export const RUNTIME_SETTINGS_KEY = "runtime_settings";

// Optional structured-log sink. core never imports the gateway logger; callers
// pass a thin adapter. Fail-open reads log a warning through this.
export type SettingsLog = (
  level: "warn" | "info",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

// Seed the factory defaults from the boot config: rate_limit_enabled and the
// default rpm/tpm quota mirror runtime.rate_limit.{enabled,default} so the admin
// "System Settings" surface starts in sync with yaml/env (the operator can then
// tune the fleet-wide fallback live without a restart). All other fields take
// their schema defaults (capture_sessions:true etc).
export function defaultSettingsFromConfig(config: HelmConfig): RuntimeSettings {
  return RuntimeSettingsSchema.parse({
    rate_limit_enabled: config.runtime.rate_limit.enabled,
    rate_limit_default_rpm: config.runtime.rate_limit.default.rpm,
    rate_limit_default_tpm: config.runtime.rate_limit.default.tpm,
  });
}

function privacySafeFallback(defaults: RuntimeSettings): RuntimeSettings {
  return { ...defaults, capture_payloads: false, capture_sessions: false };
}

// Read the persisted runtime settings, overlaying them on the config-seeded
// defaults (persisted fields WIN; defaults fill any omitted field). Fail-OPEN on
// read: a missing row, malformed JSON, or a row that no longer matches the schema
// (e.g. after a version skew) falls back to defaults and logs — an unreadable
// settings blob is operator-convenience state, NOT a security boundary, so it
// must never crash the gateway (contrast with config-as-code fail-closed at boot).
export async function loadRuntimeSettings(
  configStore: ConfigStore,
  config: HelmConfig,
  log?: SettingsLog,
): Promise<RuntimeSettings> {
  const defaults = defaultSettingsFromConfig(config);
  const raw = await configStore.get(RUNTIME_SETTINGS_KEY);
  if (raw === null) return defaults;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    log?.("warn", "settings.load_fallback", { reason: "invalid_json" });
    return privacySafeFallback(defaults);
  }

  const overlay: Record<string, unknown> =
    parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)
      ? { ...parsedJson }
      : {};
  // Pre-Session releases persisted only capture_payloads. Preserve that explicit
  // operator choice instead of combining it with the new Session default.
  if (Object.hasOwn(overlay, "capture_payloads") && !Object.hasOwn(overlay, "capture_sessions")) {
    overlay.capture_sessions = false;
  }
  const merged = RuntimeSettingsSchema.safeParse({ ...defaults, ...overlay });
  if (!merged.success) {
    log?.("warn", "settings.load_fallback", { reason: "schema_mismatch" });
    return privacySafeFallback(defaults);
  }
  return merged.data;
}

// Validate + persist. Fail-CLOSED on write: an invalid object throws so the admin
// PUT surfaces a 400 and the live closure is never re-bound to a bad value
// (CLAUDE.md principle 2). Returns the validated object for echo-back.
export async function saveRuntimeSettings(
  configStore: ConfigStore,
  settings: RuntimeSettings,
): Promise<RuntimeSettings> {
  const validated = RuntimeSettingsSchema.parse(settings);
  await configStore.set(RUNTIME_SETTINGS_KEY, JSON.stringify(validated));
  return validated;
}
