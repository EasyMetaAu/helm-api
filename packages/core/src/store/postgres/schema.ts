import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

// Postgres (Drizzle pg-core) table definitions for the supabase Store adapter.
// Same LOGICAL schema as the sqlite adapter (packages/core/src/store/sqlite/
// schema.ts) — supabase == hosted Postgres — but expressed with native pg types:
// real booleans, jsonb for arrays/objects, double precision for fractional
// counters. Dialect quirks are encapsulated HERE so core and the sqlite adapter
// never see them (CLAUDE.md "DB abstraction layer"). Epoch-millisecond timestamps are stored
// as bigint (mode: "number") so the value space matches the sqlite timestamp_ms
// columns exactly and the port contract is byte-for-byte identical across
// drivers. Per principle 7: NO plaintext column anywhere — only hash + prefix.

export const apiKeys = pgTable("api_keys", {
  keyId: text("key_id").primaryKey(),
  hash: text("hash").notNull().unique(), // sha256(plaintext); getByHash uses the unique index
  prefix: text("prefix").notNull(), // helm_live_xxxx — display/debug only
  accountId: text("account_id").notNull(),
  role: text("role").notNull(), // 'root' | 'user'
  allowedLanes: jsonb("allowed_lanes").$type<string[]>(), // native jsonb array
  allowCustomModel: boolean("allow_custom_model").notNull().default(false),
  disabled: boolean("disabled").notNull().default(false),
  // Per-key rate-limit override (docs/06). Nullable: NULL = inherit the system
  // default at check time; a value (0 = unlimited) overrides that one dimension.
  rateLimitRpm: integer("rate_limit_rpm"),
  rateLimitTpm: integer("rate_limit_tpm"),
  // Per-key usage budgets (docs/06). NULL = no cap. Spend is double precision
  // (fractional USD). over_budget_behavior text enum defaulting to 'degrade'.
  budgetRequests: integer("budget_requests"),
  budgetTokens: integer("budget_tokens"),
  budgetSpendUsd: doublePrecision("budget_spend_usd"),
  budgetWindowSeconds: integer("budget_window_seconds"),
  overBudgetBehavior: text("over_budget_behavior").notNull().default("degrade"),
  degradeLane: text("degrade_lane"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // epoch ms
});

export const telemetry = pgTable("telemetry", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  apiKeyId: text("api_key_id").notNull(), // key_id only — never hash/plaintext
  decisionJson: jsonb("decision_json").notNull(), // redacted DecisionRecord (native jsonb)
  finalStatus: text("final_status"),
  costUsd: doublePrecision("cost_usd"), // nullable; summed attempt cost
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // epoch ms
});

// Per-key rate-limit token buckets (one row per key_id + dimension). Counters
// live in the store so windows survive restarts / span instances (docs/06).
// key_id only; never a plaintext/hashed key (principle 7). tokens is double
// precision so fractional refill survives across reads.
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    keyId: text("key_id").notNull(), // key_id — never plaintext
    dim: text("dim").notNull(), // 'rpm' | 'tpm'
    tokens: doublePrecision("tokens").notNull(),
    lastRefillMs: bigint("last_refill_ms", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.dim] })],
);

// Per-key USAGE-BUDGET token buckets (docs/06 "usage budgets") — pg mirror of the
// sqlite usage_budget_buckets table. Configurable rolling window; exceeding a
// budget DEGRADES rather than rejects. One row per (key_id, dim ∈ req|tok|usd).
// tokens double precision (fractional, may go negative — soft cap). key_id only.
export const usageBudgetBuckets = pgTable(
  "usage_budget_buckets",
  {
    keyId: text("key_id").notNull(),
    dim: text("dim").notNull(), // 'req' | 'tok' | 'usd'
    tokens: doublePrecision("tokens").notNull(),
    lastRefillMs: bigint("last_refill_ms", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.dim] })],
);

// Agentic Signals (POST-MVP feedback layer; docs/02). One row per
// (task_type, lane); NO key/payload column (principle 7). avg_cost_usd nullable.
export const routingSignals = pgTable(
  "routing_signals",
  {
    taskType: text("task_type").notNull(),
    lane: text("lane").notNull(),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    windowEnd: bigint("window_end", { mode: "number" }).notNull(),
    samples: integer("samples").notNull(),
    successRate: doublePrecision("success_rate").notNull(),
    fallbackRate: doublePrecision("fallback_rate").notNull(), // EXECUTION fallback (in-chain swap)
    classifierFallbackRate: doublePrecision("classifier_fallback_rate").notNull(), // CLASSIFICATION fallback
    errorRate: doublePrecision("error_rate").notNull(),
    p50LatencyMs: doublePrecision("p50_latency_ms").notNull(),
    p95LatencyMs: doublePrecision("p95_latency_ms").notNull(),
    avgCostUsd: doublePrecision("avg_cost_usd"), // nullable
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskType, t.lane] })],
);

// Memory middleware tables (docs/08). Deliberately ISOLATED from routing/key
// tables; memory_messages references memory_threads ONLY. source_message_range
// and tags are jsonb (native) so compressed observations stay auditable.
export const memoryThreads = pgTable("memory_threads", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  ownerId: text("owner_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const memoryMessages = pgTable("memory_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(), // references memory_threads.id only
  role: text("role").notNull(), // 'user' | 'assistant' | 'tool' (IR-aligned)
  content: text("content").notNull(),
  tokenEstimate: integer("token_estimate").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const memoryObservations = pgTable("memory_observations", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  sourceMessageRange: jsonb("source_message_range").$type<[string, string]>().notNull(),
  observationText: text("observation_text").notNull(),
  observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  referencedAt: bigint("referenced_at", { mode: "number" }), // nullable
  priority: integer("priority"), // nullable
  tags: jsonb("tags").$type<string[]>(), // nullable native array
});

export const memoryReflections = pgTable("memory_reflections", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  threadId: text("thread_id"),
  reflectionText: text("reflection_text").notNull(),
  version: integer("version").notNull(),
  tokenEstimate: integer("token_estimate").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const memoryJobs = pgTable("memory_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  scopeId: text("scope_id").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Optional config persistence (admin write-back; ConfigStore port). key/value
// text — yaml-first, this is reserved for runtime overrides.
export const configKv = pgTable("config_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Full request/response body capture (admin "System Settings" → capture_payloads).
// SEPARATE from telemetry so it prunes independently (payload_retention_days) and
// never bloats the decision JSON. NOT redacted — verbatim client request +
// assembled response; holds NO plaintext key (bearer is an HTTP header, not body).
// Stored as TEXT (not jsonb) to round-trip the exact bytes the client/provider
// sent. createdAt is epoch-ms bigint to match the sqlite value space.
export const requestPayloads = pgTable("request_payloads", {
  requestId: text("request_id").primaryKey(),
  requestJson: text("request_json").notNull(),
  responseJson: text("response_json"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Persisted OAuth subscription credentials (issue #38) — the pg mirror of the
// sqlite oauth_tokens table. access_enc/refresh_enc are AES-256-GCM CIPHERTEXT
// (TEXT, not jsonb — opaque bytes), the only reversibly-stored secrets in Helm.
// updated_at/expires_at are epoch-ms bigint to match the sqlite value space.
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    accessEnc: text("access_enc"),
    refreshEnc: text("refresh_enc"),
    expiresAt: bigint("expires_at", { mode: "number" }), // ms epoch; nullable
    meta: text("meta"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account] })],
);

// Per-account OAuth subscription USAGE aggregate (providers page Tier 2) — pg
// mirror of the sqlite oauth_usage table. Additive daily counters per
// (provider_id, account, day); day = UTC-midnight epoch ms (bigint). cost_usd
// double precision nullable (flat-rate plans report no cost). Pure aggregate
// observability — no key/payload column (principle 7).
export const oauthUsage = pgTable(
  "oauth_usage",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    day: bigint("day", { mode: "number" }).notNull(), // UTC-midnight epoch ms
    requests: integer("requests").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull(),
    costUsd: doublePrecision("cost_usd"), // nullable; summed completion cost
    firstSeenMs: bigint("first_seen_ms", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account, t.day] })],
);

// Per-account OAuth subscription QUOTA snapshot (providers page Tier 3) — pg
// mirror of the sqlite oauth_quota table. windows stored as jsonb (native);
// latest-wins upsert per (provider_id, account). No secret column.
export const oauthQuota = pgTable(
  "oauth_quota",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    windows: jsonb("windows").$type<unknown[]>().notNull(), // OAuthQuotaWindow[]
    capturedAt: bigint("captured_at", { mode: "number" }).notNull(),
    source: text("source").notNull(), // 'anthropic' | 'codex' | 'codex-headers'
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
export type MemoryThreadsTable = typeof memoryThreads;
export type MemoryMessagesTable = typeof memoryMessages;
export type MemoryObservationsTable = typeof memoryObservations;
export type MemoryReflectionsTable = typeof memoryReflections;
export type MemoryJobsTable = typeof memoryJobs;
export type ConfigKvTable = typeof configKv;
export type RequestPayloadsTable = typeof requestPayloads;
export type OAuthTokensTable = typeof oauthTokens;
