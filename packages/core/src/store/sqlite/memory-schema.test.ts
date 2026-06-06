import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb, runMigrations } from "./migrate.js";

// docs/08 "storage model" — the 5 memory tables, their exact column sets, the
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

  it("ensureThread upserts owner/project/resource scope on duplicate thread id", async () => {
    const db = createSqliteDb(":memory:");
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const store = new SqliteMemoryStore(
      db,
      () => "obs-1",
      () => new Date(nowMs),
    );

    await store.ensureThread({ id: "t1" });
    nowMs += 1_000;
    await store.ensureThread({
      id: "t1",
      ownerId: "acct-a",
      projectId: "proj-1",
      resourceId: "res-1",
    });
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: ["m1", "m2"],
      observationText: "remember scoped detail",
      observedAt: new Date(nowMs),
    });

    const thread = db.$sqlite
      .prepare(
        "SELECT owner_id, project_id, resource_id, created_at, updated_at FROM memory_threads WHERE id = ?",
      )
      .get("t1") as {
      owner_id: string | null;
      project_id: string | null;
      resource_id: string | null;
      created_at: number;
      updated_at: number;
    };
    expect(thread).toMatchObject({
      owner_id: "acct-a",
      project_id: "proj-1",
      resource_id: "res-1",
    });
    expect(thread.updated_at).toBeGreaterThan(thread.created_at);
    await expect(
      store.listObservations({ accountId: "acct-a", projectId: "proj-1" }),
    ).resolves.toHaveLength(1);
    await expect(
      store.listObservations({ accountId: "acct-a", resourceId: "res-1" }),
    ).resolves.toHaveLength(1);
    await expect(store.listMessages({ accountId: "acct-a", threadId: "t1" })).resolves.toEqual([]);
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

// docs/12 "Schema deltas" (P2) — the v18 forgetting migration. Additive columns
// on memory_observations / memory_reflections + the new memory_facts long-tier
// table, all account-scoped (owner_id) per "Tenant isolation". With
// forgetting.enabled=false these columns simply carry defaults, so runtime is
// byte-identical to today; the migration must still apply cleanly on a fresh DB
// AND on a DB already at the previous (v17) version.
describe("sqlite v18 forgetting schema deltas", () => {
  function indexNames(raw: ReturnType<typeof createSqliteDb>["$sqlite"], table: string): string[] {
    return raw
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .map((i) => (i as { name: string }).name);
  }

  it("adds the forgetting columns to memory_observations", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    expect(tableCols(raw, "memory_observations")).toEqual(
      expect.arrayContaining([
        "reference_count",
        "importance",
        "status",
        "archived_at",
        "expired_at",
      ]),
    );
    raw.close();
  });

  it("adds reference tracking + status to memory_reflections", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    expect(tableCols(raw, "memory_reflections")).toEqual(
      expect.arrayContaining(["referenced_at", "reference_count", "status"]),
    );
    raw.close();
  });

  it("creates memory_facts with owner_id + bi-temporal columns and its indexes", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    expect(tableCols(raw, "memory_facts")).toEqual(
      expect.arrayContaining([
        "id",
        "owner_id",
        "project_id",
        "resource_id",
        "thread_id",
        "subject_key",
        "fact_text",
        "content_hash",
        "importance",
        "reference_count",
        "referenced_at",
        "valid_from",
        "invalid_at",
        "expired_at",
        "status",
        "source_observation_range",
        "created_at",
        "updated_at",
      ]),
    );
    expect(indexNames(raw, "memory_facts")).toEqual(
      expect.arrayContaining([
        "idx_memory_facts_hash",
        "idx_memory_facts_subject",
        "idx_memory_facts_active",
      ]),
    );
    raw.close();
  });

  it("dedup index is ACCOUNT-scoped: two accounts may assert the same content_hash", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const insert = raw.prepare(
      `INSERT INTO memory_facts
        (id, owner_id, subject_key, fact_text, content_hash, valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const hash = "h".repeat(64);
    const now = Date.now();
    insert.run("f-a", "acct-a", "s", "fact", hash, now, now, now);
    // Same content_hash, DIFFERENT owner → allowed (UNIQUE(owner_id, content_hash)).
    expect(() => insert.run("f-b", "acct-b", "s", "fact", hash, now, now, now)).not.toThrow();
    // Same content_hash, SAME owner → rejected by the unique index (idempotent ingest).
    expect(() => insert.run("f-a2", "acct-a", "s", "fact", hash, now, now, now)).toThrow();
    raw.close();
  });

  it("upgrades a real db already at v17 (memory tables present, no v18 yet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-mem-v17-"));
    const path = join(dir, "helm.db");
    try {
      // Seed a db that has the pre-forgetting memory tables and a _migrations
      // ledger marking everything THROUGH v17 as applied, so only v18 runs.
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY, project_id TEXT, resource_id TEXT, owner_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_observations (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
          source_message_range TEXT NOT NULL, observation_text TEXT NOT NULL,
          observed_at INTEGER NOT NULL, referenced_at INTEGER, priority INTEGER, tags TEXT
        );
        CREATE TABLE memory_reflections (
          id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, resource_id TEXT,
          thread_id TEXT, reflection_text TEXT NOT NULL, version INTEGER NOT NULL,
          token_estimate INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);
      // A legacy observation row with NO forgetting columns yet.
      seed
        .prepare(
          "INSERT INTO memory_observations (id, thread_id, source_message_range, observation_text, observed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("o-old", "t1", JSON.stringify(["m1", "m2"]), "old obs", Date.now());
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let v = 1; v <= 17; v++) rec.run(v, Date.now());
      // v19 (api_keys.name) is pre-marked applied too: this minimal seed has no
      // api_keys table, so its ALTER would fail — keep the test scoped to v18.
      rec.run(19, Date.now());
      seed.close();

      expect(() => runMigrations(path)).not.toThrow();

      const db = createSqliteDb(path);
      const raw = db.$sqlite;
      // v18 backfilled the new columns; the legacy row gets the defaults.
      const row = raw
        .prepare(
          "SELECT reference_count, importance, status, archived_at, expired_at FROM memory_observations WHERE id = ?",
        )
        .get("o-old") as {
        reference_count: number;
        importance: number;
        status: string;
        archived_at: number | null;
        expired_at: number | null;
      };
      expect(row).toMatchObject({
        reference_count: 0,
        importance: 0.5,
        status: "active",
        archived_at: null,
        expired_at: null,
      });
      expect(tableCols(raw, "memory_facts")).toContain("owner_id");
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
