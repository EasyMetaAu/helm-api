import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDb } from "./migrate.js";

// Migration v21 upgrade path: a real pre-v21 memory_messages table (no
// content_hash/message_index, no unique index) carrying duplicate rows must, on
// upgrade, (a) collapse exact legacy duplicates keeping the EARLIEST row, (b)
// gain the content_hash/message_index columns, (c) gain the occurrence-aware
// UNIQUE(thread_id, message_index, role, content_hash) index.
// Mirrors the postgres migrate.test.ts pre-unique-index upgrade test.

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Seed a pre-v21 DB on disk (two connections can't share ":memory:") with the
// v1–v20 ledger marked applied so createSqliteDb runs ONLY v21. v22 (telemetry
// token columns) and v23 (oauth_usage day→bucket_ms rename) are also pre-marked:
// this fixture never creates telemetry nor oauth_usage, so those ALTER/RENAMEs would
// fail — keep the test scoped to the v21 message-dedup upgrade.
function seedPreV21(): string {
  const dir = mkdtempSync(join(tmpdir(), "helm-dedup-"));
  dirs.push(dir);
  const dbPath = join(dir, "test.db");
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const ins = raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, 1)");
  for (let v = 1; v <= 20; v += 1) ins.run(v);
  ins.run(22);
  ins.run(23);
  // v24 adds request_payloads.upstream_request_json; this fixture never creates
  // request_payloads (memory_messages only) → pre-mark applied (out of scope).
  ins.run(24);
  // v25 alters telemetry (absent from this memory_messages-only fixture) → pre-mark applied.
  ins.run(25);
  // v26 adds oauth_quota.usage_limited_until_ms; this fixture never creates
  // oauth_quota → pre-mark applied (out of scope).
  ins.run(26);
  // v27 indexes memory_jobs; this memory_messages-only fixture never creates it → pre-mark.
  ins.run(27);
  raw.exec(`
    CREATE TABLE memory_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const insMsg = raw.prepare(
    "INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Three copies of the SAME (thread, role, content) at increasing created_at,
  // plus one distinct message. Earliest of the dup group is "first".
  insMsg.run("first", "t1", "user", "dup", 1, 100);
  insMsg.run("second", "t1", "user", "dup", 1, 200);
  insMsg.run("third", "t1", "user", "dup", 1, 300);
  insMsg.run("other", "t1", "assistant", "unique", 1, 150);
  raw.close();
  return dbPath;
}

describe("memory_messages dedup migration (v21)", () => {
  it("collapses duplicates to the earliest row and adds the dedup columns", () => {
    const db = createSqliteDb(seedPreV21());
    try {
      const rows = db.$sqlite
        .prepare("SELECT id, content FROM memory_messages ORDER BY created_at")
        .all() as Array<{ id: string; content: string }>;
      // dup group collapsed to its earliest ("first"); distinct row kept.
      expect(rows.map((r) => r.id).sort()).toEqual(["first", "other"]);

      const cols = (
        db.$sqlite.prepare("PRAGMA table_info(memory_messages)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("content_hash");
      expect(cols).toContain("message_index");
    } finally {
      db.$sqlite.close();
    }
  });

  it("creates the UNIQUE index that rejects a duplicate occurrence key", () => {
    const db = createSqliteDb(seedPreV21());
    try {
      const idx = db.$sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("uniq_memory_messages_thread_idx_role_hash");
      expect(idx).toBeDefined();

      // A raw duplicate insert (same thread/message_index/role/content_hash) must be rejected.
      const ins = db.$sqlite.prepare(
        "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      ins.run(randomUUID(), "t2", 0, "user", "x", 1, 1, "hash-x");
      expect(() => ins.run(randomUUID(), "t2", 0, "user", "x", 1, 2, "hash-x")).toThrow();
      // Same content hash at a later transcript position is legitimate.
      expect(() => ins.run(randomUUID(), "t2", 1, "user", "x", 1, 3, "hash-x")).not.toThrow();
    } finally {
      db.$sqlite.close();
    }
  });
});
