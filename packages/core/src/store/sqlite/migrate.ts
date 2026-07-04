import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema.js";

type Schema = typeof schema;

// Drizzle instance bound to our schema, with the raw better-sqlite3 handle
// attached for lifecycle control. Named explicitly so the exported function's
// return type can be referenced across module boundaries (avoids TS4058).
export type SqliteDb = BetterSQLite3Database<Schema> & {
  readonly $sqlite: Database.Database;
  // docs/14 — whether the sqlite-vec extension loaded on this connection. The hybrid
  // recall vector leg (vec0 KNN) is used only when true; on false the store degrades
  // to FTS+score (fail-open — a missing/unloadable extension never crashes startup).
  readonly $vecLoaded: boolean;
};

// Checked-in, ordered migrations. Each runs exactly once per database; the
// _migrations table records applied versions so re-running is idempotent. We
// apply DDL directly (rather than via drizzle-kit's generated bundle) so the
// adapter is self-contained and needs no build-time codegen step.
type Migration =
  | {
      readonly version: number;
      readonly sql: string;
      readonly run?: never;
    }
  | {
      readonly version: number;
      readonly run: (db: Database.Database) => void;
      readonly sql?: never;
    };

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
        allowed_lanes TEXT,
        allow_custom_model INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        api_key_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        final_status TEXT,
        cost_usd INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry (created_at DESC);
    `,
  },
  {
    // Memory middleware tables (docs/08 "storage model"). POST-MVP persistence floor:
    // build only — no read/inject. Deliberately ISOLATED from routing/key
    // tables (no FK to lanes/policies/api_keys); memory_messages references
    // memory_threads ONLY. source_message_range is NOT NULL so compressed
    // observations stay auditable against originals (docs/08).
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        owner_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES memory_threads (id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_observations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES memory_threads (id),
        source_message_range TEXT NOT NULL,
        observation_text TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        referenced_at INTEGER,
        priority INTEGER,
        tags TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_reflections (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        thread_id TEXT,
        reflection_text TEXT NOT NULL,
        version INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_messages_thread ON memory_messages (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_observations_thread ON memory_observations (thread_id, observed_at);
    `,
  },
  {
    // Per-key rate-limit token buckets (docs/06 "rate limits & quotas"). One row per
    // (key_id, dim); tokens is REAL so fractional refill survives reads. key_id
    // only — NEVER a plaintext/hashed key (principle 7). Counters live here (not
    // process memory) so windows survive restarts and span instances.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        tokens REAL NOT NULL,
        last_refill_ms INTEGER NOT NULL,
        PRIMARY KEY (key_id, dim)
      );
    `,
  },
  {
    // Agentic Signals (POST-MVP feedback layer; docs/02, research-notes "Plano").
    // One row per (task_type, lane): the latest rolled-up, REDACTED observation,
    // written ASYNCHRONOUSLY by the background collector — never on the request
    // path. NO key/payload column (principle 7); only aggregate dimensions. Two
    // fallback rates are SEPARATE columns (principle 5): fallback_rate =
    // execution (in-chain swap), classifier_fallback_rate = classification
    // (→ balanced). PRIMARY KEY makes upsert idempotent so re-collecting a window
    // never double-counts.
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS routing_signals (
        task_type TEXT NOT NULL,
        lane TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        success_rate REAL NOT NULL,
        fallback_rate REAL NOT NULL,
        classifier_fallback_rate REAL NOT NULL,
        error_rate REAL NOT NULL,
        p50_latency_ms REAL NOT NULL,
        p95_latency_ms REAL NOT NULL,
        avg_cost_usd REAL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_type, lane)
      );
    `,
  },
  {
    // Optional config key/value persistence (ConfigStore port; admin write-back).
    // MVP is yaml-first; reserved for runtime overrides. No secrets stored here.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS config_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Relax telemetry.cost_usd from INTEGER -> REAL so fractional USD costs are
    // not truncated, mirroring the pg adapter's DOUBLE PRECISION (cost_usd
    // dialect divergence). SQLite can't ALTER a column's declared type, so we
    // rebuild the table: copy rows into a REAL-typed clone, swap names, restore
    // the index. v1 ships untouched — this is a NEW forward step so the
    // _migrations ledger stays honest.
    version: 6,
    sql: `
      CREATE TABLE telemetry_new (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        api_key_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        final_status TEXT,
        cost_usd REAL,
        created_at INTEGER NOT NULL
      );

      INSERT INTO telemetry_new (id, request_id, api_key_id, decision_json, final_status, cost_usd, created_at)
        SELECT id, request_id, api_key_id, decision_json, final_status, cost_usd, created_at FROM telemetry;

      DROP TABLE telemetry;

      ALTER TABLE telemetry_new RENAME TO telemetry;

      CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry (created_at DESC);
    `,
  },
  {
    // Full request/response body capture (admin "System Settings" →
    // capture_payloads, default ON). SEPARATE table so it prunes independently
    // (payload_retention_days) and never bloats the decision JSON. NOT redacted
    // — verbatim client request + assembled response. NO plaintext key (the
    // bearer lives in the Authorization header, never in the stored chat body).
    // The created_at index drives the retention auto-prune.
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS request_payloads (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_payloads_created_at ON request_payloads (created_at);
    `,
  },
  {
    // Per-key rate-limit OVERRIDE columns on api_keys (docs/06 "rate limits & quotas"). Two
    // nullable integer columns: NULL = inherit the system default at check time;
    // a value (0 = unlimited) overrides that one dimension for this key. Additive
    // — existing rows get NULL and therefore keep inheriting the default. Distinct
    // from rate_limit_buckets (v3, the runtime counters); these are config.
    version: 8,
    sql: `
      ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER;
      ALTER TABLE api_keys ADD COLUMN rate_limit_tpm INTEGER;
    `,
  },
  {
    // Persisted OAuth subscription credentials (issue #38). One row per
    // (provider_id, account). access_enc/refresh_enc are AES-256-GCM CIPHERTEXT —
    // the only reversibly-stored secrets in Helm (replayed to the token endpoint),
    // so encrypted at rest (store/crypto/token-cipher.ts). meta holds
    // provider-specific JSON (e.g. copilot proxy base). Composite PK makes the
    // rotation write-back an idempotent upsert.
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        access_enc TEXT,
        refresh_enc TEXT,
        expires_at INTEGER,
        meta TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, account)
      );
    `,
  },
  {
    // Retire the per-key max_lane CEILING. Lanes are parallel, not a strict
    // hierarchy (only economy<balanced<premium rank; coding/json/vision are
    // unranked task lanes), so the ceiling was ill-defined for most lanes and
    // fully subsumed by the allowed_lanes whitelist (to "cap at balanced" just
    // whitelist economy+balanced). DROP COLUMN is supported by the bundled SQLite
    // (3.35+); the column is unindexed so the drop is a metadata-only rewrite. v1
    // ships untouched — this is a forward step (any stored ceilings are discarded).
    version: 10,
    sql: `
      ALTER TABLE api_keys DROP COLUMN max_lane;
    `,
  },
  {
    // Per-key USAGE BUDGETS (docs/06 "usage budgets"). Additive — existing rows get
    // NULL caps (= no budget) + over_budget_behavior 'degrade'. Two parts: (a) six
    // budget config columns on api_keys; (b) the usage_budget_buckets counter table
    // (rolling token buckets, one row per key_id+dim, mirrors rate_limit_buckets but
    // with a configurable window). tokens REAL so fractional spend/refill survive;
    // may go negative (soft cap settled post-served). key_id only (principle 7).
    version: 11,
    sql: `
      ALTER TABLE api_keys ADD COLUMN budget_requests INTEGER;
      ALTER TABLE api_keys ADD COLUMN budget_tokens INTEGER;
      ALTER TABLE api_keys ADD COLUMN budget_spend_usd REAL;
      ALTER TABLE api_keys ADD COLUMN budget_window_seconds INTEGER;
      ALTER TABLE api_keys ADD COLUMN over_budget_behavior TEXT NOT NULL DEFAULT 'degrade';
      ALTER TABLE api_keys ADD COLUMN degrade_lane TEXT;

      CREATE TABLE IF NOT EXISTS usage_budget_buckets (
        key_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        tokens REAL NOT NULL,
        last_refill_ms INTEGER NOT NULL,
        PRIMARY KEY (key_id, dim)
      );
    `,
  },
  {
    // Per-account OAuth subscription USAGE + QUOTA observability (providers page).
    // oauth_usage: one additive daily aggregate per (provider_id, account, day) —
    // day = UTC-midnight epoch ms; cost_usd REAL nullable (flat-rate plans report
    // no cost). oauth_quota: latest rate-limit window snapshot per (provider_id,
    // account), windows as JSON text. Both are pure aggregate OBSERVABILITY (no
    // key/payload column, principle 7); writes are fail-open at the call site.
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_usage (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        day INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        cost_usd REAL,
        first_seen_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, account, day)
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_usage_day ON oauth_usage (day);

      CREATE TABLE IF NOT EXISTS oauth_quota (
        provider_id TEXT NOT NULL,
        account TEXT NOT NULL,
        windows TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (provider_id, account)
      );
    `,
  },
  {
    // Per-key max in-flight requests (issue #93 concurrency overflow queue).
    // Additive — existing rows get NULL (= unlimited; like the budgets, 0 is not
    // a sentinel). The in-flight counter itself is process memory (single-process
    // FIFO semaphore), so no counter table — only the configured limit persists.
    version: 13,
    sql: `
      ALTER TABLE api_keys ADD COLUMN concurrency_limit INTEGER;
    `,
  },
  {
    // Memory job queue scan index (docs/08 Phase 2). The unique open-job
    // boundary is added in v16 after cleanup, so old duplicate open rows cannot
    // make first-time upgrades fail before the cleanup migration runs.
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_type_scope_status
        ON memory_jobs (type, scope_id, status);
    `,
  },
  {
    // Bind memory_reflections to the authenticated account owner so project or
    // resource ids reused by another account cannot read long-lived memory.
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_reflections (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        thread_id TEXT,
        reflection_text TEXT NOT NULL,
        version INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE memory_reflections ADD COLUMN owner_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_memory_reflections_owner_scope
        ON memory_reflections (owner_id, project_id, resource_id, thread_id, version DESC);
    `,
  },
  {
    // DB-level open-job dedupe boundary. The original v14 scan index was non-unique;
    // this additive migration makes concurrent enqueueJob calls collapse atomically.
    version: 16,
    sql: `
      UPDATE memory_jobs
      SET status = 'failed',
          error = COALESCE(error || '\n', '') || 'migration cleanup: closed duplicate open memory job before uniq_memory_jobs_open_type_scope',
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE status IN ('pending', 'running')
        AND EXISTS (
          SELECT 1
          FROM memory_jobs keep
          WHERE keep.type = memory_jobs.type
            AND keep.scope_id = memory_jobs.scope_id
            AND keep.status IN ('pending', 'running')
            AND (
              keep.created_at < memory_jobs.created_at
              OR (keep.created_at = memory_jobs.created_at AND keep.id < memory_jobs.id)
            )
        );

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_jobs_open_type_scope
        ON memory_jobs (type, scope_id)
        WHERE status IN ('pending', 'running');
    `,
  },
  {
    // Per-key MEMORY DEFAULTS (issue #97). Additive — existing rows get the
    // fail-safe defaults (memory off, no project, header-only thread source), so
    // unconfigured keys behave exactly as before. Explicit x-memory-* request
    // headers always override these at resolve time.
    version: 17,
    sql: `
      ALTER TABLE api_keys ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE api_keys ADD COLUMN memory_project_id TEXT;
      ALTER TABLE api_keys ADD COLUMN memory_thread_source TEXT NOT NULL DEFAULT 'header';
    `,
  },
  {
    // Memory FORGETTING & TIERING schema deltas (docs/12 "Schema deltas"). All
    // additive, all nullable-or-defaulted, so existing rows + existing tests are
    // untouched and — gated behind forgetting.enabled (default false) — runtime
    // is byte-identical to today until the flag is flipped. Three parts:
    //   (a) mid tier (memory_observations) gets the forgetting-score columns;
    //       referenced_at already exists (v2) and is REUSED.
    //   (b) long tier (memory_reflections) gets reference tracking + visibility
    //       only — reflections are slow-changing, so no importance/archived.
    //   (c) the new memory_facts long-tier table. owner_id (= accountId) is the
    //       TENANT BOUNDARY (a fact may have a null thread_id, so it cannot lean
    //       on memory_threads.owner_id like observations do — docs/12 "Tenant
    //       isolation"). The content_hash dedup index is ACCOUNT-scoped
    //       (UNIQUE(owner_id, content_hash)), never global. DDL copied verbatim
    //       from docs/12; epoch-ms timestamps are INTEGER to match the existing
    //       memory columns' value space.
    version: 18,
    sql: `
      ALTER TABLE memory_observations ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_observations ADD COLUMN importance      REAL    NOT NULL DEFAULT 0.5;
      ALTER TABLE memory_observations ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active';
      ALTER TABLE memory_observations ADD COLUMN archived_at     INTEGER;
      ALTER TABLE memory_observations ADD COLUMN expired_at      INTEGER;

      ALTER TABLE memory_reflections ADD COLUMN referenced_at   INTEGER;
      ALTER TABLE memory_reflections ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_reflections ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active';

      CREATE TABLE IF NOT EXISTS memory_facts (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT    NOT NULL,
        project_id    TEXT,
        resource_id   TEXT,
        thread_id     TEXT,
        subject_key   TEXT    NOT NULL,
        fact_text     TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        importance    REAL    NOT NULL DEFAULT 0.5,
        reference_count INTEGER NOT NULL DEFAULT 0,
        referenced_at INTEGER,
        valid_from    INTEGER NOT NULL,
        invalid_at    INTEGER,
        expired_at    INTEGER,
        status        TEXT    NOT NULL DEFAULT 'active',
        source_observation_range TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_hash    ON memory_facts (owner_id, content_hash);
      CREATE INDEX        IF NOT EXISTS idx_memory_facts_subject ON memory_facts (owner_id, project_id, resource_id, thread_id, subject_key);
      CREATE INDEX        IF NOT EXISTS idx_memory_facts_active  ON memory_facts (owner_id, status, expired_at);
    `,
  },
  {
    // Per-key human-readable NAME — a cosmetic label so an operator can tell which
    // project/client a key belongs to (the prefix alone is opaque). Additive +
    // nullable, so existing rows + fixtures are untouched (NULL = unnamed). Never an
    // auth/routing input.
    version: 19,
    sql: `
      ALTER TABLE api_keys ADD COLUMN name TEXT;
    `,
  },
  {
    // Auto-compaction model→price resolution: the alias of the model that served
    // the thread's latest turn, stamped best-effort by observeOutbound and read
    // back by the background observer to price the compaction ledger. Additive +
    // nullable (NULL = never stamped → the policy's price heuristics apply).
    version: 20,
    sql: `
      ALTER TABLE memory_threads ADD COLUMN last_served_model TEXT;
    `,
  },
  {
    // Idempotent memory-message ingest (re-ingestion bug fix). The client re-sends
    // the FULL transcript every turn; the old blind INSERT grew memory_messages
    // O(n²) (97% duplicate rows in prod) and starved the observer (re-inserted
    // rows get new ids, never covered by old observations → endless re-compaction).
    // Steps, ORDERED: (a) add nullable message_index/content_hash columns;
    // (b) collapse only complete occurrence-key collisions; legacy rows with no
    // occurrence key are preserved because duplicate ingest is indistinguishable
    // from legitimate repeated turns; (c) the UNIQUE boundary the write path
    // targets via ON CONFLICT DO NOTHING.
    // Historical rows keep NULL hashes/indexes until the ops script backfills them;
    // NULLs are DISTINCT in sqlite unique indexes, so the index still builds.
    version: 21,
    sql: `
      ALTER TABLE memory_messages ADD COLUMN message_index INTEGER;

      ALTER TABLE memory_messages ADD COLUMN content_hash TEXT;

      DELETE FROM memory_messages
      WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY thread_id, message_index, role, content_hash
                   ORDER BY created_at ASC, id ASC
                 ) AS rn
          FROM memory_messages
          WHERE message_index IS NOT NULL
            AND content_hash IS NOT NULL
        )
        WHERE rn > 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_messages_thread_idx_role_hash
        ON memory_messages (thread_id, message_index, role, content_hash);
    `,
  },
  {
    // Dashboard token accounting: denormalize the served completion's token counts
    // + served model onto telemetry for cheap SQL aggregation (SUM / GROUP BY) on
    // the admin homepage. All additive + nullable (NULL = pre-feature row / usage
    // not measured); forward-only — legacy rows stay NULL. The counts come from the
    // gateway's post-served usage stamp (DecisionRecord.usage); served_model mirrors
    // final.provider_model so the by-model breakdown needs no json_extract.
    version: 22,
    sql: `
      ALTER TABLE telemetry ADD COLUMN prompt_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN completion_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN cached_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN cache_creation_tokens INTEGER;

      ALTER TABLE telemetry ADD COLUMN served_model TEXT;
    `,
  },
  {
    // Timezone-aware OAuth usage: rebucket from UTC-DAY to UTC-HOUR so the providers
    // page can roll usage up by the ADMIN's LOCAL day at read time (the gateway is
    // tz-agnostic at write time, so it can only floor in UTC — the admin's offset is
    // known only on read). Pure rename: the write path now floors `now` to the hour
    // and the read path sums the hours inside the viewer's local day. Existing daily
    // rows (UTC-midnight) stay valid hour-floor values (the 00:00 UTC bucket); their
    // intra-day distribution is lost — acceptable for an observability artifact.
    version: 23,
    sql: `
      ALTER TABLE oauth_usage RENAME COLUMN day TO bucket_ms;

      DROP INDEX IF EXISTS idx_oauth_usage_day;

      CREATE INDEX IF NOT EXISTS idx_oauth_usage_bucket_ms ON oauth_usage (bucket_ms);
    `,
  },
  {
    // Forwarded-upstream request capture: the EXACT provider-native body sent
    // upstream (AFTER memory injection + protocol translation), so the admin
    // request detail shows what the model actually received — not just the
    // pre-injection client body. Additive + nullable (NULL = pre-feature row,
    // capture off, or no provider served); forward-only. Verbatim bytes, no
    // plaintext key (the bearer is an HTTP header, never the chat body).
    version: 24,
    sql: `
      ALTER TABLE request_payloads ADD COLUMN upstream_request_json TEXT;
    `,
  },
  {
    // True-TPS denominator: denormalize the served-stream generation window
    // (DecisionRecord.generation_ms — first→last forwarded chunk, gateway-timed) so
    // the dashboard's aggregate tokens/sec is a plain SUM, not a json_extract scan.
    // Additive + nullable (NULL = non-streaming / pre-feature row); forward-only —
    // legacy rows stay NULL and never count toward the rate.
    version: 25,
    sql: `
      ALTER TABLE telemetry ADD COLUMN generation_ms INTEGER;
    `,
  },
  {
    // OAuth account auto-park: a per-account cooldown the scheduler honors. When an
    // account hits its usage/rate limit (saturated quota window or a 429) it is
    // parked out of the pool until this epoch-ms timestamp, then auto-recovers. The
    // "Reset usage" admin action sets it back to NULL. Additive + nullable (NULL =
    // not limited = every pre-feature row); forward-only.
    version: 26,
    sql: `
      ALTER TABLE oauth_quota ADD COLUMN usage_limited_until_ms INTEGER;
    `,
  },
  {
    // Memory-job claim index (review M7): the worker's claimPendingJobs runs on every
    // tick + every debounced wake — WHERE status='pending' OR (status='running' AND
    // updated_at<=staleBefore) ORDER BY created_at, id. With no leading-status index it
    // was a full scan + sort of memory_jobs, which grows until the cleanup cadence
    // prunes finished rows. (status, created_at, id) serves the hot pending branch's
    // filter + order directly. Additive + idempotent; forward-only.
    version: 27,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim ON memory_jobs (status, created_at, id);
    `,
  },
  {
    // docs/14 / docs/12 P8 — hybrid fact retrieval. Three additions to memory_facts,
    // none depend on the sqlite-vec extension (so this migration ALWAYS applies, even
    // where the extension is absent — fail-open):
    //   1. embedding columns: the vector (BLOB of a Float32Array) + the model id +
    //      dim it was produced with (for lazy re-embed on a model change; never mix
    //      vectors from two models in one index).
    //   2. an FTS5 EXTERNAL-CONTENT table over fact_text with the `trigram` tokenizer
    //      — trigram indexes 3-char windows so it matches BOTH CJK (unicode61 collapses
    //      a Chinese run to one token) and Latin substrings without a segmenter.
    //      external-content stores ONLY the inverted index, not a copy of the text
    //      (lean — the request_payloads bloat lesson). Triggers keep it in sync;
    //      'rebuild' backfills existing rows.
    // The vec0 virtual table is NOT created here (its FLOAT[dim] width needs the
    // runtime embedding_dimensions); the store creates it lazily once the extension is
    // loaded and a dimension is known.
    version: 28,
    sql: `
      ALTER TABLE memory_facts ADD COLUMN embedding BLOB;
      ALTER TABLE memory_facts ADD COLUMN embedding_model TEXT;
      ALTER TABLE memory_facts ADD COLUMN embedding_dim INTEGER;

      CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
        fact_text,
        content='memory_facts',
        content_rowid='rowid',
        tokenize='trigram'
      );
      INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild');

      CREATE TRIGGER memory_facts_fts_ai AFTER INSERT ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(rowid, fact_text) VALUES (new.rowid, new.fact_text);
      END;
      CREATE TRIGGER memory_facts_fts_ad AFTER DELETE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact_text)
          VALUES('delete', old.rowid, old.fact_text);
      END;
      CREATE TRIGGER memory_facts_fts_au AFTER UPDATE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact_text)
          VALUES('delete', old.rowid, old.fact_text);
        INSERT INTO memory_facts_fts(rowid, fact_text) VALUES (new.rowid, new.fact_text);
      END;
    `,
  },
  {
    // Content-addressed image blob store (store/payload-blobs.ts). The base64
    // images Claude Code re-sends every turn were the entire 14 GB of the prod DB;
    // they now live ONCE here keyed by sha256 of the decoded bytes, and the
    // request_payloads columns hold only sentinels (+ gzipped remaining text). The
    // created_at index drives the same-cutoff retention prune as the payloads.
    version: 29,
    sql: `
      CREATE TABLE IF NOT EXISTS payload_blobs (
        sha256 TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payload_blobs_created_at ON payload_blobs (created_at);
    `,
  },
  {
    // Admin /requests list filters (docs/06): lane + decided_by were filtered via
    // json_extract(decision_json, …) — a full scan + per-row JSON parse. Promote
    // them to VIRTUAL generated columns + indexes so the filter is an index seek.
    // VIRTUAL (not STORED) adds NO per-row storage write-amplification — only the
    // index is materialized; the column is computed on read/index-build. `model`
    // stays json_extract on purpose: it's a LIKE-contains match, which no B-tree
    // index can serve anyway.
    version: 30,
    sql: `
      ALTER TABLE telemetry ADD COLUMN lane TEXT
        GENERATED ALWAYS AS (json_extract(decision_json, '$.lane.selected_lane')) VIRTUAL;
      ALTER TABLE telemetry ADD COLUMN decided_by TEXT
        GENERATED ALWAYS AS (json_extract(decision_json, '$.classifier.decided_by')) VIRTUAL;

      CREATE INDEX IF NOT EXISTS idx_telemetry_lane ON telemetry (lane);
      CREATE INDEX IF NOT EXISTS idx_telemetry_decided_by ON telemetry (decided_by);
    `,
  },
  {
    // Per-key Fast-mode passthrough cap (docs/06): additive boolean default false.
    // This controls only CLIENT-requested Fast fields; account-level Fast mode lives
    // in OAuth account settings and still forces Fast regardless of the key cap.
    version: 31,
    sql: `
      ALTER TABLE api_keys ADD COLUMN allow_fast_mode INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Admin dashboard aggregate hot path: /admin/api/stats was averaging
    // json_extract(decision_json, '$.latency_total_ms') across the whole telemetry
    // window. On production SQLite that forced table reads + JSON parsing for
    // every dashboard load and blocked Node's synchronous better-sqlite3 thread.
    // Denormalize the total latency and add covering indexes for the global and
    // per-key aggregate windows so SUM/COUNT/GROUP BY can scan narrow index pages.
    version: 32,
    sql: `
      ALTER TABLE telemetry ADD COLUMN latency_total_ms INTEGER;

      UPDATE telemetry
      SET latency_total_ms = CAST(json_extract(decision_json, '$.latency_total_ms') AS INTEGER)
      WHERE latency_total_ms IS NULL
        AND json_extract(decision_json, '$.latency_total_ms') IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_telemetry_admin_window_cover
        ON telemetry (
          created_at,
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
        ON telemetry (
          api_key_id,
          created_at,
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
    // Recoverable API keys (admin-only reveal + in-place rotation). Existing rows
    // remain hash-only and unrecoverable; new/rotated rows may store AES-GCM
    // ciphertext here. This is encrypted material, never raw plaintext.
    version: 33,
    run: (db) => {
      const cols = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
      if (cols.length === 0) {
        db.exec(`
          CREATE TABLE api_keys (
            key_id TEXT PRIMARY KEY,
            hash TEXT NOT NULL UNIQUE,
            prefix TEXT NOT NULL,
            secret_enc TEXT,
            account_id TEXT NOT NULL,
            role TEXT NOT NULL,
            name TEXT,
            allowed_lanes TEXT,
            allow_custom_model INTEGER NOT NULL DEFAULT 0,
            allow_fast_mode INTEGER NOT NULL DEFAULT 0,
            disabled INTEGER NOT NULL DEFAULT 0,
            rate_limit_rpm INTEGER,
            rate_limit_tpm INTEGER,
            budget_requests INTEGER,
            budget_tokens INTEGER,
            budget_spend_usd REAL,
            budget_window_seconds INTEGER,
            over_budget_behavior TEXT NOT NULL DEFAULT 'degrade',
            degrade_lane TEXT,
            concurrency_limit INTEGER,
            memory_mode TEXT NOT NULL DEFAULT 'off',
            memory_project_id TEXT,
            memory_thread_source TEXT NOT NULL DEFAULT 'header',
            created_at INTEGER NOT NULL
          );
        `);
        return;
      }
      if (!cols.some((c) => c.name === "secret_enc")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN secret_enc TEXT;");
      }
    },
  },
  {
    // Memory idle-flush catch-up indexes. The sweep now uses observer-order range
    // semantics and fair interleaving; keep the hot per-thread message scans and
    // owner/project thread scan off the table path on large self-hosted SQLite DBs.
    version: 34,
    run: (db) => {
      if (
        sqliteTableHasColumns(db, "memory_threads", ["owner_id", "project_id", "resource_id", "id"])
      ) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_memory_threads_owner_project_resource
            ON memory_threads (owner_id, project_id, resource_id, id);
        `);
      }
      if (
        sqliteTableHasColumns(db, "memory_messages", [
          "thread_id",
          "message_index",
          "created_at",
          "id",
        ])
      ) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_memory_messages_thread_order
            ON memory_messages (thread_id, message_index, created_at, id);
        `);
      }
    },
  },
];

function sqliteTableHasColumns(
  db: Database.Database,
  table: string,
  requiredColumns: readonly string[],
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.length === 0) return false;
  const names = new Set(cols.map((c) => c.name));
  return requiredColumns.every((name) => names.has(name));
}

function applyMigrations(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM _migrations")
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const record = db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
  const runAll = db.transaction((pending: readonly Migration[]) => {
    for (const m of pending) {
      if (m.run) m.run(db);
      else db.exec(m.sql);
      record.run(m.version, Date.now());
    }
  });
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length > 0) runAll(pending);
}

// Performance/durability pragmas applied to EVERY connection we open.
//
// better-sqlite3 is synchronous: each commit blocks Node's single event-loop
// thread, so write cost is felt by ALL in-flight requests, not just the writer.
// The default synchronous=FULL fsync()s on every commit — under concurrent
// streaming that serialises requests behind disk syncs and is the dominant source
// of "feels slow with 2 concurrent" latency. The pragmas below remove that cost:
//
//   - journal_mode=WAL   readers never block the single writer.
//   - synchronous=NORMAL drops the per-commit fsync; durability syncs move to
//                        checkpoint time. Safe under WAL — a crash/power-loss can
//                        lose the last few commits but NEVER corrupts the file. For
//                        a routing gateway's telemetry/usage bookkeeping that is an
//                        acceptable trade for the throughput.
//   - busy_timeout=5000  wait up to 5s for a lock instead of throwing SQLITE_BUSY
//                        instantly (defensive: migrations + the runtime handle can
//                        briefly contend the same file).
//   - temp_store=MEMORY  keep transient B-trees/sorts in RAM, off the disk path.
//   - cache_size=-16000  ~16MB page cache (negative => KiB) for the hot tables.
function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("cache_size = -16000");
}

// docs/14 — load the sqlite-vec extension on a connection so the vec0 virtual table
// (vector KNN) is available for hybrid recall's vector leg. FAIL-OPEN: if the
// extension can't load (no prebuilt binary for the platform, a sandbox blocking
// loadExtension), return false and the store runs FTS+score only — an optional
// accelerator must NEVER crash startup. sqliteVec.load() calls db.loadExtension(),
// which better-sqlite3 permits by default.
function loadVecExtension(sqlite: Database.Database): boolean {
  try {
    sqliteVec.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

// Apply migrations to a fresh or existing sqlite file (or ":memory:"). Idempotent.
// Throws on failure so the caller can fail-closed at startup.
export function runMigrations(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    applyPragmas(db);
    applyMigrations(db);
  } finally {
    db.close();
  }
}

// Open a connection, run migrations, and return a Drizzle instance bound to the
// schema. The underlying better-sqlite3 handle is exposed for lifecycle control.
export function createSqliteDb(dbPath: string): SqliteDb {
  const sqlite = new Database(dbPath);
  applyPragmas(sqlite);
  // Load sqlite-vec BEFORE migrations (harmless if a later migration ever needs it);
  // the result is surfaced on the db so the store knows whether the vector leg exists.
  const vecLoaded = loadVecExtension(sqlite);
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return Object.assign(db, { $sqlite: sqlite, $vecLoaded: vecLoaded });
}
