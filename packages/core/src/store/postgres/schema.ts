import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Postgres BYTEA — drizzle 0.45 has no built-in `bytea`, so define it once here.
// Maps to the JS Buffer the pg/pglite driver returns for a bytea column; the
// adapter writes Buffer.from(bytes) and reads a Buffer straight back.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Postgres (Drizzle pg-core) table definitions for the supabase Store adapter.
// Same LOGICAL schema as the sqlite adapter (packages/core/src/store/sqlite/
// schema.ts) — supabase == hosted Postgres — but expressed with native pg types:
// real booleans, jsonb for arrays/objects, double precision for fractional
// counters. Dialect quirks are encapsulated HERE so core and the sqlite adapter
// never see them (CLAUDE.md "DB abstraction layer"). Epoch-millisecond timestamps are stored
// as bigint (mode: "number") so the value space matches the sqlite timestamp_ms
// columns exactly and the port contract is byte-for-byte identical across
// drivers. Per principle 7: NO plaintext column anywhere — only hash + prefix,
// plus optional encrypted recovery material for the admin reveal path.

export const apiKeys = pgTable("api_keys", {
  keyId: text("key_id").primaryKey(),
  hash: text("hash").notNull().unique(), // sha256(plaintext); getByHash uses the unique index
  prefix: text("prefix").notNull(), // helm_live_xxxx — display/debug only
  secretEnc: text("secret_enc"), // encrypted full key for admin recovery; never plaintext
  accountId: text("account_id").notNull(),
  role: text("role").notNull(), // 'root' | 'user'
  name: text("name"), // human-readable label; NULL = unnamed (cosmetic only)
  allowedLanes: jsonb("allowed_lanes").$type<string[]>(), // native jsonb array
  allowCustomModel: boolean("allow_custom_model").notNull().default(false),
  allowFastMode: boolean("allow_fast_mode").notNull().default(false),
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
  // Max in-flight requests for this key (issue #93). NULL = unlimited (0 is not
  // a sentinel — mirrors the budget convention, not the rate-limit one).
  concurrencyLimit: integer("concurrency_limit"),
  // Per-key memory defaults (issue #97). mode/source are text enums with the
  // fail-safe defaults (off / header); project NULL = none.
  memoryMode: text("memory_mode").notNull().default("off"),
  memoryProjectId: text("memory_project_id"),
  memoryThreadSource: text("memory_thread_source").notNull().default("header"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // epoch ms
});

export const telemetry = pgTable("telemetry", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  apiKeyId: text("api_key_id").notNull(), // key_id only — never hash/plaintext
  decisionJson: jsonb("decision_json").notNull(), // redacted DecisionRecord (native jsonb)
  finalStatus: text("final_status"),
  costUsd: doublePrecision("cost_usd"), // nullable; summed attempt cost
  // Dashboard accounting: denormalized latency (pg migration v31), token counts
  // (pg migration v21) + served model for cheap SQL aggregation. Nullable
  // integers; NULL = pre-feature row / usage not measured.
  latencyTotalMs: integer("latency_total_ms"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedTokens: integer("cached_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),
  servedModel: text("served_model"),
  // Served-stream generation window in ms (pg migration v24) — mirror of the sqlite
  // v25 column. NULL = non-streaming / pre-feature row; counts toward the dashboard
  // avg TPS only when > 0. Denormalized from DecisionRecord.generation_ms.
  generationMs: integer("generation_ms"),
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
  // Alias of the model that served the thread's latest turn (pg v19). Stamped
  // best-effort by observeOutbound; read by the background observer to price
  // the auto-compaction ledger. NULL = never stamped.
  lastServedModel: text("last_served_model"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const memoryMessages = pgTable(
  "memory_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(), // references memory_threads.id only
    role: text("role").notNull(), // 'user' | 'assistant' | 'tool' (IR-aligned)
    content: text("content").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // Stable client-transcript position. This keeps repeated text at different
    // positions distinct while still making re-sent history idempotent.
    messageIndex: integer("message_index"),
    // Idempotency key (pg v20): sha256(content) hex, NO normalization. pg mirror
    // of the sqlite v21 dedup column — UNIQUE(thread_id, message_index, role,
    // content_hash) + ON CONFLICT DO NOTHING collapses the re-sent transcript to a
    // no-op. hash (not raw content) because a pg btree index row is capped at
    // ~2704 bytes.
    contentHash: text("content_hash"),
  },
  (t) => [
    uniqueIndex("uniq_memory_messages_thread_idx_role_hash").on(
      t.threadId,
      t.messageIndex,
      t.role,
      t.contentHash,
    ),
  ],
);

export const memoryObservations = pgTable("memory_observations", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  sourceMessageRange: jsonb("source_message_range").$type<[string, string]>().notNull(),
  observationText: text("observation_text").notNull(),
  observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  referencedAt: bigint("referenced_at", { mode: "number" }), // nullable
  priority: integer("priority"), // nullable
  tags: jsonb("tags").$type<string[]>(), // nullable native array
  // Forgetting-score columns (docs/12 "Schema deltas", pg v17) — pg mirror of the
  // sqlite v18 delta. importance is double precision; epoch-ms stamps are bigint.
  referenceCount: integer("reference_count").notNull().default(0),
  importance: doublePrecision("importance").notNull().default(0.5),
  status: text("status").notNull().default("active"), // active | archived
  archivedAt: bigint("archived_at", { mode: "number" }), // nullable
  expiredAt: bigint("expired_at", { mode: "number" }), // nullable
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
  // Forgetting deltas (docs/12 pg v17): reference tracking + visibility only.
  referencedAt: bigint("referenced_at", { mode: "number" }), // nullable
  referenceCount: integer("reference_count").notNull().default(0),
  status: text("status").notNull().default("active"),
});

// docs/12 "Schema deltas" — memory_facts long tier (pg mirror of sqlite). owner_id
// (= accountId) is the TENANT BOUNDARY (a fact may have a null thread_id);
// project/resource/thread are in-account scopes and may be null. The
// account-scoped dedup index UNIQUE(owner_id, content_hash) is declared in the
// migration. source_observation_range is jsonb (native) for the [first,last] tuple.
export const memoryFacts = pgTable("memory_facts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(), // accountId — the tenant boundary
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  threadId: text("thread_id"),
  subjectKey: text("subject_key").notNull(),
  factText: text("fact_text").notNull(),
  contentHash: text("content_hash").notNull(), // sha256(normalized_text)
  importance: doublePrecision("importance").notNull().default(0.5),
  referenceCount: integer("reference_count").notNull().default(0),
  referencedAt: bigint("referenced_at", { mode: "number" }), // nullable
  validFrom: bigint("valid_from", { mode: "number" }).notNull(),
  invalidAt: bigint("invalid_at", { mode: "number" }), // nullable
  expiredAt: bigint("expired_at", { mode: "number" }), // nullable
  status: text("status").notNull().default("active"),
  sourceObservationRange: jsonb("source_observation_range").$type<[string, string]>(), // nullable
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
  // EXACT body forwarded upstream (post memory-inject + protocol-translation). NULL
  // when capture off / no provider served / pre-feature row. NO plaintext key.
  upstreamRequestJson: text("upstream_request_json"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Content-addressed store for base64 images pulled OUT of request_payloads
// (store/payload-blobs.ts) — pg mirror of the sqlite payload_blobs table. Claude
// Code re-sends every image on every turn, so the same bytes recur across many
// rows (and twice within one row: client + upstream); keying by sha256 of the
// DECODED bytes stores each image ONCE. bytes is BYTEA (the only binary column in
// the pg schema). created_at is TOUCHED on every re-reference, so a still-in-use
// image is never pruned out from under a live payload row (prune uses the same
// retention cutoff as the payloads). Unlike sqlite, the slimmed request_payloads
// text is NOT gzipped — pg's TOAST auto-compresses large text values.
export const payloadBlobs = pgTable("payload_blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: bytea("bytes").notNull(), // decoded binary (NOT base64)
  mime: text("mime"),
  size: integer("size").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // epoch ms
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
// mirror of the sqlite oauth_usage table. Additive counters per (provider_id,
// account, bucket_ms); bucket_ms = UTC-HOUR floor epoch ms (bigint) — hour
// granularity so the providers page rolls usage up by the ADMIN's LOCAL day at read
// time (the gateway is tz-agnostic at write time). cost_usd double precision
// nullable (flat-rate plans report no cost). Pure aggregate observability — no
// key/payload column (principle 7).
export const oauthUsage = pgTable(
  "oauth_usage",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    bucketMs: bigint("bucket_ms", { mode: "number" }).notNull(), // UTC-hour floor epoch ms
    requests: integer("requests").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull(),
    costUsd: doublePrecision("cost_usd"), // nullable; summed completion cost
    firstSeenMs: bigint("first_seen_ms", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account, t.bucketMs] })],
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
    // Auto-park cooldown: epoch ms until which the account is removed from the
    // scheduling pool (null = not limited). Runtime twin of `windows`; the "Reset
    // usage" action sets it back to null.
    usageLimitedUntilMs: bigint("usage_limited_until_ms", { mode: "number" }), // nullable
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
export type MemoryFactsTable = typeof memoryFacts;
export type MemoryJobsTable = typeof memoryJobs;
export type ConfigKvTable = typeof configKv;
export type RequestPayloadsTable = typeof requestPayloads;
export type PayloadBlobsTable = typeof payloadBlobs;
export type OAuthTokensTable = typeof oauthTokens;
