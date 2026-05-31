import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb, runMigrations } from "./migrate.js";

// docs/08 "存储模型" — the 5 memory tables, their exact column sets, the
// source_message_range NOT NULL invariant, and isolation from routing/key tables.

function tableCols(raw: ReturnType<typeof createSqliteDb>["$sqlite"], table: string): string[] {
  return raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => (c as { name: string }).name);
}

describe("sqlite memory schema + migrations", () => {
  it("creates the 5 memory tables with the docs/08 column sets", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;

    expect(tableCols(raw, "memory_threads")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "resource_id",
        "owner_id",
        "created_at",
        "updated_at",
      ]),
    );
    expect(tableCols(raw, "memory_messages")).toEqual(
      expect.arrayContaining([
        "id",
        "thread_id",
        "role",
        "content",
        "token_estimate",
        "created_at",
      ]),
    );
    expect(tableCols(raw, "memory_observations")).toEqual(
      expect.arrayContaining([
        "id",
        "thread_id",
        "source_message_range",
        "observation_text",
        "observed_at",
        "referenced_at",
        "priority",
        "tags",
      ]),
    );
    expect(tableCols(raw, "memory_reflections")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "resource_id",
        "thread_id",
        "reflection_text",
        "version",
        "token_estimate",
        "updated_at",
      ]),
    );
    expect(tableCols(raw, "memory_jobs")).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "scope_id",
        "status",
        "error",
        "created_at",
        "updated_at",
      ]),
    );
    raw.close();
  });

  it("applies cleanly and is idempotent on re-run (fail-closed never silently)", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-mem-"));
    const path = join(dir, "helm.db");
    try {
      expect(() => {
        runMigrations(path);
        runMigrations(path);
        runMigrations(path);
      }).not.toThrow();
      const db = createSqliteDb(path);
      expect(tableCols(db.$sqlite, "memory_threads")).toContain("id");
      db.$sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces source_message_range NOT NULL on memory_observations", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    raw
      .prepare("INSERT INTO memory_threads (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("t1", Date.now(), Date.now());
    const insertMissing = raw.prepare(
      "INSERT INTO memory_observations (id, thread_id, observation_text, observed_at) VALUES (?, ?, ?, ?)",
    );
    expect(() => insertMissing.run("o1", "t1", "obs", Date.now())).toThrow();
    raw.close();
  });

  it("ensureThread + appendMessage round-trips role and token_estimate", async () => {
    const db = createSqliteDb(":memory:");
    const store = new SqliteMemoryStore(db);
    await store.ensureThread({ id: "t1", projectId: "p1", resourceId: "r1", ownerId: "o1" });
    const msgId = await store.appendMessage({
      threadId: "t1",
      role: "assistant",
      content: "hello",
      tokenEstimate: 3,
    });
    expect(msgId).toBeTruthy();
    const row = db.$sqlite
      .prepare("SELECT thread_id, role, content, token_estimate FROM memory_messages WHERE id = ?")
      .get(msgId) as {
      thread_id: string;
      role: string;
      content: string;
      token_estimate: number;
    };
    expect(row).toMatchObject({
      thread_id: "t1",
      role: "assistant",
      content: "hello",
      token_estimate: 3,
    });
    db.$sqlite.close();
  });

  it("ensureThread is idempotent (re-ensure does not throw or duplicate)", async () => {
    const db = createSqliteDb(":memory:");
    const store = new SqliteMemoryStore(db);
    await store.ensureThread({ id: "t1" });
    await store.ensureThread({ id: "t1" });
    const count = db.$sqlite
      .prepare("SELECT COUNT(*) AS n FROM memory_threads WHERE id = ?")
      .get("t1") as { n: number };
    expect(count.n).toBe(1);
    db.$sqlite.close();
  });

  it("memory tables are isolated: build without any routing/key tables present", () => {
    // A fresh db that only ran the migration set still has no FK coupling to
    // lanes/policies — memory_messages.thread_id references memory_threads only.
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const fks = raw
      .prepare("PRAGMA foreign_key_list(memory_messages)")
      .all()
      .map((f) => (f as { table: string }).table);
    for (const t of fks) {
      expect(["memory_threads"]).toContain(t);
    }
    raw.close();
  });
});
