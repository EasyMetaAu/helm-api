import { decodeScopeId, encodeScopeId } from "@helm/shared";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
  quarantinedMalformedJobThreadId,
  quarantinedRawThreadId,
} from "../../memory/thread-scope.js";
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

// Anything that can run a raw SQL string against the Postgres connection. Both
// the drizzle pglite and postgres-js handles satisfy this via `.execute()`.
interface RawExecutor {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>;
}

// Drizzle's transaction callback pins every statement to one physical
// connection, including when postgres-js has a multi-connection runtime pool.
// That session affinity is required for transaction-scoped advisory locks and
// for atomic DDL + ledger writes.
interface MigrationRunner extends RawExecutor {
  transaction<T>(callback: (tx: RawExecutor) => Promise<T>): Promise<T>;
}

// Checked-in DDL for the Postgres dialect — the pg equivalent of the sqlite
// migrations. Each statement is idempotent (IF NOT EXISTS) so re-running is safe;
// a `_migrations` ledger records applied versions the same way the sqlite adapter
// does. Epoch-ms timestamps are BIGINT to match the sqlite timestamp_ms value
// space exactly. NO plaintext column anywhere (principle 7).
type Migration =
  | {
      readonly version: number;
      readonly sql: string;
      readonly run?: never;
    }
  | {
      readonly version: number;
      readonly run: (db: RawExecutor) => Promise<void>;
      readonly sql?: never;
    };

// Transaction-scoped startup lock. Two 32-bit keys spell "HELM" and "API\0";
// the lock is released by COMMIT/ROLLBACK, so a failed process cannot leak it.
const PG_MIGRATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(1212501069, 1095780608)";

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
  {
    // Memory idle-flush catch-up indexes — pg mirror of sqlite v34.
    version: 33,
    run: async (db) => {
      if (
        await pgTableHasColumns(db, "memory_threads", [
          "owner_id",
          "project_id",
          "resource_id",
          "id",
        ])
      ) {
        await db.execute(
          sql.raw(`
            CREATE INDEX IF NOT EXISTS idx_memory_threads_owner_project_resource
              ON memory_threads (owner_id, project_id, resource_id, id)
          `),
        );
      }
      if (
        await pgTableHasColumns(db, "memory_messages", [
          "thread_id",
          "message_index",
          "created_at",
          "id",
        ])
      ) {
        await db.execute(
          sql.raw(`
            CREATE INDEX IF NOT EXISTS idx_memory_messages_thread_order
              ON memory_messages (thread_id, message_index, created_at, id)
          `),
        );
      }
    },
  },
  {
    // Admin memory stats queue indexes — pg mirror of sqlite v35.
    version: 34,
    run: async (db) => {
      if (await pgTableHasColumns(db, "memory_jobs", ["status", "updated_at", "created_at"])) {
        await db.execute(
          sql.raw(`
            CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_updated_at
              ON memory_jobs (status, updated_at, created_at)
          `),
        );
      }
      if (await pgTableHasColumns(db, "memory_jobs", ["type", "status"])) {
        await db.execute(
          sql.raw(`
            CREATE INDEX IF NOT EXISTS idx_memory_jobs_type_status
              ON memory_jobs (type, status)
          `),
        );
      }
    },
  },
  {
    // Codex reset-credit count for quota-aware account selection — pg mirror of
    // sqlite v36. Nullable and observability-only; Codex usage PULLs refresh it.
    version: 35,
    run: async (db) => {
      if (await pgTableHasColumns(db, "oauth_quota", ["provider_id"])) {
        await db.execute(
          sql.raw("ALTER TABLE oauth_quota ADD COLUMN IF NOT EXISTS reset_credits INTEGER"),
        );
      }
    },
  },
  {
    // Admin /requests keyword search — pg mirror of sqlite v37. Keep the existing
    // requested_model OR final.model_alias OR lane semantics, but compute them once
    // into a lowercase STORED column so model= scans a narrow indexed value instead
    // of extracting three jsonb paths for every candidate row.
    version: 36,
    sql: `
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS model_search TEXT
        GENERATED ALWAYS AS (
          lower(
            coalesce(decision_json ->> 'requested_model', '') ||
            chr(31) ||
            coalesce(decision_json -> 'final' ->> 'model_alias', '') ||
            chr(31) ||
            coalesce(decision_json -> 'lane' ->> 'selected_lane', '')
          )
        ) STORED;

      CREATE INDEX IF NOT EXISTS idx_telemetry_admin_model_window
        ON telemetry (created_at, model_search);

      CREATE INDEX IF NOT EXISTS idx_telemetry_admin_key_model_window
        ON telemetry (api_key_id, created_at, model_search);
    `,
  },
  {
    // Per-key model blacklist. Nullable jsonb array of model patterns, applied to
    // direct requests and all lane/fallback chains.
    version: 37,
    run: async (db) => {
      if (await pgTableHasColumns(db, "api_keys", ["key_id"])) {
        await db.execute(
          sql.raw("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS blocked_models JSONB"),
        );
      }
    },
  },
  {
    // pg mirror of SQLite v39: keep the admin memory activity aggregates on the
    // scoped parent row. The GROUP BY backfills are one-time ordered index scans;
    // future insert/prune paths maintain the columns transactionally.
    version: 38,
    run: async (db) => {
      // Several narrow migration tests intentionally seed only one legacy table.
      // A missing memory subsystem is out of scope for this additive migration.
      if (!(await pgTableHasColumns(db, "memory_threads", ["id"]))) return;
      await db.execute(
        sql.raw(
          "ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0",
        ),
      );
      await db.execute(
        sql.raw("ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS last_message_at BIGINT"),
      );
      await db.execute(
        sql.raw(
          "ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 0",
        ),
      );
      await db.execute(
        sql.raw("ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS last_observation_at BIGINT"),
      );
      if (await pgTableHasColumns(db, "memory_messages", ["thread_id", "created_at"])) {
        await db.execute(
          sql.raw(`
            UPDATE memory_threads AS t
               SET message_count = activity.n,
                   last_message_at = activity.last_at
              FROM (
                SELECT thread_id, COUNT(*)::integer AS n, MAX(created_at)::bigint AS last_at
                  FROM memory_messages
                 GROUP BY thread_id
              ) AS activity
             WHERE t.id = activity.thread_id
          `),
        );
      }
      if (await pgTableHasColumns(db, "memory_observations", ["thread_id", "observed_at"])) {
        await db.execute(
          sql.raw(`
            UPDATE memory_threads AS t
               SET observation_count = activity.n,
                   last_observation_at = activity.last_at
              FROM (
                SELECT thread_id, COUNT(*)::integer AS n, MAX(observed_at)::bigint AS last_at
                  FROM memory_observations
                 GROUP BY thread_id
              ) AS activity
             WHERE t.id = activity.thread_id
          `),
        );
      }
    },
  },
  {
    // pg mirror of SQLite v40. Every parent present before this ledger row is
    // historical, even if its opaque id resembles `v2:*`. Copy each one into a
    // distinct owner-bound quarantine, move FK children, and delete the old
    // parent atomically. All long-tier rows for affected owners are de-scoped and
    // archived because project-only Observer/Reflector output can also have been
    // derived from a mixed legacy parent.
    version: 39,
    run: async (db) => {
      if (
        !(await pgTableHasColumns(db, "memory_threads", [
          "id",
          "project_id",
          "resource_id",
          "owner_id",
          "last_served_model",
          "message_count",
          "last_message_at",
          "observation_count",
          "last_observation_at",
          "created_at",
          "updated_at",
        ]))
      ) {
        return;
      }
      const invalidOwner = resultRows<{ invalid: number }>(
        await db.execute(
          sql.raw(
            "SELECT 1 AS invalid FROM memory_threads WHERE owner_id IS NULL OR owner_id = '' LIMIT 1",
          ),
        ),
      )[0];
      if (invalidOwner !== undefined) {
        throw new Error("cannot quarantine legacy Memory threads: owner_id is missing");
      }

      const quarantinedAt = Date.now();
      await db.execute(
        sql.raw(`
          CREATE TEMP TABLE helm_memory_thread_scope_v2 (
            old_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            new_id TEXT NOT NULL UNIQUE
          ) ON COMMIT DROP
        `),
      );
      await db.execute(
        sql.raw(`
          INSERT INTO helm_memory_thread_scope_v2 (old_id, owner_id, new_id)
          SELECT id,
                 owner_id,
                 'v2:q:p:' || encode(convert_to(owner_id, 'UTF8'), 'hex') || ':' ||
                   encode(convert_to(id, 'UTF8'), 'hex')
            FROM memory_threads
        `),
      );
      const targetCollision = resultRows<{ collision: number }>(
        await db.execute(
          sql.raw(`
            SELECT 1 AS collision
              FROM helm_memory_thread_scope_v2 AS m
              JOIN memory_threads AS existing ON existing.id = m.new_id
             LIMIT 1
          `),
        ),
      )[0];
      if (targetCollision !== undefined) {
        throw new Error("legacy Memory quarantine target already exists; migration rolled back");
      }
      await db.execute(
        sql.raw(`
          INSERT INTO memory_threads (
            id, project_id, resource_id, owner_id, last_served_model,
            message_count, last_message_at, observation_count,
            last_observation_at, created_at, updated_at
          )
          SELECT m.new_id, NULL, NULL, t.owner_id, t.last_served_model,
                 t.message_count, t.last_message_at, t.observation_count,
                 t.last_observation_at, t.created_at, t.updated_at
            FROM memory_threads t
            JOIN helm_memory_thread_scope_v2 m ON m.old_id = t.id
        `),
      );
      for (const table of ["memory_messages", "memory_observations"] as const) {
        if (!(await pgTableHasColumns(db, table, ["thread_id"]))) continue;
        await db.execute(
          sql.raw(`
            UPDATE ${table} AS child
               SET thread_id = m.new_id
              FROM helm_memory_thread_scope_v2 m
             WHERE child.thread_id = m.old_id
          `),
        );
      }

      if (
        await pgTableHasColumns(db, "memory_reflections", [
          "owner_id",
          "project_id",
          "resource_id",
          "thread_id",
          "status",
        ])
      ) {
        await db.execute(
          sql.raw(`
            UPDATE memory_reflections AS child
               SET project_id = NULL,
                   resource_id = NULL,
                   thread_id = 'v2:q:r:' || encode(convert_to(child.owner_id, 'UTF8'), 'hex') || ':' ||
                     encode(convert_to(COALESCE(child.thread_id, ''), 'UTF8'), 'hex'),
                   status = 'archived'
             WHERE owner_id IN (SELECT owner_id FROM helm_memory_thread_scope_v2)
          `),
        );
      }
      if (
        await pgTableHasColumns(db, "memory_facts", [
          "owner_id",
          "project_id",
          "resource_id",
          "thread_id",
          "status",
          "invalid_at",
          "expired_at",
          "updated_at",
        ])
      ) {
        await db.execute(
          sql.raw(`
            UPDATE memory_facts AS child
               SET project_id = NULL,
                   resource_id = NULL,
                   thread_id = 'v2:q:r:' || encode(convert_to(child.owner_id, 'UTF8'), 'hex') || ':' ||
                     encode(convert_to(COALESCE(child.thread_id, ''), 'UTF8'), 'hex'),
                   invalid_at = COALESCE(invalid_at, ${quarantinedAt}),
                   expired_at = COALESCE(expired_at, ${quarantinedAt}),
                   updated_at = ${quarantinedAt},
                   status = 'archived'
             WHERE owner_id IN (SELECT owner_id FROM helm_memory_thread_scope_v2)
          `),
        );
      }

      if (
        await pgTableHasColumns(db, "memory_jobs", [
          "id",
          "scope_id",
          "status",
          "error",
          "updated_at",
        ])
      ) {
        type MappingRow = { old_id: string; owner_id: string; new_id: string };
        type JobRow = {
          id: string;
          scope_id: string;
          status: string;
          error: string | null;
        };
        const mappingRows = resultRows<MappingRow>(
          await db.execute(
            sql.raw("SELECT old_id, owner_id, new_id FROM helm_memory_thread_scope_v2"),
          ),
        );
        const key = (ownerId: string, threadId: string): string =>
          JSON.stringify([ownerId, threadId]);
        const oldToNew = new Map(
          mappingRows.map((row) => [key(row.owner_id, row.old_id), row.new_id]),
        );
        const existingTargets = new Set(mappingRows.map((row) => key(row.owner_id, row.new_id)));
        const affectedOwners = new Set(mappingRows.map((row) => row.owner_id));
        const jobs = resultRows<JobRow>(
          await db.execute(sql.raw("SELECT id, scope_id, status, error FROM memory_jobs")),
        );
        for (const job of jobs) {
          let scope: ReturnType<typeof decodeScopeId>;
          try {
            scope = decodeScopeId(job.scope_id);
          } catch {
            const isOpen = job.status === "pending" || job.status === "running";
            const nextScopeId = encodeScopeId({
              accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
              threadId: quarantinedMalformedJobThreadId(job.id),
            });
            const nextStatus = isOpen ? "failed" : job.status;
            const nextError = isOpen
              ? "malformed legacy memory job scope quarantined during v39 migration"
              : job.error;
            await db.execute(
              sql`
                UPDATE memory_jobs
                   SET scope_id = ${nextScopeId},
                       status = ${nextStatus},
                       error = ${nextError},
                       updated_at = ${quarantinedAt}
                 WHERE id = ${job.id}
              ` as ReturnType<typeof sql.raw>,
            );
            continue;
          }
          if (!affectedOwners.has(scope.accountId)) continue;
          const currentThreadId = scope.threadId ?? "";
          const nextThreadId =
            oldToNew.get(key(scope.accountId, currentThreadId)) ??
            (existingTargets.has(key(scope.accountId, currentThreadId))
              ? currentThreadId
              : quarantinedRawThreadId(scope.accountId, currentThreadId));
          const nextScopeId = encodeScopeId({
            accountId: scope.accountId,
            threadId: nextThreadId,
          });
          const isOpen = job.status === "pending" || job.status === "running";
          const nextStatus = isOpen ? "failed" : job.status;
          const nextError = isOpen
            ? "legacy thread scope quarantined during v39 migration"
            : job.error;
          await db.execute(
            sql`
              UPDATE memory_jobs
                 SET scope_id = ${nextScopeId},
                     status = ${nextStatus},
                     error = ${nextError},
                     updated_at = ${quarantinedAt}
               WHERE id = ${job.id}
            ` as ReturnType<typeof sql.raw>,
          );
        }
      }
      await db.execute(
        sql.raw(`
          DELETE FROM memory_threads AS t
           USING helm_memory_thread_scope_v2 m
           WHERE t.id = m.old_id
        `),
      );
    },
  },
  {
    // Incremental session transcript, independent of request_payloads so turning
    // payload capture off does not turn off session recovery.
    version: 40,
    run: async (db) => {
      const ddl = `
        CREATE TABLE IF NOT EXISTS sessions (
          session_ref TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          api_key_id TEXT NOT NULL,
          source TEXT NOT NULL,
          external_session_id TEXT NOT NULL,
          head_request_id TEXT,
          revision_count INTEGER NOT NULL DEFAULT 0,
          stored_bytes BIGINT NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          UNIQUE (account_id, api_key_id, source, external_session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_last_seen_at ON sessions (last_seen_at);
        CREATE TABLE IF NOT EXISTS session_revisions (
          request_id TEXT PRIMARY KEY,
          session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          parent_request_id TEXT,
          retain_count INTEGER NOT NULL CHECK (retain_count >= 0),
          request_delta_json TEXT NOT NULL,
          request_envelope_json TEXT NOT NULL,
          response_id TEXT,
          response_json TEXT,
          fidelity TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_revisions_session_created
          ON session_revisions (session_ref, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_session_revisions_sequence
          ON session_revisions (session_ref, sequence);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_session_revisions_response
          ON session_revisions (session_ref, response_id);
      `;
      for (const statement of splitStatements(ddl)) await db.execute(sql.raw(statement));
      if (await pgTableHasColumns(db, "telemetry", ["decision_json", "created_at"])) {
        await db.execute(
          sql.raw(`CREATE INDEX IF NOT EXISTS idx_telemetry_session_window
            ON telemetry ((decision_json -> 'session' ->> 'ref'), created_at DESC)`),
        );
      }
    },
  },
  {
    // PostgreSQL-only cluster-wide API-key concurrency leases. Expiry timestamps
    // deliberately use timestamptz and are evaluated with the database clock.
    // No FK: key deletion must not block lease expiry/reclamation.
    version: 41,
    sql: `
      CREATE TABLE IF NOT EXISTS api_key_concurrency_state (
        key_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS api_key_concurrency_leases (
        lease_id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_key_concurrency_leases_key_expires
        ON api_key_concurrency_leases (key_id, expires_at);
    `,
  },
  {
    version: 42,
    sql: `
      CREATE TABLE IF NOT EXISTS responses_registry (
        response_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        provider_alias TEXT,
        provider_name TEXT,
        provider_model TEXT,
        provider_protocol TEXT,
        provider_account TEXT,
        selected_lane TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_responses_registry_expires_at
        ON responses_registry (expires_at);
      CREATE INDEX IF NOT EXISTS idx_responses_registry_created_id
        ON responses_registry (created_at, response_id);
    `,
  },
  {
    // Per-key request-content retention override. NULL inherits the system mode.
    version: 43,
    run: async (db) => {
      if (await pgTableHasColumns(db, "api_keys", ["key_id"])) {
        await db.execute(
          sql.raw("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS request_content_mode TEXT"),
        );
      }
    },
  },
  {
    // Additive Session chunk storage. Legacy bodies stay where they are and are
    // never scanned or backfilled during deployment.
    version: 44,
    run: async (db) => {
      if (!(await pgTableHasColumns(db, "session_revisions", ["request_id"]))) return;
      const ddl = `
        ALTER TABLE session_revisions ADD COLUMN IF NOT EXISTS body_bytes BIGINT;
        ALTER TABLE session_revisions ADD COLUMN IF NOT EXISTS request_body_generation TEXT;
        ALTER TABLE session_revisions ADD COLUMN IF NOT EXISTS response_body_generation TEXT;
        CREATE TABLE IF NOT EXISTS session_head_event_hashes (
          session_ref TEXT PRIMARY KEY REFERENCES sessions(session_ref) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          event_key TEXT NOT NULL CHECK (event_key IN ('messages', 'contents', 'input')),
          event_count INTEGER NOT NULL CHECK (event_count >= 0),
          event_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_revision_body_chunks (
          request_id TEXT NOT NULL,
          generation TEXT NOT NULL,
          part TEXT NOT NULL CHECK (part IN ('request_delta', 'request_envelope', 'response')),
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          codec TEXT NOT NULL CHECK (codec IN ('gzip', 'raw')),
          raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0 AND raw_bytes <= 262144),
          bytes BYTEA NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (request_id, generation, part, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_session_revision_body_chunks_created
          ON session_revision_body_chunks (created_at);
      `;
      for (const statement of splitStatements(ddl)) await db.execute(sql.raw(statement));
    },
  },
  {
    // Real reset-period boundaries — pg mirror of sqlite v46. Append-only history for
    // the usage-period read; populated going forward from quota-refresh detection.
    version: 45,
    run: async (db) => {
      const ddl = `
        CREATE TABLE IF NOT EXISTS oauth_reset_period (
          provider_id TEXT NOT NULL,
          account TEXT NOT NULL,
          window_key TEXT NOT NULL,
          period_start_ms BIGINT NOT NULL,
          period_end_ms BIGINT NOT NULL,
          detected_at_ms BIGINT NOT NULL,
          PRIMARY KEY (provider_id, account, window_key, period_start_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_reset_period_lookup
          ON oauth_reset_period (provider_id, account, window_key, period_end_ms);
      `;
      for (const statement of splitStatements(ddl)) await db.execute(sql.raw(statement));
    },
  },
  {
    // Per-key reasoning-effort ceiling (cost control). NULL = no cap. pg mirror of
    // sqlite v47.
    version: 46,
    run: async (db) => {
      if (await pgTableHasColumns(db, "api_keys", ["key_id"])) {
        await db.execute(
          sql.raw("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_reasoning_effort TEXT"),
        );
      }
    },
  },
  {
    // Persist Codex live quota metadata (planType/credits/individualLimit/…) as a
    // JSONB blob so the providers page renders the full card after a restart instead
    // of losing everything but windows until the next refresh. Pg mirror of sqlite v48.
    version: 47,
    run: async (db) => {
      if (await pgTableHasColumns(db, "oauth_quota", ["provider_id"])) {
        await db.execute(
          sql.raw("ALTER TABLE oauth_quota ADD COLUMN IF NOT EXISTS metadata JSONB"),
        );
      }
    },
  },
  {
    // Pg mirror of SQLite v49: stable server-time order, durable Observer
    // frontier columns, cleanup index, and transactional counter reconciliation.
    // Legacy rows keep a null frontier and are drained by bounded worker pages.
    version: 48,
    run: async (db) => {
      if (!(await pgTableHasColumns(db, "memory_threads", ["id"]))) return;
      await db.execute(
        sql.raw("ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS observer_frontier_at BIGINT"),
      );
      await db.execute(
        sql.raw("ALTER TABLE memory_threads ADD COLUMN IF NOT EXISTS observer_frontier_id TEXT"),
      );
      if (!(await pgTableHasColumns(db, "memory_messages", ["thread_id", "created_at", "id"]))) {
        return;
      }
      await db.execute(
        sql.raw(`
        CREATE INDEX IF NOT EXISTS idx_memory_messages_thread_created_id
          ON memory_messages (thread_id, created_at, id)
      `),
      );
      await db.execute(
        sql.raw(`
        CREATE INDEX IF NOT EXISTS idx_memory_messages_created_id
          ON memory_messages (created_at, id)
      `),
      );
      await db.execute(
        sql.raw(`
        UPDATE memory_threads AS t
           SET message_count = (SELECT COUNT(*)::integer FROM memory_messages m WHERE m.thread_id = t.id),
               last_message_at = (SELECT MAX(created_at)::bigint FROM memory_messages m WHERE m.thread_id = t.id)
      `),
      );
      if (await pgTableHasColumns(db, "memory_observations", ["thread_id", "observed_at"])) {
        await db.execute(
          sql.raw(`
          UPDATE memory_threads AS t
             SET observation_count = (
                   SELECT COUNT(*)::integer FROM memory_observations o WHERE o.thread_id = t.id
                 ),
                 last_observation_at = (
                   SELECT MAX(observed_at)::bigint FROM memory_observations o WHERE o.thread_id = t.id
                 )
        `),
        );
      }
    },
  },
  {
    // Pg mirror of SQLite v50: one monotonic fencing generation per job row.
    version: 49,
    sql: `
      ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] };
  return Array.isArray(maybe.rows) ? maybe.rows : [];
}

async function pgTableHasColumns(
  db: RawExecutor,
  table:
    | "api_keys"
    | "memory_threads"
    | "memory_messages"
    | "memory_observations"
    | "memory_reflections"
    | "memory_facts"
    | "memory_jobs"
    | "oauth_quota"
    | "session_revisions"
    | "telemetry",
  requiredColumns: readonly string[],
): Promise<boolean> {
  const rows = resultRows<{ column_name: string }>(
    await db.execute(
      sql.raw(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '${table}'
      `),
    ),
  );
  if (rows.length === 0) return false;
  const names = new Set(rows.map((r) => r.column_name));
  return requiredColumns.every((name) => names.has(name));
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

// Apply pending migrations against an open drizzle pg handle. Each Drizzle
// transaction reserves one physical connection. Inside it we acquire the xact
// advisory lock, re-read that version's ledger row, apply the migration, and
// record the ledger entry. Concurrent gateway startups therefore serialize and
// cannot execute a version twice, while a failure rolls back only that version
// (previous versions stay committed). No manual BEGIN/COMMIT is issued through a
// pooled executor.
export async function runPgMigrations(db: MigrationRunner): Promise<void> {
  const have = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(PG_MIGRATION_LOCK_SQL));
    await tx.execute(
      sql.raw(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      ),
    );
    const applied = resultRows<{ version: number }>(
      await tx.execute(sql.raw("SELECT version FROM _migrations")),
    );
    return new Set(applied.map((row) => Number(row.version)));
  });

  for (const migration of MIGRATIONS) {
    if (have.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(PG_MIGRATION_LOCK_SQL));
      const alreadyApplied = resultRows<{ version: number }>(
        await tx.execute(
          sql.raw(`SELECT version FROM _migrations WHERE version = ${migration.version}`),
        ),
      );
      if (alreadyApplied.length > 0) return;

      if (migration.run) {
        await migration.run(tx);
      } else {
        for (const statement of splitStatements(migration.sql)) {
          await tx.execute(sql.raw(statement));
        }
      }
      await tx.execute(
        sql.raw(
          `INSERT INTO _migrations (version, applied_at) VALUES (${migration.version}, ${Date.now()})`,
        ),
      );
    });
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
// (resolved from runtime.store.url_env) — NEVER logged. The runtime keeps the
// driver's normal pool; runPgMigrations uses Drizzle transactions, which reserve
// one physical connection for each lock + migration + ledger unit.
export async function createPgDb(connectionString: string): Promise<PgDb> {
  const { default: postgres } = await import("postgres");
  const client = postgres(connectionString);
  const db = drizzlePostgres(client, { schema });
  await runPgMigrations(db);
  return Object.assign(db, { $close: () => client.end() });
}
