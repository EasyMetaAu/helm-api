// Admin System Settings API client. The admin UI is a PURE consumer of the
// gateway's /admin/api/settings surface (CLAUDE.md 原则1) — it imports NO core
// logic. The RuntimeSettings shape mirrors the gateway's Zod schema (@helm/shared
// RuntimeSettingsSchema, the single source of truth), duplicated here as a
// UI-facing type only because admin must not import core. The gateway validates
// the whole object on PUT and fail-closes (400) on any invalid field.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeSettings {
  capture_payloads: boolean;
  payload_retention_days: number;
  rate_limit_enabled: boolean;
  // System DEFAULT quota any key without its own per-key override falls back to.
  // 0 = unlimited (mirrors the quota convention). Runtime-editable here.
  rate_limit_default_rpm: number;
  rate_limit_default_tpm: number;
  log_level: LogLevel;
}

export const LOG_LEVEL_OPTIONS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const BASE = '/admin/api/settings';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`settings api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// Coerce a raw backend object into the UI type, defaulting any missing field so a
// legacy/partial response still renders a complete form.
function normalize(raw: Record<string, unknown>): RuntimeSettings {
  const level = raw.log_level;
  return {
    capture_payloads: raw.capture_payloads !== false,
    payload_retention_days:
      typeof raw.payload_retention_days === 'number' ? raw.payload_retention_days : 30,
    rate_limit_enabled: raw.rate_limit_enabled === true,
    rate_limit_default_rpm:
      typeof raw.rate_limit_default_rpm === 'number' ? raw.rate_limit_default_rpm : 0,
    rate_limit_default_tpm:
      typeof raw.rate_limit_default_tpm === 'number' ? raw.rate_limit_default_tpm : 0,
    log_level: (LOG_LEVEL_OPTIONS as readonly string[]).includes(level as string)
      ? (level as LogLevel)
      : 'info',
  };
}

// GET /admin/api/settings -> the live RuntimeSettings.
export async function getSettings(): Promise<RuntimeSettings> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  return normalize(await asJson<Record<string, unknown>>(res));
}

// PUT /admin/api/settings <- the whole RuntimeSettings object (validated + applied
// live by the gateway). Echoes the validated result.
export async function saveSettings(next: RuntimeSettings): Promise<RuntimeSettings> {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  return normalize(await asJson<Record<string, unknown>>(res));
}
