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

// Behavior when an account is over its credit quota (Issue #37). "reject" returns
// a structured 429 (hard stop, fail-closed gate); "alert" serves the request and
// lets the balance go negative while flagging it (soft). "degrade-lane" is
// deliberately deferred (D3) — it needs a new cap threaded through routing.
export const OverQuotaBehaviorSchema = z.enum(["reject", "alert"]);

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
  // System DEFAULT quota (requests/min, tokens/min) applied to any key WITHOUT
  // its own per-key override (ApiKeyRecord.rate_limit_{rpm,tpm}). Editable at
  // runtime so the operator can tune the fleet-wide fallback without a restart;
  // the limiter reads config.default fresh on every check. 0 = unlimited (mirrors
  // the quota convention). Seeded at boot from runtime.rate_limit.default.
  rate_limit_default_rpm: z.number().int().nonnegative().default(0),
  rate_limit_default_tpm: z.number().int().nonnegative().default(0),
  // Structured-log verbosity floor. Applied live via logger.setLevel().
  log_level: LogLevelSchema.default("info"),
  // Account credit/billing master switch (Issue #37). Default OFF — the credit
  // gate is a zero-touch pass-through (mirrors rate_limit_enabled). Read live by
  // the gate middleware so the admin can flip it without a restart. NOT yaml-
  // seeded (mirrors capture_payloads): takes the schema default at boot.
  credits_enabled: z.boolean().default(false),
  // System DEFAULT credit quota (USD) applied to any account WITHOUT its own
  // per-account credit_quota_usd override. 0 = unlimited (mirrors the rate-limit
  // quota convention). Must be finite + non-negative (fail-closed). Editable at
  // runtime so the operator can tune the fleet-wide default without a restart.
  credit_default_quota_usd: z.number().finite().nonnegative().default(0),
  // What the gate does when an account is over quota: "reject" (429, default) or
  // "alert" (serve + flag, balance may go negative). See OverQuotaBehaviorSchema.
  over_quota_behavior: OverQuotaBehaviorSchema.default("reject"),
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type OverQuotaBehavior = z.infer<typeof OverQuotaBehaviorSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
