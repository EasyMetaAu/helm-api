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
