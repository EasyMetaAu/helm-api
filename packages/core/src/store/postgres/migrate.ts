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

      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at BIGINT NOT NULL,
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
}

// Open an in-process PGlite database, run migrations, and return a drizzle handle
// bound to the schema. Used by the contract tests (and ephemeral local runs):
// supabase == hosted Postgres, so this pg-dialect coverage validates the supabase
// path WITHOUT a running server. `dataDir` omitted => a fresh in-memory database.
export async function createPgliteDb(dataDir?: string): Promise<PgDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
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
