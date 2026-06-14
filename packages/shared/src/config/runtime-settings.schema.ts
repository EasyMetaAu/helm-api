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
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
