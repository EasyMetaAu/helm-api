// Admin System Settings API client. The admin UI is a PURE consumer of the
// gateway's /admin/api/settings surface (CLAUDE.md Principle 1) — it imports NO core
// logic. The RuntimeSettings shape mirrors the gateway's Zod schema (@helm/shared
// RuntimeSettingsSchema, the single source of truth), duplicated here as a
// UI-facing type only because admin must not import core. The gateway validates
// the whole object on PUT and fail-closes (400) on any invalid field.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeSettings {
  capture_payloads: boolean;
  payload_retention_days: number;
  // Native protocol passthrough (issue #217). When ON, a same-protocol request
  // (e.g. Anthropic /v1/messages → an Anthropic subscription) forwards the
  // verbatim native body and returns the native response untranslated. Default
  // ON: cross-protocol / openai_chat / heterogeneous-chain traffic still falls
  // back to translation inside the gateway guard, so this is safe by default.
  // The admin toggle was removed in #236, but the field stays in the model so it
  // round-trips through Save unchanged (never reset to false — the #225 lesson).
  native_protocol_passthrough: boolean;
  rate_limit_enabled: boolean;
  // System DEFAULT quota any key without its own per-key override falls back to.
  // 0 = unlimited (mirrors the quota convention). Runtime-editable here.
  rate_limit_default_rpm: number;
  rate_limit_default_tpm: number;
  log_level: LogLevel;
  // Terminal fallback lane: where a request lands when the classifier fails open
  // or nothing else resolves. A lane NAME (must be a defined lane — the gateway
  // 400s an unknown lane on PUT). Default "balanced".
  default_lane: string;
  // Per-key concurrency overflow queue (issue #93, feature A). When ON, a key
  // with a concurrency_limit queues excess requests instead of an instant 429.
  concurrency_queue_enabled: boolean;
  concurrency_queue_min_size: number; // 固定最小排队数 (1-100)
  concurrency_queue_size_multiplier: number; // 排队数倍数; 0 = use min size only
  concurrency_queue_wait_timeout_ms: number; // 排队超时 (5s-5min)
  // Per-account user-message serial queue (issue #93, feature B). When ON,
  // user-message requests to the SAME OAuth account run one at a time with a
  // minimum delay between completions.
  user_message_queue_enabled: boolean;
  user_message_queue_delay_ms: number; // 请求间隔 (0-10000)
  user_message_queue_wait_timeout_ms: number; // 队列超时 (1s-5min)
  // ——— Automatic data cleanup / retention / archival (admin "Data cleanup") ———
  cleanup_enabled: boolean; // master switch
  cleanup_interval_hours: number; // sweep cadence (1-168)
  cleanup_archive_enabled: boolean; // archive-before-delete for training/audit tables
  telemetry_cleanup_enabled: boolean;
  telemetry_retention_days: number;
  payloads_cleanup_enabled: boolean; // window reuses payload_retention_days
  oauth_usage_cleanup_enabled: boolean;
  oauth_usage_retention_days: number;
  memory_jobs_cleanup_enabled: boolean;
  memory_jobs_retention_days: number;
  memory_messages_cleanup_enabled: boolean; // opt-in (highest training value)
  memory_messages_retention_days: number;
  memory_derived_cleanup_enabled: boolean; // opt-in (observations + facts)
  memory_derived_retention_days: number;
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
    // Default ON (a missing field reads as true), and — critically — KEEP it
    // across an admin save. normalize() drops any key it doesn't name, so omitting
    // this would silently reset the flag on every save (the #225 lesson).
    native_protocol_passthrough: raw.native_protocol_passthrough !== false,
    rate_limit_enabled: raw.rate_limit_enabled === true,
    rate_limit_default_rpm:
      typeof raw.rate_limit_default_rpm === 'number' ? raw.rate_limit_default_rpm : 0,
    rate_limit_default_tpm:
      typeof raw.rate_limit_default_tpm === 'number' ? raw.rate_limit_default_tpm : 0,
    log_level: (LOG_LEVEL_OPTIONS as readonly string[]).includes(level as string)
      ? (level as LogLevel)
      : 'info',
    default_lane:
      typeof raw.default_lane === 'string' && raw.default_lane ? raw.default_lane : 'balanced',
    concurrency_queue_enabled: raw.concurrency_queue_enabled === true,
    concurrency_queue_min_size:
      typeof raw.concurrency_queue_min_size === 'number' ? raw.concurrency_queue_min_size : 5,
    concurrency_queue_size_multiplier:
      typeof raw.concurrency_queue_size_multiplier === 'number'
        ? raw.concurrency_queue_size_multiplier
        : 0,
    concurrency_queue_wait_timeout_ms:
      typeof raw.concurrency_queue_wait_timeout_ms === 'number'
        ? raw.concurrency_queue_wait_timeout_ms
        : 10000,
    user_message_queue_enabled: raw.user_message_queue_enabled === true,
    user_message_queue_delay_ms:
      typeof raw.user_message_queue_delay_ms === 'number' ? raw.user_message_queue_delay_ms : 200,
    user_message_queue_wait_timeout_ms:
      typeof raw.user_message_queue_wait_timeout_ms === 'number'
        ? raw.user_message_queue_wait_timeout_ms
        : 5000,
    // Data-cleanup fields. Booleans default to the schema default (master/archive +
    // the always-on categories read true on a missing field; the two opt-in memory
    // categories read false). Every field MUST be named here or normalize() would
    // drop it and silently reset it on the next Save (the #225 lesson).
    cleanup_enabled: raw.cleanup_enabled !== false,
    cleanup_interval_hours:
      typeof raw.cleanup_interval_hours === 'number' ? raw.cleanup_interval_hours : 24,
    cleanup_archive_enabled: raw.cleanup_archive_enabled !== false,
    telemetry_cleanup_enabled: raw.telemetry_cleanup_enabled !== false,
    telemetry_retention_days:
      typeof raw.telemetry_retention_days === 'number' ? raw.telemetry_retention_days : 90,
    payloads_cleanup_enabled: raw.payloads_cleanup_enabled !== false,
    oauth_usage_cleanup_enabled: raw.oauth_usage_cleanup_enabled !== false,
    oauth_usage_retention_days:
      typeof raw.oauth_usage_retention_days === 'number' ? raw.oauth_usage_retention_days : 180,
    memory_jobs_cleanup_enabled: raw.memory_jobs_cleanup_enabled !== false,
    memory_jobs_retention_days:
      typeof raw.memory_jobs_retention_days === 'number' ? raw.memory_jobs_retention_days : 30,
    memory_messages_cleanup_enabled: raw.memory_messages_cleanup_enabled === true,
    memory_messages_retention_days:
      typeof raw.memory_messages_retention_days === 'number'
        ? raw.memory_messages_retention_days
        : 180,
    memory_derived_cleanup_enabled: raw.memory_derived_cleanup_enabled === true,
    memory_derived_retention_days:
      typeof raw.memory_derived_retention_days === 'number'
        ? raw.memory_derived_retention_days
        : 365,
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
