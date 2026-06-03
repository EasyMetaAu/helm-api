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
  // Per-key usage budgets (docs/06). NULL = no cap for that dimension. Spend is
  // REAL (fractional USD, mirrors pg double precision). over_budget_behavior is a
  // text enum ('degrade' | 'reject') defaulting to 'degrade'; degrade_lane NULL =
  // 'economy' at use. window NULL = the system default window.
  budgetRequests: integer("budget_requests"),
  budgetTokens: integer("budget_tokens"),
  budgetSpendUsd: real("budget_spend_usd"),
  budgetWindowSeconds: integer("budget_window_seconds"),
  overBudgetBehavior: text("over_budget_behavior").notNull().default("degrade"),
  degradeLane: text("degrade_lane"),
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

// Per-key USAGE-BUDGET token buckets (docs/06 "usage budgets"). Same shape as
// rate_limit_buckets but a SEPARATE table: budgets refill over a CONFIGURABLE
// rolling window (not the fixed 60s) and exceeding one DEGRADES rather than
// rejects. One row per (key_id, dim ∈ req|tok|usd). tokens REAL so fractional
// spend/refill survive reads; may go negative (soft cap settled post-served).
export const usageBudgetBuckets = sqliteTable(
  "usage_budget_buckets",
  {
    keyId: text("key_id").notNull(), // key_id — never plaintext
    dim: text("dim").notNull(), // 'req' | 'tok' | 'usd'
    tokens: real("tokens").notNull(),
    lastRefillMs: integer("last_refill_ms").notNull(),
  },
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

// Per-account OAuth subscription USAGE aggregate (providers page Tier 2). One row
// per (provider_id, account, day) — day = UTC-midnight epoch ms. Additive counters
// (requests / tokens) + a nullable summed cost (REAL; flat-rate plans report no
// cost → stays NULL). first_seen_ms anchors the daily-average RPM derivation. NO
// key/payload column (principle 7); pure aggregate observability.
export const oauthUsage = sqliteTable(
  "oauth_usage",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    day: integer("day").notNull(), // UTC-midnight epoch ms
    requests: integer("requests").notNull(),
    tokens: integer("tokens").notNull(),
    costUsd: real("cost_usd"), // nullable; summed completion cost
    firstSeenMs: integer("first_seen_ms").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account, t.day] })],
);

// Per-account OAuth subscription QUOTA snapshot (providers page Tier 3). One row
// per (provider_id, account): the LATEST rate-limit window snapshot. `windows` is
// a JSON-text array of { key, usedPercent, resetsAtMs, windowMinutes } (SQLite has
// no native array). `source` = how it was captured (anthropic pull / codex-headers
// push). Latest-wins upsert; no history. Pure observability — no secret column.
export const oauthQuota = sqliteTable(
  "oauth_quota",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    windows: text("windows").notNull(), // JSON text: OAuthQuotaWindow[]
    capturedAt: integer("captured_at").notNull(),
    source: text("source").notNull(), // 'anthropic' | 'codex-headers'
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account] })],
);

export type ApiKeysTable = typeof apiKeys;
export type TelemetryTable = typeof telemetry;
export type OAuthUsageTable = typeof oauthUsage;
export type OAuthQuotaTable = typeof oauthQuota;
export type RateLimitBucketsTable = typeof rateLimitBuckets;
export type UsageBudgetBucketsTable = typeof usageBudgetBuckets;
export type RoutingSignalsTable = typeof routingSignals;
export type ConfigKvTable = typeof configKv;
export type RequestPayloadsTable = typeof requestPayloads;
export type OAuthTokensTable = typeof oauthTokens;
