import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSqliteDb, runMigrations } from "./migrate.js";
import { apiKeys } from "./schema.js";

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
