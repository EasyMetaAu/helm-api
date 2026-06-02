import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Schema = typeof schema;

// Drizzle instance bound to our schema, with the raw better-sqlite3 handle
// attached for lifecycle control. Named explicitly so the exported function's
// return type can be referenced across module boundaries (avoids TS4058).
export type SqliteDb = BetterSQLite3Database<Schema> & {
  readonly $sqlite: Database.Database;
};

// Checked-in, ordered migrations. Each runs exactly once per database; the
// _migrations table records applied versions so re-running is idempotent. We
// apply DDL directly (rather than via drizzle-kit's generated bundle) so the
// adapter is self-contained and needs no build-time codegen step.
interface Migration {
  readonly version: number;
  readonly sql: string;
}

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

      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
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
    // Account credit quotas / billing (Issue #37). Two NEW tables — additive,
    // existing rows untouched (append-only forward step; never edits a published
    // migration, see the v6 rebuild note above). `accounts` holds the live running
    // balance + tri-state quota (NULL inherit / 0 unlimited / number cap, mirroring
    // the rate-limit quota convention). `credit_ledger` is the append-only audit
    // trail; api_key_id is key_id ONLY (principle 7 — never plaintext/hashed). USD
    // columns are REAL (mirrors pg DOUBLE PRECISION); booleans are INTEGER (sqlite
    // has no native bool). NO telemetry.account_id column is added — credit_ledger
    // is the authoritative per-account spend source (telemetry is OpenAI-face only).
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        name TEXT,
        credit_balance_usd REAL NOT NULL DEFAULT 0,
        credit_quota_usd REAL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        request_id TEXT,
        api_key_id TEXT,
        amount_usd REAL NOT NULL,
        balance_after_usd REAL NOT NULL,
        kind TEXT NOT NULL,
        cost_measured INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_credit_ledger_account ON credit_ledger (account_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_debit_request
        ON credit_ledger (account_id, request_id)
        WHERE kind = 'debit' AND request_id IS NOT NULL;
    `,
  },
];

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
      db.exec(m.sql);
      record.run(m.version, Date.now());
    }
  });
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length > 0) runAll(pending);
}

// Apply migrations to a fresh or existing sqlite file (or ":memory:"). Idempotent.
// Throws on failure so the caller can fail-closed at startup.
export function runMigrations(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
  } finally {
    db.close();
  }
}

// Open a connection, run migrations, and return a Drizzle instance bound to the
// schema. The underlying better-sqlite3 handle is exposed for lifecycle control.
export function createSqliteDb(dbPath: string): SqliteDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return Object.assign(db, { $sqlite: sqlite });
}
