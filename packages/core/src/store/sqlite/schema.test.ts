import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { createSqliteDb, runMigrations } from "./migrate.js";
import { apiKeys, rateLimitBuckets, routingSignals } from "./schema.js";

describe("sqlite schema + migrations", () => {
  it("applies cleanly to a fresh db and is idempotent on re-run", () => {
    // Use a real temp file so the second runMigrations() sees the first's state
    // (":memory:" is a brand-new db each call, which would not test idempotency).
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-"));
    const path = join(dir, "helm.db");
    try {
      expect(() => {
        runMigrations(path);
        runMigrations(path);
        runMigrations(path);
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a real pre-unique-index memory_jobs table with duplicate open jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v13-memory-jobs-"));
    const path = join(dir, "helm.db");
    const scope = JSON.stringify({ accountId: "acct-a", threadId: "t1" });
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // Seed everything EXCEPT the memory migrations (v14–v16) as applied, so
      // only they run — the minimal seed has no api_keys table for v10–v13/v17/v19,
      // and no memory_observations/reflections tables for the v18 forgetting
      // deltas, so both are pre-marked applied to keep this test scoped to v14–v16.
      // v20 (memory_threads.last_served_model) is also pre-marked: this fixture
      // never creates memory_threads (v2 is marked applied without the CREATE),
      // so the v20 ALTER would fail — out of scope for this v14–v16 test.
      // v21 (memory_messages dedup) likewise: v2 is applied without the
      // memory_messages CREATE, so its dedup DELETE would fail — out of scope.
      // v22 (telemetry token columns): this fixture never creates telemetry, so the
      // ALTER would fail — pre-mark applied, out of scope for this v14–v16 test.
      // v23 (oauth_usage day→bucket_ms): v12 is applied without the oauth_usage
      // CREATE, so the RENAME would fail — pre-mark applied, out of scope.
      // v24 adds request_payloads.upstream_request_json; this memory_jobs fixture
      // never creates request_payloads → pre-mark applied (out of scope).
      for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24])
        rec.run(v, Date.now());
      const insert = seed.prepare(
        "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("keep-earliest", "observer", scope, "pending", 100, 100);
      insert.run("close-pending", "observer", scope, "pending", 200, 200);
      insert.run("close-running", "observer", scope, "running", 300, 300);
      seed.close();

      expect(() => runMigrations(path)).not.toThrow();

      const after = new Database(path);
      const openRows = after
        .prepare(
          "SELECT id, status FROM memory_jobs WHERE type = ? AND scope_id = ? AND status IN ('pending','running') ORDER BY created_at, id",
        )
        .all("observer", scope) as Array<{ id: string; status: string }>;
      expect(openRows).toEqual([{ id: "keep-earliest", status: "pending" }]);
      const closedRows = after
        .prepare(
          "SELECT id, status, error FROM memory_jobs WHERE id IN ('close-pending','close-running')",
        )
        .all() as Array<{ id: string; status: string; error: string }>;
      expect(closedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "close-pending", status: "failed" }),
          expect.objectContaining({ id: "close-running", status: "failed" }),
        ]),
      );
      expect(closedRows.every((r) => r.error.includes("migration cleanup"))).toBe(true);
      expect(() =>
        after
          .prepare(
            "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("blocked-by-index", "observer", scope, "pending", 400, 400),
      ).toThrow();
      after.prepare("UPDATE memory_jobs SET status = 'done' WHERE id = 'keep-earliest'").run();
      expect(() =>
        after
          .prepare(
            "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("new-open-after-done", "observer", scope, "pending", 500, 500),
      ).not.toThrow();
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates api_keys and telemetry with the expected columns", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const keyCols = raw
      .prepare("PRAGMA table_info(api_keys)")
      .all()
      .map((c) => (c as { name: string }).name);
    const telCols = raw
      .prepare("PRAGMA table_info(telemetry)")
      .all()
      .map((c) => (c as { name: string }).name);

    for (const c of [
      "key_id",
      "hash",
      "prefix",
      "account_id",
      "role",
      "allowed_lanes",
      "allow_custom_model",
      "disabled",
      "created_at",
    ]) {
      expect(keyCols).toContain(c);
    }
    // max_lane was retired in v10 (drop column) — the ceiling is subsumed by
    // the allowed_lanes whitelist, so it must NOT survive on a fully migrated DB.
    expect(keyCols).not.toContain("max_lane");
    for (const c of [
      "id",
      "request_id",
      "api_key_id",
      "decision_json",
      "final_status",
      "cost_usd",
      "created_at",
    ]) {
      expect(telCols).toContain(c);
    }
    raw.close();
  });

  it("v6 rebuild relaxes cost_usd to REAL and preserves existing rows", () => {
    // Simulate an OLD database already migrated through v5 (INTEGER cost_usd)
    // carrying a telemetry row, then let runMigrations apply only v6.
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v6-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      // The seed marks versions 1-5 as applied, so the v1 api_keys table must
      // exist for the honest "old DB" simulation — later migrations (e.g. v8's
      // ALTER TABLE api_keys) depend on it.
      seed.exec(
        `CREATE TABLE api_keys (
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
        );`,
      );
      seed.exec(
        `CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          final_status TEXT,
          cost_usd INTEGER,
          created_at INTEGER NOT NULL
        );`,
      );
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // This fixture seeds only api_keys + telemetry (the tables v6 rewrites);
      // the v18 forgetting deltas target memory_observations/reflections, absent
      // from this minimal fixture, so v18 is pre-marked applied to keep the test
      // scoped to v6's cost_usd rebuild.
      // v20 alters memory_threads (absent from this fixture) → pre-mark applied.
      // v21 dedups memory_messages (absent: v2 marked applied without the CREATE)
      // → pre-mark applied.
      for (const v of [1, 2, 3, 4, 5, 18, 20, 21]) rec.run(v, Date.now());
      seed
        .prepare(
          "INSERT INTO telemetry (id, request_id, api_key_id, decision_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("t1", "req_old", "k1", "{}", 0.00321, Date.now());
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const type = (
        after.prepare("PRAGMA table_info(telemetry)").all() as Array<{
          name: string;
          type: string;
        }>
      ).find((c) => c.name === "cost_usd")?.type;
      expect(type).toBe("REAL");
      const row = after.prepare("SELECT cost_usd FROM telemetry WHERE id = ?").get("t1") as {
        cost_usd: number;
      };
      expect(row.cost_usd).toBeCloseTo(0.00321, 5);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v10 drops api_keys.max_lane on an existing DB while preserving the row", () => {
    // Simulate an OLD database already migrated through v9 (api_keys still HAS the
    // retired max_lane column) carrying a key row with a stored ceiling + a
    // whitelist, then let runMigrations apply v10 (the DROP COLUMN forward step).
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v10-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      // v1 shape + the v8 rate-limit columns — api_keys still carries max_lane.
      seed.exec(
        `CREATE TABLE api_keys (
          key_id TEXT PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          account_id TEXT NOT NULL,
          role TEXT NOT NULL,
          max_lane TEXT,
          allowed_lanes TEXT,
          allow_custom_model INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0,
          rate_limit_rpm INTEGER,
          rate_limit_tpm INTEGER,
          created_at INTEGER NOT NULL
        );`,
      );
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // This fixture seeds only api_keys; the v18 forgetting deltas target the
      // memory tables (absent here), so v18 is pre-marked applied to keep the
      // test scoped to v10's max_lane DROP COLUMN forward step.
      // v20 alters memory_threads (absent from this fixture) → pre-mark applied.
      // v21 dedups memory_messages (absent here) → pre-mark applied.
      // v22 alters telemetry (absent from this api_keys-only fixture) → pre-mark applied.
      // v24 adds request_payloads.upstream_request_json (table absent from this
      // api_keys-only fixture) → pre-mark applied.
      for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 18, 20, 21, 22, 24]) rec.run(v, Date.now());
      seed
        .prepare(
          `INSERT INTO api_keys (key_id, hash, prefix, account_id, role, max_lane, allowed_lanes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "k1",
          "h1",
          "helm_live_ab",
          "acct",
          "user",
          "premium",
          '["economy","balanced"]',
          Date.now(),
        );
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const cols = (
        after.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).not.toContain("max_lane");
      // The row (and its whitelist) survives the drop — only the ceiling column goes.
      const row = after.prepare("SELECT * FROM api_keys WHERE key_id = ?").get("k1") as {
        role: string;
        allowed_lanes: string;
      };
      expect(row.role).toBe("user");
      expect(row.allowed_lanes).toBe('["economy","balanced"]');
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares the composite PK on rate_limit_buckets (key_id, dim) — matches pg + onConflict target", () => {
    const cfg = getTableConfig(rateLimitBuckets);
    const pk = cfg.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(["key_id", "dim"]);
  });

  it("declares the composite PK on routing_signals (task_type, lane) — matches pg", () => {
    const cfg = getTableConfig(routingSignals);
    const pk = cfg.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(["task_type", "lane"]);
  });

  it("declares cost_usd as REAL (mirrors pg doublePrecision; no float truncation)", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const cols = raw.prepare("PRAGMA table_info(telemetry)").all() as Array<{
      name: string;
      type: string;
    }>;
    const costUsd = cols.find((c) => c.name === "cost_usd");
    expect(costUsd?.type).toBe("REAL");
    raw.close();
  });

  it("has NO plaintext column on api_keys", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const cols = raw
      .prepare("PRAGMA table_info(api_keys)")
      .all()
      .map((c) => (c as { name: string }).name);
    for (const forbidden of ["plaintext", "key", "secret", "token"]) {
      expect(cols).not.toContain(forbidden);
    }
    raw.close();
  });

  it("enforces a unique constraint on hash", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const insert = raw.prepare(
      "INSERT INTO api_keys (key_id, hash, prefix, account_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("k1", "samehash", "helm_live_a", "acct", "root", Date.now());
    expect(() => insert.run("k2", "samehash", "helm_live_b", "acct", "user", Date.now())).toThrow();
    raw.close();
  });

  it("maps boolean and array dialect types via Drizzle round-trip", () => {
    const db = createSqliteDb(":memory:");
    db.insert(apiKeys)
      .values({
        keyId: "k1",
        hash: "h1",
        prefix: "helm_live_a",
        accountId: "acct",
        role: "root",
        allowedLanes: JSON.stringify(["balanced", "economy"]),
        allowCustomModel: true,
        disabled: true,
        createdAt: new Date(),
      })
      .run();
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, "k1")).get();
    expect(row?.disabled).toBe(true);
    expect(row?.allowCustomModel).toBe(true);
    expect(JSON.parse(row?.allowedLanes ?? "[]")).toEqual(["balanced", "economy"]);
    db.$sqlite.close();
  });

  it("defaults disabled to false when not provided", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    raw
      .prepare(
        "INSERT INTO api_keys (key_id, hash, prefix, account_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("k1", "h1", "helm_live_a", "acct", "root", Date.now());
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, "k1")).get();
    expect(row?.disabled).toBe(false);
    expect(row?.allowCustomModel).toBe(false);
    raw.close();
  });
});
