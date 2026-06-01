import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SQLite (Drizzle) table definitions for the sqlite Store adapter. Columns align
// with docs/06 (api_keys) and docs/02 (telemetry / decision record). Dialect
// quirks (no native boolean/array) are encapsulated HERE — core and the supabase
// adapter never see them. Per CLAUDE.md principle 7: NO plaintext column; only
// hash + prefix. Telemetry stores a redacted decision JSON, no plaintext payload.

export const apiKeys = sqliteTable("api_keys", {
  keyId: text("key_id").primaryKey(),
  hash: text("hash").notNull().unique(), // sha256(plaintext); getByHash uses the unique index
  prefix: text("prefix").notNull(), // helm_live_xxxx — display/debug only
  accountId: text("account_id").notNull(),
  role: text("role").notNull(), // 'root' | 'user'
  allowedLanes: text("allowed_lanes"), // JSON text array (SQLite has no native array)
  allowCustomModel: integer("allow_custom_model", { mode: "boolean" }) // SQLite has no native boolean
    .notNull()
    .default(false),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  // Per-key rate-limit override (docs/06). Nullable: NULL = inherit the system
  // default at check time; a value (0 = unlimited) overrides that one dimension.
  rateLimitRpm: integer("rate_limit_rpm"),
  rateLimitTpm: integer("rate_limit_tpm"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const telemetry = sqliteTable("telemetry", {
  id: text("id").primaryKey(), // self-generated id
  requestId: text("request_id").notNull().unique(),
  apiKeyId: text("api_key_id").notNull(), // key_id only — never hash/plaintext
  decisionJson: text("decision_json").notNull(), // JSON.stringify(DecisionRecord), redacted
  finalStatus: text("final_status"), // denormalized final.status for querying
  costUsd: real("cost_usd"), // nullable; REAL mirrors pg doublePrecision (no truncation)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Per-key rate-limit token buckets (one row per key_id + dimension). Counters
// live in the store — NOT process memory — so windows survive restarts and span
// instances (docs/06). key_id only; never a plaintext/hashed key (principle 7).
// tokens stored as REAL so fractional refill survives across reads.
export const rateLimitBuckets = sqliteTable(
  "rate_limit_buckets",
  {
    keyId: text("key_id").notNull(), // key_id — never plaintext
    dim: text("dim").notNull(), // 'rpm' | 'tpm'
    tokens: real("tokens").notNull(),
    lastRefillMs: integer("last_refill_ms").notNull(),
  },
  // Composite PK mirrors pg + the hand-written migrate DDL; the onConflict upsert
  // target relies on it (the migration declares it, this makes Drizzle agree).
  (t) => [primaryKey({ columns: [t.keyId, t.dim] })],
);

// Agentic Signals (POST-MVP feedback layer; docs/02). One row per
// (task_type, lane) — the latest rolled-up, REDACTED observation. NO key /
// payload column (principle 7): only aggregate dimensions. avg_cost_usd is REAL
// nullable. Written ASYNCHRONOUSLY by the background collector, never on the
// request path. This table is observe-only: the MVP route never reads it.
export const routingSignals = sqliteTable(
  "routing_signals",
  {
    taskType: text("task_type").notNull(),
    lane: text("lane").notNull(),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
    samples: integer("samples").notNull(),
    successRate: real("success_rate").notNull(),
    fallbackRate: real("fallback_rate").notNull(), // EXECUTION fallback (in-chain swap)
    classifierFallbackRate: real("classifier_fallback_rate").notNull(), // CLASSIFICATION fallback
    errorRate: real("error_rate").notNull(),
    p50LatencyMs: real("p50_latency_ms").notNull(),
    p95LatencyMs: real("p95_latency_ms").notNull(),
    avgCostUsd: real("avg_cost_usd"), // nullable
    updatedAt: integer("updated_at").notNull(),
  },
  // Composite PK mirrors pg + the migrate DDL; the signals upsert onConflict
  // target relies on (task_type, lane) being the conflict key.
  (t) => [primaryKey({ columns: [t.taskType, t.lane] })],
);

// Optional config key/value persistence (ConfigStore port; admin write-back).
// MVP is yaml-first; this is reserved for runtime overrides. No secrets stored
// here (config references credentials by env-var name, never plaintext).
export const configKv = sqliteTable("config_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Full request/response body capture (admin "System Settings" → capture_payloads,
// default ON). Stored SEPARATELY from telemetry so it can be pruned independently
// (payload_retention_days) and never bloats the decision JSON. Unlike telemetry
// this is NOT redacted — it is the verbatim client request + assembled provider
// response. This holds NO plaintext API key: the bearer lives in the request's
// Authorization header, which is never part of the chat body stored here.
export const requestPayloads = sqliteTable("request_payloads", {
  requestId: text("request_id").primaryKey(),
  requestJson: text("request_json").notNull(), // verbatim client request body (JSON text)
  responseJson: text("response_json"), // assembled full response (null on error/unknown)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Persisted OAuth subscription credentials (issue #38). One row per
// (provider_id, account). access_enc / refresh_enc are AES-256-GCM CIPHERTEXT
// (store/crypto/token-cipher.ts) — the ONLY reversibly-stored secrets in Helm,
// kept encrypted because they are replayed to the upstream token endpoint (unlike
// api_keys, which are hash-only). The adapter stores the blobs verbatim and never
// decrypts. meta holds provider-specific JSON (e.g. copilot proxy base).
export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    accessEnc: text("access_enc"), // AES-GCM blob; nullable (lazy-derived access)
    refreshEnc: text("refresh_enc"), // AES-GCM blob (long-lived credential)
    expiresAt: integer("expires_at"), // ms epoch; nullable
    meta: text("meta"), // provider-specific JSON; nullable
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account] })],
);

// Account credit quotas / billing (Issue #37). One ACCOUNT : N keys. The live
// running balance + tri-state quota (NULL inherit / 0 unlimited / number cap,
// mirroring the rate-limit quota convention). USD as REAL (mirrors pg double
// precision); disabled as INTEGER boolean (sqlite has no native bool).
export const accounts = sqliteTable("accounts", {
  accountId: text("account_id").primaryKey(),
  name: text("name"),
  creditBalanceUsd: real("credit_balance_usd").notNull().default(0),
  creditQuotaUsd: real("credit_quota_usd"), // NULL inherit / 0 unlimited / number cap
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Append-only credit ledger — the audit trail for every balance change. api_key_id
// is key_id ONLY (principle 7). cost_measured distinguishes a real 0 from "pricing
// unknown" (null cost → debit 0 + cost_measured=false, D4). request_id/api_key_id
// are NULL for topups/adjustments (no originating call).
export const creditLedger = sqliteTable("credit_ledger", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  requestId: text("request_id"),
  apiKeyId: text("api_key_id"), // key_id only — never plaintext/hash
  amountUsd: real("amount_usd").notNull(), // signed: negative=debit, positive=topup
  balanceAfterUsd: real("balance_after_usd").notNull(),
  kind: text("kind").notNull(), // 'debit' | 'topup' | 'adjustment'
  costMeasured: integer("cost_measured", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type ApiKeysTable = typeof apiKeys;
export type TelemetryTable = typeof telemetry;
export type RateLimitBucketsTable = typeof rateLimitBuckets;
export type RoutingSignalsTable = typeof routingSignals;
export type ConfigKvTable = typeof configKv;
export type RequestPayloadsTable = typeof requestPayloads;
export type OAuthTokensTable = typeof oauthTokens;
export type AccountsTable = typeof accounts;
export type CreditLedgerTable = typeof creditLedger;
