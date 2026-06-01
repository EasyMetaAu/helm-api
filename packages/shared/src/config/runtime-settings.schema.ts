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
  // Auto-prune captured payloads older than this many days. Bounds the storage
  // footprint and the plaintext-exposure window. Capped at 10 years.
  payload_retention_days: z.number().int().positive().max(3650).default(30),
  // Global rate-limit master switch. Read live by the limiter middleware so the
  // admin can flip it without a restart. Seeded at boot from
  // runtime.rate_limit.enabled (see defaultSettingsFromConfig).
  rate_limit_enabled: z.boolean().default(false),
  // Structured-log verbosity floor. Applied live via logger.setLevel().
  log_level: LogLevelSchema.default("info"),
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
