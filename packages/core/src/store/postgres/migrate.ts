import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Schema = typeof schema;

// A drizzle Postgres handle bound to our schema, plus a `$close` lifecycle hook.
// supabase == hosted Postgres, reached via postgres-js; the SAME adapters run
// against an in-process PGlite database in tests (the pg dialect is identical, so
// pglite validates the supabase path without a server). Both drivers expose the
// async drizzle query builder + `.execute(sql)`, so the adapters and migrations
// are written ONCE against this union type and never branch on the driver.
export type PgDb = (PgliteDatabase<Schema> | PostgresJsDatabase<Schema>) & {
  readonly $close: () => Promise<void>;
};

// Checked-in DDL for the Postgres dialect — the pg equivalent of the sqlite
// migrations. Each statement is idempotent (IF NOT EXISTS) so re-running is safe;
// a `_migrations` ledger records applied versions the same way the sqlite adapter
// does. Epoch-ms timestamps are BIGINT to match the sqlite timestamp_ms value
// space exactly. NO plaintext column anywhere (principle 7).
interface Migration {
  readonly version: number;
  readonly sql: string;
}

// Session-level pg advisory lock for startup migrations. Two 32-bit keys spell
// "HELM" and "API\0"; using the two-key form keeps the constants inside pg int4.
const PG_MIGRATION_LOCK_SQL = "SELECT pg_advisory_lock(1212501069, 1095780608)";
const PG_MIGRATION_UNLOCK_SQL = "SELECT pg_advisory_unlock(1212501069, 1095780608)";

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        max_lane TEXT,
        allowed_lanes JSONB,
        allow_custom_model BOOLEAN NOT NULL DEFAULT FALSE,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        api_key_id TEXT NOT NULL,
        decision_json JSONB NOT NULL,
        final_status TEXT,
        cost_usd DOUBLE PRECISION,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry (created_at DESC);
    `,
  },
  {
    // Memory middleware tables (docs/08). ISOLATED from routing/key tables.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        owner_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES memory_threads (id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        message_index INTEGER,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_observations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES memory_threads (id),
        source_message_range JSONB NOT NULL,
        observation_text TEXT NOT NULL,
        observed_at BIGINT NOT NULL,
        referenced_at BIGINT,
        priority INTEGER,
        tags JSONB
      );

      CREATE TABLE IF NOT EXISTS memory_reflections (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        thread_id TEXT,
        reflection_text TEXT NOT NULL,
        version INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_messages_thread ON memory_messages (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_observations_thread ON memory_observations (thread_id, observed_at);
    `,
  },
  {
    // Per-key rate-limit token buckets (docs/06). tokens is DOUBLE PRECISION so
    // fractional refill survives reads. key_id only — never plaintext (principle 7).
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        tokens DOUBLE PRECISION NOT NULL,
        last_refill_ms BIGINT NOT NULL,
        PRIMARY KEY (key_id, dim)
      );
    `,
  },
  {
    // Agentic Signals (POST-MVP; docs/02). PRIMARY KEY (task_type, lane) makes
    // upsert idempotent so re-collecting a window never double-counts. NO
    // key/payload column (principle 7); only aggregate dimensions.
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS routing_signals (
        task_type TEXT NOT NULL,
        lane TEXT NOT NULL,
        window_start BIGINT NOT NULL,
        window_end BIGINT NOT NULL,
        samples INTEGER NOT NULL,
        success_rate DOUBLE PRECISION NOT NULL,
        fallback_rate DOUBLE PRECISION NOT NULL,
        classifier_fallback_rate DOUBLE PRECISION NOT NULL,
        error_rate DOUBLE PRECISION NOT NULL,
        p50_latency_ms DOUBLE PRECISION NOT NULL,
        p95_latency_ms DOUBLE PRECISION NOT NULL,
        avg_cost_usd DOUBLE PRECISION,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (task_type, lane)
      );
    `,
  },
  {
    // Optional config key/value persistence (ConfigStore port; admin write-back).
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS config_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Full request/response body capture (admin "System Settings" →
    // capture_payloads). SEPARATE from telemetry so it prunes independently
    // (payload_retention_days). NOT redacted — verbatim request + assembled
    // response; NO plaintext key (bearer is an HTTP header, not body). Stored as
    // TEXT to round-trip exact bytes. created_at BIGINT epoch-ms matches sqlite.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS request_payloads (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        response_json TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_payloads_created_at ON request_payloads (created_at);
    `,
  },
  {
    // Per-key rate-limit OVERRIDE columns on api_keys (docs/06 "rate limits & quotas"). Two
    // nullable integer columns: NULL = inherit the system default at check time;
    // a value (0 = unlimited) overrides that one dimension for this key. Additive
    // — existing rows get NULL and keep inheriting the default. Mirrors the sqlite
    // v8 migration (different ledger, same logical change). Distinct from
    // rate_limit_buckets (v3, the runtime counters); these are config.
    version: 7,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpm INTEGER;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_tpm INTEGER;
    `,
  },
  {
    // Persisted OAuth subscription credentials (issue #38) — pg mirror of the
    // sqlite v9 migration (different ledger, same logical change). access_enc/
    // refresh_enc are AES-256-GCM CIPHERTEXT (TEXT). Composite PK makes the
    // rotation write-back idempotent. epoch-ms bigint matches sqlite.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        access_enc TEXT,
        refresh_enc TEXT,
        expires_at BIGINT,
        meta TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (provider_id, account)
      );
    `,
  },
  {
    // Retire the per-key max_lane CEILING — pg mirror of the sqlite v10 migration
    // (different ledger, same logical change). Lanes are parallel, not a strict
    // hierarchy, so the ceiling was fully subsumed by the allowed_lanes whitelist.
    // IF EXISTS keeps the drop idempotent across hand-patched databases.
    version: 9,
    sql: `
      ALTER TABLE api_keys DROP COLUMN IF EXISTS max_lane;
    `,
  },
  {
    // Per-key USAGE BUDGETS (docs/06) — pg mirror of the sqlite v11 migration. Six
    // budget config columns on api_keys (IF NOT EXISTS = idempotent) + the
    // usage_budget_buckets counter table. Spend is DOUBLE PRECISION; tokens double
    // precision (may go negative — soft cap settled post-served). key_id only.
    version: 10,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_requests INTEGER;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_tokens INTEGER;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_spend_usd DOUBLE PRECISION;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_window_seconds INTEGER;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS over_budget_behavior TEXT NOT NULL DEFAULT 'degrade';
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS degrade_lane TEXT;

      CREATE TABLE IF NOT EXISTS usage_budget_buckets (
        key_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        tokens DOUBLE PRECISION NOT NULL,
        last_refill_ms BIGINT NOT NULL,
        PRIMARY KEY (key_id, dim)
      );
    `,
  },
  {
    // Per-account OAuth subscription USAGE + QUOTA observability (providers page)
    // — pg mirror of the sqlite v12 migration (different ledger, same logical
    // change). oauth_usage: additive daily aggregate per (provider_id, account,
    // day). oauth_quota: latest window snapshot per (provider_id, account), windows
    // as jsonb. Pure aggregate observability — no key/payload column (principle 7).
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_usage (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        day BIGINT NOT NULL,
        requests INTEGER NOT NULL,
        tokens BIGINT NOT NULL,
        cost_usd DOUBLE PRECISION,
        first_seen_ms BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (provider_id, account, day)
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_usage_day ON oauth_usage (day);

      CREATE TABLE IF NOT EXISTS oauth_quota (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        windows JSONB NOT NULL,
        captured_at BIGINT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (provider_id, account)
      );
    `,
  },
  {
    // Per-key max in-flight requests (issue #93) — pg mirror of the sqlite v13
    // migration. Additive — existing rows get NULL (= unlimited; 0 is not a
    // sentinel). The in-flight counter is process memory; only the limit persists.
    version: 12,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS concurrency_limit INTEGER;
    `,
  },
  {
    // Memory job queue scan index (docs/08 Phase 2). The unique open-job
    // boundary is added in v15 after cleanup, so old duplicate open rows cannot
    // make first-time upgrades fail before the cleanup migration runs. Mirrors
    // sqlite v14 (different ledger, same logical change).
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_type_scope_status
        ON memory_jobs (type, scope_id, status);
    `,
  },
  {
    // Bind memory_reflections to the authenticated account owner so project or
    // resource ids reused by another account cannot read long-lived memory.
    version: 14,
    sql: `
      ALTER TABLE memory_reflections ADD COLUMN IF NOT EXISTS owner_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_memory_reflections_owner_scope
        ON memory_reflections (owner_id, project_id, resource_id, thread_id, version DESC);
    `,
  },
  {
    // DB-level open-job dedupe boundary. The original v13 scan index was non-unique;
    // this additive migration makes concurrent enqueueJob calls collapse atomically.
    version: 15,
    sql: `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY type, scope_id
            ORDER BY created_at ASC, id ASC
          ) AS rn
        FROM memory_jobs
        WHERE status IN ('pending', 'running')
      )
      UPDATE memory_jobs
      SET status = 'failed',
          error = CONCAT_WS(E'\n', NULLIF(error, ''), 'migration cleanup: closed duplicate open memory job before uniq_memory_jobs_open_type_scope'),
          updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      FROM ranked
      WHERE memory_jobs.id = ranked.id
        AND ranked.rn > 1;

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_jobs_open_type_scope
        ON memory_jobs (type, scope_id)
        WHERE status IN ('pending', 'running');
    `,
  },
  {
    // Per-key MEMORY DEFAULTS (issue #97) — pg mirror of the sqlite v17 migration
    // (different ledger, same logical change). Additive with fail-safe defaults.
    version: 16,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS memory_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS memory_project_id TEXT;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS memory_thread_source TEXT NOT NULL DEFAULT 'header';
    `,
  },
  {
    // Memory FORGETTING & TIERING schema deltas (docs/12 "Schema deltas") — pg
    // mirror of the sqlite v18 migration (different ledger, same logical change;
    // dialect differences sealed in the adapter per CLAUDE.md). All additive,
    // IF NOT EXISTS = idempotent. memory_observations gets the forgetting-score
    // columns (referenced_at already exists from v2 and is reused);
    // memory_reflections gets reference tracking + visibility only. memory_facts
    // is the new account-scoped long-tier table: owner_id (= accountId) is the
    // tenant boundary (a fact may have a null thread_id), and the content_hash
    // dedup index is ACCOUNT-scoped (UNIQUE(owner_id, content_hash)), never
    // global. Epoch-ms timestamps are BIGINT to match the sqlite value space.
    version: 17,
    sql: `
      ALTER TABLE memory_observations ADD COLUMN IF NOT EXISTS reference_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_observations ADD COLUMN IF NOT EXISTS importance      DOUBLE PRECISION NOT NULL DEFAULT 0.5;
      ALTER TABLE memory_observations ADD COLUMN IF NOT EXISTS status          TEXT    NOT NULL DEFAULT 'active';
      ALTER TABLE memory_observations ADD COLUMN IF NOT EXISTS archived_at     BIGINT;
      ALTER TABLE memory_observations ADD COLUMN IF NOT EXISTS expired_at      BIGINT;

      ALTER TABLE memory_reflections ADD COLUMN IF NOT EXISTS referenced_at   BIGINT;
      ALTER TABLE memory_reflections ADD COLUMN IF NOT EXISTS reference_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_reflections ADD COLUMN IF NOT EXISTS status          TEXT    NOT NULL DEFAULT 'active';

      CREATE TABLE IF NOT EXISTS memory_facts (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT    NOT NULL,
        project_id    TEXT,
        resource_id   TEXT,
        thread_id     TEXT,
        subject_key   TEXT    NOT NULL,
        fact_text     TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        importance    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        reference_count INTEGER NOT NULL DEFAULT 0,
        referenced_at BIGINT,
        valid_from    BIGINT  NOT NULL,
        invalid_at    BIGINT,
        expired_at    BIGINT,
        status        TEXT    NOT NULL DEFAULT 'active',
        source_observation_range JSONB,
        created_at    BIGINT  NOT NULL,
        updated_at    BIGINT  NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_hash    ON memory_facts (owner_id, content_hash);
      CREATE INDEX        IF NOT EXISTS idx_memory_facts_subject ON memory_facts (owner_id, project_id, resource_id, thread_id, subject_key);
      CREATE INDEX        IF NOT EXISTS idx_memory_facts_active  ON memory_facts (owner_id, status, expired_at);
    `,
  },
  {
    // Per-key human-readable NAME — pg mirror of the sqlite v19 migration (different
    // ledger, same logical change). Additive + nullable, IF NOT EXISTS = idempotent
    // (NULL = unnamed). Cosmetic label only, never an auth/routing input.
    version: 18,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name TEXT;
    `,
  },
  {
    // Auto-compaction model→price resolution — pg mirror of the sqlite v20
    // migration. The alias of the model that served the thread's latest turn,
    // stamped best-effort by observeOutbound and read by the background observer
    // to price the compaction ledger. Additive + nullable + idempotent.
    version: 19,
    sql: `
      ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS last_served_model TEXT;
    `,
  },
  {
    // Idempotent memory-message ingest — pg mirror of the sqlite v21 fix.
    // Historical rows lack transcript positions, so repeated content is preserved:
    // without an occurrence key, duplicate ingest is indistinguishable from a user
    // legitimately repeating the same turn later in the transcript. Only rows that
    // already have a complete occurrence key are deduped before the unique index
    // is created. The pg ops script backfills message_index + content_hash and
    // wipes stale observations.
    version: 20,
    sql: `
      ALTER TABLE memory_messages ADD COLUMN IF NOT EXISTS message_index INTEGER;

      ALTER TABLE memory_messages ADD COLUMN IF NOT EXISTS content_hash TEXT;

      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY thread_id, message_index, role, content_hash
                 ORDER BY created_at ASC, id ASC
               ) AS rn
        FROM memory_messages
        WHERE message_index IS NOT NULL
          AND content_hash IS NOT NULL
      )
      DELETE FROM memory_messages
      USING ranked
      WHERE memory_messages.id = ranked.id AND ranked.rn > 1;

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_messages_thread_idx_role_hash
        ON memory_messages (thread_id, message_index, role, content_hash);
    `,
  },
  {
    // Dashboard token accounting — pg mirror of the sqlite v22 migration.
    // Denormalized served-completion token counts + served model on telemetry for
    // cheap SQL aggregation. Additive + nullable + idempotent (IF NOT EXISTS);
    // forward-only — legacy rows stay NULL.
    version: 21,
    sql: `
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS cached_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS served_model TEXT;
    `,
  },
  {
    // Timezone-aware OAuth usage — pg mirror of the sqlite v23 migration. Rebucket
    // from UTC-DAY to UTC-HOUR so the providers page rolls usage up by the ADMIN's
    // LOCAL day at read time (the gateway is tz-agnostic at write time). Pure rename;
    // existing daily rows (UTC-midnight) remain valid hour-floor values (the 00:00
    // UTC bucket), losing only their intra-day distribution (observability artifact).
    version: 22,
    sql: `
      ALTER TABLE oauth_usage RENAME COLUMN day TO bucket_ms;

      DROP INDEX IF EXISTS idx_oauth_usage_day;

      CREATE INDEX IF NOT EXISTS idx_oauth_usage_bucket_ms ON oauth_usage (bucket_ms);
    `,
  },
  {
    // Forwarded-upstream request capture (mirrors sqlite v24): the EXACT provider-
    // native body sent upstream (AFTER memory injection + protocol translation).
    // Additive + nullable (NULL = pre-feature row / capture off / no provider
    // served); forward-only. TEXT to round-trip exact bytes; NO plaintext key.
    version: 23,
    sql: `
      ALTER TABLE request_payloads ADD COLUMN upstream_request_json TEXT;
    `,
  },
  {
    // True-TPS denominator (mirrors sqlite v25): denormalize the served-stream
    // generation window (DecisionRecord.generation_ms) for a plain SUM in the
    // dashboard aggregate. Additive + nullable (NULL = non-streaming / pre-feature
    // row); forward-only — legacy rows stay NULL and never count toward the rate.
    version: 24,
    sql: `
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS generation_ms INTEGER;
    `,
  },
  {
    // OAuth account auto-park (mirrors sqlite v26): a per-account cooldown the
    // scheduler honors — an account that hits its usage/rate limit is parked out of
    // the pool until this epoch-ms timestamp, then auto-recovers. "Reset usage" sets
    // it back to NULL. Additive + nullable; forward-only.
    version: 25,
    sql: `
      ALTER TABLE oauth_quota ADD COLUMN IF NOT EXISTS usage_limited_until_ms BIGINT;
    `,
  },
  {
    // Memory-job claim index (mirrors sqlite v27; review M7): claimPendingJobs runs on
    // every worker tick + debounced wake — WHERE status='pending' OR (status='running'
    // AND updated_at<=staleBefore) ORDER BY created_at, id. (status, created_at, id)
    // serves the hot pending branch's filter + order so it isn't a scan+sort of a
    // memory_jobs table that grows until the cleanup cadence prunes it. Additive +
    // idempotent; forward-only.
    version: 26,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim ON memory_jobs (status, created_at, id);
    `,
  },
  {
    // docs/14 / docs/12 P8 — hybrid fact retrieval (pg mirror of sqlite v28). pgvector
    // for the vector leg + a GIN tsvector('simple') index for full-text. 'simple' (not
    // 'english') so CJK isn't English-stemmed; queried via websearch_to_tsquery (which
    // tolerates arbitrary user input). The `vector` column is left UN-dimensioned (a
    // sequential <=> scan, the pg analogue of sqlite-vec brute force) so the migration
    // needs no runtime embedding dim. NOTE: requires the pgvector extension — present by
    // default on Supabase (helm's hosted-pg target); a self-hosted PG without it fails
    // this migration at boot (CREATE EXTENSION), which is the honest signal to install
    // it. Each statement is `;`-terminated only (the splitStatements contract).
    version: 27,
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE memory_facts ADD COLUMN embedding vector;
      ALTER TABLE memory_facts ADD COLUMN embedding_model text;
      ALTER TABLE memory_facts ADD COLUMN embedding_dim integer;
      CREATE INDEX IF NOT EXISTS idx_memory_facts_fts ON memory_facts USING gin (to_tsvector('simple', fact_text));
    `,
  },
  {
    // Content-addressed image blob store (store/payload-blobs.ts) — pg mirror of
    // the sqlite v29 migration (different ledger, same logical change). The base64
    // images Claude Code re-sends every turn were the bulk of the prod DB; they now
    // live ONCE here keyed by sha256 of the decoded bytes, and the request_payloads
    // text columns hold only sentinels. bytes is BYTEA; the slimmed text is NOT
    // gzipped here (unlike sqlite) — pg's TOAST auto-compresses large text values.
    // The created_at index drives the same-cutoff retention prune as the payloads.
    version: 28,
    sql: `
      CREATE TABLE IF NOT EXISTS payload_blobs (
        sha256 TEXT PRIMARY KEY,
        bytes BYTEA NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payload_blobs_created_at ON payload_blobs (created_at);
    `,
  },
  {
    // Mirror of sqlite v30: index the admin /requests lane + decided_by filters so
    // they're an index seek, not a jsonb scan. Postgres generated columns are STORED
    // only (no VIRTUAL), but the expression is a cheap immutable jsonb extract and
    // telemetry rows are tiny, so the per-insert cost is negligible. `model` stays a
    // jsonb ILIKE-contains (no index can serve it).
    version: 29,
    sql: `
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS lane TEXT
        GENERATED ALWAYS AS (decision_json -> 'lane' ->> 'selected_lane') STORED;
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS decided_by TEXT
        GENERATED ALWAYS AS (decision_json -> 'classifier' ->> 'decided_by') STORED;

      CREATE INDEX IF NOT EXISTS idx_telemetry_lane ON telemetry (lane);
      CREATE INDEX IF NOT EXISTS idx_telemetry_decided_by ON telemetry (decided_by);
    `,
  },
  {
    // Per-key Fast-mode passthrough cap (docs/06) — pg mirror of sqlite v31.
    // Additive boolean default false; account-level Fast mode remains separate.
    version: 30,
    sql: `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allow_fast_mode BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    // Admin dashboard aggregate hot path — pg mirror of sqlite v32. Store
    // latency_total_ms as a real column so dashboard aggregates do not parse the
    // decision_json blob/jsonb on every request, and add covering indexes for
    // global and per-key aggregate windows.
    version: 31,
    sql: `
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS latency_total_ms INTEGER;

      UPDATE telemetry
      SET latency_total_ms = ((decision_json ->> 'latency_total_ms')::DOUBLE PRECISION)::INTEGER
      WHERE latency_total_ms IS NULL
        AND jsonb_typeof(decision_json -> 'latency_total_ms') = 'number';

      CREATE INDEX IF NOT EXISTS idx_telemetry_admin_window_cover
        ON telemetry (created_at)
        INCLUDE (
          final_status,
          cost_usd,
          prompt_tokens,
          completion_tokens,
          cached_tokens,
          cache_creation_tokens,
          latency_total_ms,
          generation_ms,
          served_model,
          api_key_id
        );

      CREATE INDEX IF NOT EXISTS idx_telemetry_admin_key_window_cover
        ON telemetry (api_key_id, created_at)
        INCLUDE (
          final_status,
          cost_usd,
          prompt_tokens,
          completion_tokens,
          cached_tokens,
          cache_creation_tokens,
          latency_total_ms,
          generation_ms,
          served_model
        );
    `,
  },
  {
    // Recoverable API keys — pg mirror of sqlite v33. Existing rows remain
    // hash-only and unrecoverable; new/rotated rows may store AES-GCM ciphertext
    // here. This is encrypted material, never raw plaintext.
    version: 32,
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        secret_enc TEXT,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT,
        allowed_lanes JSONB,
        allow_custom_model BOOLEAN NOT NULL DEFAULT FALSE,
        allow_fast_mode BOOLEAN NOT NULL DEFAULT FALSE,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        rate_limit_rpm INTEGER,
        rate_limit_tpm INTEGER,
        budget_requests INTEGER,
        budget_tokens INTEGER,
        budget_spend_usd DOUBLE PRECISION,
        budget_window_seconds INTEGER,
        over_budget_behavior TEXT NOT NULL DEFAULT 'degrade',
        degrade_lane TEXT,
        concurrency_limit INTEGER,
        memory_mode TEXT NOT NULL DEFAULT 'off',
        memory_project_id TEXT,
        memory_thread_source TEXT NOT NULL DEFAULT 'header',
        created_at BIGINT NOT NULL
      );

      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS secret_enc TEXT;
    `,
  },
];

// Anything that can run a raw SQL string against the Postgres connection. Both
// the drizzle pglite and postgres-js handles satisfy this via `.execute()`.
interface RawExecutor {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>;
}

// Split a migration block into individual statements. Postgres' wire protocol
// (used by BOTH pglite and postgres-js through drizzle's prepared `.execute()`)
// rejects multiple commands in one prepared statement, so each CREATE/INSERT must
// be issued on its own. Our DDL has no semicolons except statement terminators,
// so a `;` split is safe; empties (trailing newline) are dropped.
function splitStatements(block: string): string[] {
  return block
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Apply pending migrations against an open drizzle pg handle. Idempotent: a
// `_migrations` ledger records applied versions so re-running is a no-op. Throws
// on failure so the caller fails-closed at startup. Statements run one at a time
// (the pg wire protocol forbids multi-command prepared statements), but EACH
// migration's statements + its ledger INSERT are wrapped in a single
// BEGIN/COMMIT (rolled back on error) — mirroring the sqlite adapter's
// db.transaction — so a partial failure can never leave the ledger lying about a
// half-applied version.
export async function runPgMigrations(db: RawExecutor): Promise<void> {
  let locked = false;
  await db.execute(sql.raw(PG_MIGRATION_LOCK_SQL));
  locked = true;
  try {
    await db.execute(
      sql.raw(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      ),
    );
    const applied = (await db.execute(sql.raw("SELECT version FROM _migrations"))) as
      | { rows?: Array<{ version: number }> }
      | Array<{ version: number }>;
    const rows = Array.isArray(applied) ? applied : (applied.rows ?? []);
    const have = new Set(rows.map((r) => Number(r.version)));
    for (const m of MIGRATIONS) {
      if (have.has(m.version)) continue;
      await db.execute(sql.raw("BEGIN"));
      try {
        for (const stmt of splitStatements(m.sql)) {
          await db.execute(sql.raw(stmt));
        }
        await db.execute(
          sql.raw(
            `INSERT INTO _migrations (version, applied_at) VALUES (${m.version}, ${Date.now()})`,
          ),
        );
        await db.execute(sql.raw("COMMIT"));
      } catch (err) {
        await db.execute(sql.raw("ROLLBACK"));
        throw err;
      }
    }
  } finally {
    if (locked) await db.execute(sql.raw(PG_MIGRATION_UNLOCK_SQL));
  }
}

// Open an in-process PGlite database, run migrations, and return a drizzle handle
// bound to the schema. Used by the contract tests (and ephemeral local runs):
// supabase == hosted Postgres, so this pg-dialect coverage validates the supabase
// path WITHOUT a running server. `dataDir` omitted => a fresh in-memory database.
export async function createPgliteDb(dataDir?: string): Promise<PgDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  // docs/14 — load the pgvector extension so the v27 migration's `vector` column +
  // the hybrid-recall vector leg work in-process (the contract tests cover the pg
  // vector path without a server). Hosted Postgres (supabase) ships pgvector too.
  // PGlite.create() (NOT `new PGlite`) is required so the extension's bundle is
  // registered before any query — otherwise CREATE EXTENSION can't find vector.control.
  const { vector } = await import("@electric-sql/pglite/vector");
  const client = dataDir
    ? await PGlite.create(dataDir, { extensions: { vector } })
    : await PGlite.create({ extensions: { vector } });
  const db = drizzlePglite(client, { schema });
  await runPgMigrations(db);
  return Object.assign(db, { $close: () => client.close() });
}

// Open a hosted Postgres (supabase) connection via postgres-js, run migrations,
// and return a drizzle handle. The connection string is passed by the caller
// (resolved from runtime.store.url_env) — NEVER logged. `max: 1`-style pooling is
// left to the driver default; the gateway is single-process for the MVP.
export async function createPgDb(connectionString: string): Promise<PgDb> {
  const { default: postgres } = await import("postgres");
  const client = postgres(connectionString);
  const db = drizzlePostgres(client, { schema });
  await runPgMigrations(db);
  return Object.assign(db, { $close: () => client.end() });
}
