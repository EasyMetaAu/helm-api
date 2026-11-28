import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { runPgMigrations } from "./postgres/migrate.js";
import { runMigrations } from "./sqlite/migrate.js";

it("adds SQLite virtual trace/session indexes and expires only legacy replay config on upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-debug-upgrade-"));
  const file = join(dir, "db.sqlite");
  let db = new Database(file);
  const before = Date.now();
  try {
    db.exec(`CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE telemetry(api_key_id TEXT, decision_json TEXT, created_at INTEGER);
      INSERT INTO telemetry VALUES('a', '{"trace_id":"legacy"}', 1);
      CREATE TABLE sessions(session_ref TEXT PRIMARY KEY, api_key_id TEXT, external_session_id TEXT);
      INSERT INTO sessions VALUES('ref', 'a', 'label');
      CREATE TABLE config_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO config_kv VALUES('portal.replay.receipt.old', '{}'), ('portal.replay.rate.a', '1'), ('permanent', 'keep');`);
    const seed = db.prepare("INSERT INTO _migrations VALUES(?,0)");
    for (let v = 1; v <= 59; v++) seed.run(v);
    db.close();
    runMigrations(file);
    runMigrations(file);
    db = new Database(file);
    expect(db.prepare("SELECT trace_id FROM telemetry").get()).toEqual({ trace_id: "legacy" });
    expect(db.pragma("table_xinfo(telemetry)")).toContainEqual(
      expect.objectContaining({ name: "trace_id", hidden: 2 }),
    );
    expect(
      JSON.stringify(
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM telemetry WHERE api_key_id='a' AND trace_id='legacy'",
          )
          .all(),
      ),
    ).toContain("idx_telemetry_key_trace");
    expect(
      JSON.stringify(
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT session_ref FROM sessions WHERE api_key_id='a' AND external_session_id='label'",
          )
          .all(),
      ),
    ).toContain("idx_sessions_key_label");
    const rows = db.prepare("SELECT key, expires_at FROM config_kv ORDER BY key").all();
    expect(rows).toEqual([
      { key: "permanent", expires_at: null },
      { key: "portal.replay.rate.a", expires_at: expect.any(Number) },
      { key: "portal.replay.receipt.old", expires_at: expect.any(Number) },
    ]);
    expect((rows[1] as { expires_at: number }).expires_at).toBeGreaterThanOrEqual(
      before + 7 * 86400_000,
    );
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("adds Postgres expression/session indexes without rewriting telemetry into a stored column", async () => {
  const client = await PGlite.create();
  const before = Date.now();
  try {
    await client.exec(`CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL);
      CREATE TABLE telemetry(api_key_id TEXT, decision_json JSONB, created_at BIGINT);
      INSERT INTO telemetry VALUES('a', '{"trace_id":"legacy"}', 1);
      CREATE TABLE sessions(session_ref TEXT PRIMARY KEY, api_key_id TEXT, external_session_id TEXT);
      INSERT INTO sessions VALUES('ref', 'a', 'label');
      CREATE TABLE config_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO config_kv VALUES('portal.replay.receipt.old', '{}'), ('portal.replay.rate.a', '1'), ('permanent', 'keep');`);
    for (let v = 1; v <= 58; v++) await client.query("INSERT INTO _migrations VALUES($1,0)", [v]);
    const db = drizzle(client);
    await runPgMigrations(db);
    await runPgMigrations(db);
    expect(
      (await client.query("SELECT decision_json->>'trace_id' AS trace FROM telemetry")).rows,
    ).toEqual([{ trace: "legacy" }]);
    await client.exec("SET enable_seqscan = off");
    expect(
      JSON.stringify(
        await client.query(
          "EXPLAIN SELECT * FROM telemetry WHERE api_key_id='a' AND decision_json->>'trace_id'='legacy'",
        ),
      ),
    ).toContain("idx_telemetry_key_trace");
    expect(
      JSON.stringify(
        await client.query(
          "EXPLAIN SELECT session_ref FROM sessions WHERE api_key_id='a' AND external_session_id='label'",
        ),
      ),
    ).toContain("idx_sessions_key_label");
    const rows = (
      await client.query<{ key: string; expires_at: number | null }>(
        "SELECT key, expires_at FROM config_kv ORDER BY key",
      )
    ).rows;
    expect(rows[0]).toEqual({ key: "permanent", expires_at: null });
    expect(Number(rows[1]?.expires_at)).toBeGreaterThanOrEqual(before + 7 * 86400_000);
    expect(Number(rows[2]?.expires_at)).toBeGreaterThanOrEqual(before + 7 * 86400_000);
  } finally {
    await client.close();
  }
});
