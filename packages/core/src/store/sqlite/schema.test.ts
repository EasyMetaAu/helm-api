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
      "max_lane",
      "allowed_lanes",
      "allow_custom_model",
      "disabled",
      "created_at",
    ]) {
      expect(keyCols).toContain(c);
    }
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
      for (const v of [1, 2, 3, 4, 5]) rec.run(v, Date.now());
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
        maxLane: "balanced",
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
