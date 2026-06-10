import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDb, runMigrations } from "./migrate.js";

// Performance contract (perf-sqlite-fastpath): better-sqlite3 is SYNCHRONOUS, so
// every commit blocks Node's single event-loop thread. The default synchronous=FULL
// fsync()s on every commit — under concurrent streaming that serialises requests.
// These pragmas are the headline fix: NORMAL drops the per-commit fsync (safe under
// WAL — a crash can lose the last commits but never corrupts), busy_timeout avoids
// instant SQLITE_BUSY, and temp_store/cache_size keep scratch work in RAM.
describe("sqlite connection pragmas", () => {
  it("opens an in-memory connection with the performance pragmas applied", () => {
    const db = createSqliteDb(":memory:");
    try {
      const raw = db.$sqlite;
      // synchronous: 0=OFF, 1=NORMAL, 2=FULL. We want NORMAL.
      expect(raw.pragma("synchronous", { simple: true })).toBe(1);
      expect(raw.pragma("busy_timeout", { simple: true })).toBe(5000);
      // temp_store: 0=DEFAULT, 1=FILE, 2=MEMORY. We want MEMORY.
      expect(raw.pragma("temp_store", { simple: true })).toBe(2);
      // cache_size negative => KiB. ~16MB headroom for the hot tables.
      expect(raw.pragma("cache_size", { simple: true })).toBe(-16000);
    } finally {
      db.$sqlite.close();
    }
  });

  it("enables WAL journal mode on a file-backed database", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-pragma-"));
    const path = join(dir, "wal.db");
    try {
      const db = createSqliteDb(path);
      try {
        expect(db.$sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(db.$sqlite.pragma("synchronous", { simple: true })).toBe(1);
      } finally {
        db.$sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runMigrations leaves the file in WAL mode (persisted on disk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-pragma-"));
    const path = join(dir, "migrated.db");
    try {
      runMigrations(path);
      // Reopen with a fresh handle: WAL is a persistent file property, so it must
      // survive the migration connection closing.
      const db = createSqliteDb(path);
      try {
        expect(db.$sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      } finally {
        db.$sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
