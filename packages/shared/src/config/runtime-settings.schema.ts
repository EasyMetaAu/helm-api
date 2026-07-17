import { z } from "zod";

// Runtime-mutable settings — the subset of operator-facing config that the admin
// "System Settings" page may change at runtime WITHOUT a restart. Unlike the
// boot-only config tree (server bind, providers, store driver), these are read
// through a re-bindable closure on every request, persisted to the config_kv
// store, and re-applied live (see packages/core settings + apps/gateway
// server.ts onSettings wiring).
//
// Per CLAUDE.md principle 2 (config-as-code, Zod-validated, invalid => fail
// closed): the admin PUT validates against this schema and rejects (400) on any
// invalid field — the live closure is never re-bound to an invalid object.
//
// NOTE on `capture_payloads`: factory default is TRUE — the gateway records the
// full request/response bodies into the request_payloads store. This is a
// deliberate operator choice for a self-hosted gateway (data stays on the
// operator's own box) and can be turned off here. It does NOT relax the API-key
// rule: keys are still stored as sha256 only and never logged in plaintext (the
// bearer key lives in the Authorization header, never in the chat body we store).

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const VisualContextCompressionModeSchema = z.enum(["off", "observe", "enabled"]);

export const RuntimeSettingsSchema = z.object({
  // Record full request/response bodies for each call. Default ON (operator
  // owns the data on a self-hosted box); toggle off for a stricter privacy
  // posture. When off, the capture path is skipped entirely (zero storage).
  capture_payloads: z.boolean().default(true),
  // Forward a same-protocol request body verbatim to the native upstream,
  // bypassing the lossy IR translation round-trip. Default ON: when the inbound
  // protocol already equals the upstream wire protocol (e.g. Anthropic
  // /v1/messages → an Anthropic backend) the verbatim forward is higher-fidelity
  // and cache-friendlier than translating. The guard is per-attempt: it still falls
  // back to translation for openai_chat (lingua franca) and cross-protocol attempts,
  // so a later heterogeneous fallback can translate if reached.
  native_protocol_passthrough: z.boolean().default(true),
  // Recover malformed upstream tool calls leaked as literal Anthropic <invoke>
  // XML. Default ON because the recovery is guarded by the upstream tool-use stop
  // signal, a closed block, and the request's declared-tool whitelist.
  tool_call_xml_recovery: z.boolean().default(true),
  // Visual context compression renders bulky Anthropic-native context into image
  // blocks before an upstream call. Default OFF because the technique is lossy:
  // dense images are useful for gist/context, not exact byte recall. `observe`
  // runs the estimator/transform on a copy and records body-free telemetry while
  // sending the original request; `enabled` sends the transformed body when the
  // optimizer applies.
  visual_context_compression: VisualContextCompressionModeSchema.default("off"),
  // Auto-prune captured payloads older than this many days. Bounds the storage
  // footprint and the plaintext-exposure window. Capped at 10 years.
  payload_retention_days: z.number().int().positive().max(3650).default(30),
  // Global rate-limit master switch. Read live by the limiter middleware so the
  // admin can flip it without a restart. Seeded at boot from
  // runtime.rate_limit.enabled (see defaultSettingsFromConfig).
  rate_limit_enabled: z.boolean().default(false),
  // System DEFAULT quota (requests/min, tokens/min) applied to any key WITHOUT
  // its own per-key override (ApiKeyRecord.rate_limit_{rpm,tpm}). Editable at
  // runtime so the operator can tune the fleet-wide fallback without a restart;
  // the limiter reads config.default fresh on every check. 0 = unlimited (mirrors
  // the quota convention). Seeded at boot from runtime.rate_limit.default.
  rate_limit_default_rpm: z.number().int().nonnegative().default(0),
  rate_limit_default_tpm: z.number().int().nonnegative().default(0),
  // Structured-log verbosity floor. Applied live via logger.setLevel().
  log_level: LogLevelSchema.default("info"),
  // Terminal fallback lane — where a request lands when the classifier fails open
  // (decided_by "default"/"fallback") or nothing else resolves. Default "balanced"
  // (the schema-guaranteed floor, so behaviour is unchanged when unset). The lane
  // resolver only honours this if the named lane EXISTS, otherwise it falls back to
  // "balanced" — so a stale/removed lane can never strand routing (no fail-close).
  // Lane-existence is validated fail-closed at the admin PUT route. Only the
  // terminal sink is affected; the complexity tiers (simple→economy / medium→
  // balanced / complex→premium) are intentionally NOT changed by this setting.
  default_lane: z.string().min(1).default("balanced"),
  // ——— Per-API-key concurrency overflow queue (docs issue #93, feature A) ———
  // When ON and a key has a concurrency_limit, requests beyond the limit WAIT in
  // a FIFO queue instead of an immediate 429. Default OFF: without it the limit
  // is simply not enforced (keys with no limit are never touched either way).
  concurrency_queue_enabled: z.boolean().default(false),
  // Fixed minimum queue capacity per key (固定最小排队数).
  concurrency_queue_min_size: z.number().int().min(1).max(100).default(5),
  // Queue capacity multiplier (排队数倍数): effective max queue =
  // MAX(floor(multiplier × concurrency_limit), min_size); 0 = use min_size only.
  concurrency_queue_size_multiplier: z.number().nonnegative().default(0),
  // How long a queued request may wait for a slot before a 429 (排队超时).
  concurrency_queue_wait_timeout_ms: z.number().int().min(5_000).max(300_000).default(10_000),
  // ——— Per-OAuth-account user-message serial queue (issue #93, feature B) ———
  // When ON, requests whose LAST message is a genuine user turn are serialized
  // per upstream OAuth account with a minimum delay between completions, to
  // avoid tripping upstream subscription rate limits. Tool-result round-trips
  // and assistant continuations are never queued.
  user_message_queue_enabled: z.boolean().default(false),
  // Minimum gap between the previous request's COMPLETION and the next send (请求间隔).
  user_message_queue_delay_ms: z.number().int().min(0).max(10_000).default(200),
  // How long a request may wait for its turn before a 503 (队列超时).
  user_message_queue_wait_timeout_ms: z.number().int().min(1_000).max(300_000).default(5_000),

  // ——— Automatic data cleanup / retention / archival (admin "Data cleanup") ———
  // A scheduled sweep (+ a manual "Clean Now" button) deletes data older than each
  // per-category window. The two biggest UNBOUNDED tables (telemetry decisions and
  // request/response payloads) had a coupling bug — payload pruning only ran while
  // capture was on AND traffic flowed, and telemetry had NO prune at all. The
  // scheduled runner fixes both: it owns the prune independent of capture/traffic.
  //
  // For training/audit-valuable tables, cleanup_archive_enabled exports the aged
  // rows to a compressed gzip-JSONL file (under HELM_ARCHIVE_DIR) and VERIFIES the
  // write before deleting — so "delete" never loses data outright, it relocates it.
  //
  // Master switch. Default ON: the sweep runs and bounds storage growth out of the
  // box. Turn off to freeze ALL automatic deletion (byte-identical to the old
  // behaviour). The manual buttons still work while off.
  cleanup_enabled: z.boolean().default(true),
  // How often the background sweep runs (hours). The sweep is cheap (indexed age
  // cutoffs) but archiving + reads are heavier than the 60s memory tick, so it runs
  // on its own slower cadence. 1h–1 week.
  cleanup_interval_hours: z.number().int().min(1).max(168).default(24),
  // Archive-before-delete for the training/audit tables (telemetry, payloads,
  // memory_messages). Default OFF (review H3): archive-before-delete means a sink
  // failure (disk full) skips the delete entirely → unbounded table growth (the
  // production payload-bloat incident). Off = straight delete at the retention
  // window (always bounded). Operators who want archived history opt in explicitly;
  // even then a hard safety-horizon prune (2× the window) bounds growth if the sink
  // keeps failing — see buildCleanupPlan / runCleanup.
  cleanup_archive_enabled: z.boolean().default(false),

  // Telemetry decision records (redacted; routing/cost/latency labels). Default ON,
  // 90-day window — fixes the unbounded-growth gap.
  telemetry_cleanup_enabled: z.boolean().default(true),
  telemetry_retention_days: z.number().int().positive().max(3650).default(90),
  // Full request/response bodies. The retention window REUSES payload_retention_days
  // (above) so there is a single source of truth. This toggle decouples the prune
  // from capture: cleanup runs whether or not capture_payloads is on.
  payloads_cleanup_enabled: z.boolean().default(true),
  // Per-account OAuth hourly usage counters (observability aggregates — delete-only,
  // no training value). Default ON, 180-day window.
  oauth_usage_cleanup_enabled: z.boolean().default(true),
  oauth_usage_retention_days: z.number().int().positive().max(3650).default(180),
  // Finished (done/failed) memory background-job rows — a job log; never touches the
  // live pending/running queue. Default ON, 30-day window.
  memory_jobs_cleanup_enabled: z.boolean().default(true),
  memory_jobs_retention_days: z.number().int().positive().max(3650).default(30),
  // Raw conversation transcript (memory_messages) — HIGHEST training value. Default
  // OFF (opt-in): deleting raw turns before the observer compacts a thread loses
  // ungenerated memory. Archive-first when enabled. 180-day window.
  memory_messages_cleanup_enabled: z.boolean().default(false),
  memory_messages_retention_days: z.number().int().positive().max(3650).default(180),
  // Derived memory: hard-delete already-archived observations + already-expired
  // facts past their window (reuses the forgetting retention sweep, but driven by
  // THIS switch so it works even when forgetting scoring is off). Reflections are
  // never hard-deleted. Default OFF, 365-day window.
  memory_derived_cleanup_enabled: z.boolean().default(false),
  memory_derived_retention_days: z.number().int().positive().max(3650).default(365),

  // ——— Automatic database compaction (sqlite VACUUM) ———
  // Deleting rows frees pages to SQLite's freelist but NEVER shrinks the file
  // (auto_vacuum is off) — so a high-churn table (e.g. captured payloads) leaves the
  // .db bloated with dead pages long after cleanup deletes the rows. VACUUM rewrites
  // the file and returns the space to the OS, but it holds an EXCLUSIVE lock for the
  // whole rewrite (in-flight requests pause), so it must run at a low-traffic hour.
  // This pair schedules it: vacuum_enabled gates it (default OFF — opt in, like the
  // manual "Compact database" button); vacuum_hour picks the SERVER-LOCAL hour (0–23)
  // to run, at most once per day. Postgres autovacuums, so the scheduler is a no-op
  // there (StoreSet.vacuum is empty for supabase).
  vacuum_enabled: z.boolean().default(false),
  vacuum_hour: z.number().int().min(0).max(23).default(4),
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type VisualContextCompressionMode = z.infer<typeof VisualContextCompressionModeSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
