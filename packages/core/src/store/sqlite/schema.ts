import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// SQLite (Drizzle) table definitions for the sqlite Store adapter. Columns align
// with docs/06 (api_keys) and docs/02 (telemetry / decision record). Dialect
// quirks (no native boolean/array) are encapsulated HERE — core and the supabase
// adapter never see them. Per CLAUDE.md principle 7: NO plaintext column; auth
// keys keep hash + prefix, with optional encrypted recovery material for the admin
// reveal path. Telemetry stores a redacted decision JSON, no plaintext payload.

export const apiKeys = sqliteTable("api_keys", {
  keyId: text("key_id").primaryKey(),
  hash: text("hash").notNull().unique(), // sha256(plaintext); getByHash uses the unique index
  prefix: text("prefix").notNull(), // helm_live_xxxx — display/debug only
  secretEnc: text("secret_enc"), // encrypted full key for admin recovery; never plaintext
  accountId: text("account_id").notNull(),
  role: text("role").notNull(), // 'root' | 'user'
  name: text("name"), // human-readable label; NULL = unnamed (cosmetic only)
  allowedLanes: text("allowed_lanes"), // JSON text array (SQLite has no native array)
  allowCustomModel: integer("allow_custom_model", { mode: "boolean" }) // SQLite has no native boolean
    .notNull()
    .default(false),
  blockedModels: text("blocked_models"), // JSON text array of model blacklist patterns; NULL = none
  allowFastMode: integer("allow_fast_mode", { mode: "boolean" }).notNull().default(false),
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
  // Max in-flight requests for this key (issue #93). NULL = unlimited (0 is not
  // a sentinel — mirrors the budget convention, not the rate-limit one).
  concurrencyLimit: integer("concurrency_limit"),
  // Per-key memory defaults (issue #97). mode/source are text enums with the
  // fail-safe defaults (off / header); project NULL = none.
  memoryMode: text("memory_mode").notNull().default("off"),
  memoryProjectId: text("memory_project_id"),
  memoryThreadSource: text("memory_thread_source").notNull().default("header"),
  requestContentMode: text("request_content_mode"),
  // Per-key ceiling on client-requested reasoning effort. NULL = no cap.
  maxReasoningEffort: text("max_reasoning_effort"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const telemetry = sqliteTable("telemetry", {
  id: text("id").primaryKey(), // self-generated id
  requestId: text("request_id").notNull().unique(),
  apiKeyId: text("api_key_id").notNull(), // key_id only — never hash/plaintext
  decisionJson: text("decision_json").notNull(), // JSON.stringify(DecisionRecord), redacted
  finalStatus: text("final_status"), // denormalized final.status for querying
  costUsd: real("cost_usd"), // nullable; REAL mirrors pg doublePrecision (no truncation)
  // Dashboard accounting: denormalized latency (migration v32), token counts
  // (migration v22) + served model for cheap SQL aggregation on the admin
  // homepage. Nullable — NULL = pre-feature row / usage not measured.
  latencyTotalMs: integer("latency_total_ms"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedTokens: integer("cached_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),
  servedModel: text("served_model"),
  // Served-stream generation window in ms (migration v25): the true-TPS denominator,
  // denormalized from DecisionRecord.generation_ms for cheap SUM aggregation. NULL =
  // non-streaming / pre-feature row (forward-only, no backfill); a row counts toward
  // the dashboard avg TPS only when this is > 0.
  generationMs: integer("generation_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    sessionRef: text("session_ref").primaryKey(),
    accountId: text("account_id").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    source: text("source").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    headRequestId: text("head_request_id"),
    revisionCount: integer("revision_count").notNull().default(0),
    storedBytes: integer("stored_bytes").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uniq_sessions_owner_source_external").on(
      t.accountId,
      t.apiKeyId,
      t.source,
      t.externalSessionId,
    ),
    index("idx_sessions_last_seen_at").on(t.lastSeenAt),
  ],
);

export const sessionRevisions = sqliteTable(
  "session_revisions",
  {
    requestId: text("request_id").primaryKey(),
    sessionRef: text("session_ref")
      .notNull()
      .references(() => sessions.sessionRef, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    parentRequestId: text("parent_request_id"),
    retainCount: integer("retain_count").notNull(),
    requestDeltaJson: text("request_delta_json").notNull(),
    requestEnvelopeJson: text("request_envelope_json").notNull(),
    bodyBytes: integer("body_bytes"),
    requestBodyGeneration: text("request_body_generation"),
    responseBodyGeneration: text("response_body_generation"),
    responseId: text("response_id"),
    responseJson: text("response_json"),
    fidelity: text("fidelity").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uniq_session_revisions_sequence").on(t.sessionRef, t.sequence),
    uniqueIndex("uniq_session_revisions_response").on(t.sessionRef, t.responseId),
    index("idx_session_revisions_session_created").on(t.sessionRef, t.createdAt),
  ],
);

export const sessionHeadEventHashes = sqliteTable("session_head_event_hashes", {
  sessionRef: text("session_ref")
    .primaryKey()
    .references(() => sessions.sessionRef, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  eventKey: text("event_key").notNull(),
  eventCount: integer("event_count").notNull(),
  eventHash: text("event_hash").notNull(),
});

export const sessionRevisionBodyChunks = sqliteTable(
  "session_revision_body_chunks",
  {
    requestId: text("request_id").notNull(),
    generation: text("generation").notNull(),
    part: text("part").$type<"request_delta" | "request_envelope" | "response">().notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    codec: text("codec").$type<"gzip" | "raw">().notNull(),
    rawBytes: integer("raw_bytes").notNull(),
    bytes: blob("bytes").$type<Buffer>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.generation, t.part, t.chunkIndex] }),
    index("idx_session_revision_body_chunks_created").on(t.createdAt),
  ],
);

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
// nullable. Written ASYNCHRONOUSLY by the background collector. The opt-in
// routing feedback path reads only these aggregates and fails open on storage
// errors.
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

export const responsesRegistry = sqliteTable(
  "responses_registry",
  {
    responseId: text("response_id").primaryKey(),
    accountId: text("account_id").notNull(),
    keyId: text("key_id").notNull(),
    providerAlias: text("provider_alias"),
    providerName: text("provider_name"),
    providerModel: text("provider_model"),
    providerProtocol: text("provider_protocol"),
    providerAccount: text("provider_account"),
    selectedLane: text("selected_lane"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    index("idx_responses_registry_expires_at").on(table.expiresAt),
    index("idx_responses_registry_created_id").on(table.createdAt, table.responseId),
  ],
);

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
  // EXACT body forwarded upstream (post memory-inject + protocol-translation). NULL
  // when capture off / no provider served / pre-feature row. NO plaintext key.
  upstreamRequestJson: text("upstream_request_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Content-addressed store for base64 images pulled OUT of request_payloads
// (store/payload-blobs.ts). Claude Code re-sends every image on every turn, so the
// same bytes recur across many rows (and twice within one row: client + upstream);
// keying by sha256 of the DECODED bytes stores each image ONCE. created_at is
// TOUCHED on every re-reference, so a still-in-use image is never pruned out from
// under a live payload row (prune uses the same retention cutoff as the payloads).
export const payloadBlobs = sqliteTable("payload_blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: blob("bytes").notNull(), // decoded binary (NOT base64)
  mime: text("mime"),
  size: integer("size").notNull(),
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
// per (provider_id, account, bucket_ms) — bucket_ms = UTC-HOUR floor epoch ms. Hour
// granularity (not day) so the providers page can roll usage up by the ADMIN's
// LOCAL day at read time (the gateway is tz-agnostic at write time). Additive
// counters (requests / tokens) + a nullable summed cost (REAL; flat-rate plans
// report no cost → stays NULL). first_seen_ms anchors the daily-average RPM
// derivation. NO key/payload column (principle 7); pure aggregate observability.
export const oauthUsage = sqliteTable(
  "oauth_usage",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    bucketMs: integer("bucket_ms").notNull(), // UTC-hour floor epoch ms
    requests: integer("requests").notNull(),
    tokens: integer("tokens").notNull(),
    costUsd: real("cost_usd"), // nullable; summed completion cost
    firstSeenMs: integer("first_seen_ms").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account, t.bucketMs] })],
);

// Per-account OAuth subscription QUOTA snapshot (providers page Tier 3). One row
// per (provider_id, account): the LATEST rate-limit window snapshot. `windows` is
// a JSON-text array of { key, usedPercent, resetsAtMs, windowMinutes } (SQLite has
// no native array). `source` = how it was captured (anthropic pull / codex pull /
// codex-headers push). Latest-wins upsert; no history. Pure observability — no secret column.
export const oauthQuota = sqliteTable(
  "oauth_quota",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    windows: text("windows").notNull(), // JSON text: OAuthQuotaWindow[]
    capturedAt: integer("captured_at").notNull(),
    source: text("source").notNull(), // 'anthropic' | 'xai' | 'codex' | 'codex-headers'
    // Auto-park cooldown: epoch ms until which the account is removed from the
    // scheduling pool (null = not limited). The runtime twin of `windows` — the
    // scheduler gates on it; the "Reset usage" action sets it back to null.
    usageLimitedUntilMs: integer("usage_limited_until_ms"), // nullable
    // Codex only: available rate-limit reset credits captured from the usage PULL.
    resetCredits: integer("reset_credits"), // nullable
    // Codex only: JSON blob of the live metadata folded onto the Admin quota
    // response (planType, credits, resetCreditDetails, individualLimit,
    // additionalLimits, rateLimitReachedType). Persisted so the providers page
    // renders the full card after a restart instead of waiting for a refresh.
    metadata: text("metadata"), // nullable JSON text
  },
  (t) => [primaryKey({ columns: [t.providerId, t.account] })],
);

// Per-account RESET-PERIOD boundaries — the history the latest-wins oauth_quota
// snapshot lacks. Exact observations and explicitly marked public-announcement
// estimates share the table. Pure observability, no secret column (principle 7).
export const oauthResetPeriod = sqliteTable(
  "oauth_reset_period",
  {
    providerId: text("provider_id").notNull(),
    account: text("account").notNull(),
    windowKey: text("window_key").notNull(), // '5h' | '7d' | 'primary' | ...
    periodStartMs: integer("period_start_ms").notNull(), // prior resetsAtMs
    periodEndMs: integer("period_end_ms").notNull(), // new resetsAtMs
    detectedAtMs: integer("detected_at_ms").notNull(), // when the refresh saw it
    approximate: integer("approximate", { mode: "boolean" }).notNull().default(false),
  },
  // PK on (provider, account, window, start) makes re-detection idempotent — the same
  // reset seen by repeated refreshes folds to one row.
  (t) => [primaryKey({ columns: [t.providerId, t.account, t.windowKey, t.periodStartMs] })],
);

export type ApiKeysTable = typeof apiKeys;
export type TelemetryTable = typeof telemetry;
export type OAuthUsageTable = typeof oauthUsage;
export type OAuthQuotaTable = typeof oauthQuota;
export type OAuthResetPeriodTable = typeof oauthResetPeriod;
export type RateLimitBucketsTable = typeof rateLimitBuckets;
export type UsageBudgetBucketsTable = typeof usageBudgetBuckets;
export type RoutingSignalsTable = typeof routingSignals;
export type ConfigKvTable = typeof configKv;
export type ResponsesRegistryTable = typeof responsesRegistry;
export type RequestPayloadsTable = typeof requestPayloads;
export type OAuthTokensTable = typeof oauthTokens;
