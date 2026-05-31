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
  maxLane: text("max_lane"), // optional cap lane
  allowedLanes: text("allowed_lanes"), // JSON text array (SQLite has no native array)
  allowCustomModel: integer("allow_custom_model", { mode: "boolean" }) // SQLite has no native boolean
    .notNull()
    .default(false),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
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

export type ApiKeysTable = typeof apiKeys;
export type TelemetryTable = typeof telemetry;
export type RateLimitBucketsTable = typeof rateLimitBuckets;
export type RoutingSignalsTable = typeof routingSignals;
export type ConfigKvTable = typeof configKv;
