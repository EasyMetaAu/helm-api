import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDb } from "./migrate.js";
import {
  assertVacuumDiskCapacity,
  assertVacuumMemoryCapacity,
  shouldRunVacuumForFreelist,
  vacuumSqlite,
} from "./vacuum.js";

const cleanup: string[] = [];
const safeMemory = { processLimitBytes: 1_000_000_000, availableMemoryBytes: 500_000_000 };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "helm-vacuum-worker-"));
  cleanup.push(dir);
  const path = join(dir, "helm.db");
  const db = createSqliteDb(path);
  return { db, path };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sqlite VACUUM worker", () => {
  it("runs off the main event loop and preserves existing data", async () => {
    const { db } = tempDb();
    try {
      db.$sqlite.exec("CREATE TABLE vacuum_probe (id INTEGER PRIMARY KEY, value BLOB)");
      db.$sqlite
        .prepare("INSERT INTO vacuum_probe (id, value) VALUES (1, ?), (2, ?)")
        .run(Buffer.from("keep"), Buffer.alloc(4 * 1024 * 1024));
      db.$sqlite.prepare("DELETE FROM vacuum_probe WHERE id = 2").run();
      expect(Number(db.$sqlite.pragma("freelist_count", { simple: true }))).toBeGreaterThan(0);

      let eventLoopTurned = false;
      const eventLoopTurn = new Promise<void>((resolve) =>
        setImmediate(() => {
          eventLoopTurned = true;
          resolve();
        }),
      );
      const vacuum = vacuumSqlite(db.$sqlite, {
        maintenanceCacheBytes: 1024 * 1024,
        ...safeMemory,
      });

      await eventLoopTurn;
      expect(eventLoopTurned).toBe(true);
      await vacuum;
      expect(db.$sqlite.prepare("SELECT value FROM vacuum_probe WHERE id = 1").get()).toEqual({
        value: Buffer.from("keep"),
      });
      expect(db.$sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.$sqlite.close();
    }
  });

  it("calculates the fail-closed disk requirement from the database and WAL sizes", () => {
    expect(() =>
      assertVacuumDiskCapacity({
        databaseBytes: 10_000n,
        walBytes: 2_000n,
        availableBytes: 23_999n,
      }),
    ).toThrow(/insufficient disk space/);
  });

  it("requires dynamic process memory headroom before starting the worker", () => {
    expect(() =>
      assertVacuumMemoryCapacity({
        processLimitBytes: 1_000_000_000,
        availableBytes: 249_999_999,
      }),
    ).toThrow(/insufficient memory/);
    expect(() =>
      assertVacuumMemoryCapacity({
        processLimitBytes: 1_000_000_000,
        availableBytes: 250_000_000,
      }),
    ).not.toThrow();
  });

  it("skips a full rewrite when free pages are below the database-relative threshold", () => {
    expect(shouldRunVacuumForFreelist({ freelistPages: 49, totalPages: 1_000 })).toBe(false);
    expect(shouldRunVacuumForFreelist({ freelistPages: 50, totalPages: 1_000 })).toBe(true);
  });

  it("fails closed when WAL checkpoint is busy and leaves data intact", async () => {
    const { db, path } = tempDb();
    const reader = new Database(path);
    try {
      reader.pragma("journal_mode = WAL");
      db.$sqlite.exec("CREATE TABLE checkpoint_probe (id INTEGER PRIMARY KEY, value TEXT)");
      db.$sqlite.prepare("INSERT INTO checkpoint_probe VALUES (1, 'keep')").run();
      db.$sqlite.pragma("wal_checkpoint(TRUNCATE)");
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM checkpoint_probe").get();
      db.$sqlite.prepare("INSERT INTO checkpoint_probe VALUES (2, 'after-reader')").run();
      db.$sqlite.exec("CREATE TABLE free_pages (value BLOB)");
      db.$sqlite.prepare("INSERT INTO free_pages VALUES (?)").run(Buffer.alloc(1024 * 1024));
      db.$sqlite.exec("DROP TABLE free_pages");

      await expect(
        vacuumSqlite(db.$sqlite, { maintenanceCacheBytes: 1024 * 1024, ...safeMemory }),
      ).rejects.toThrow(/checkpoint is busy/);
      expect(db.$sqlite.prepare("SELECT value FROM checkpoint_probe ORDER BY id").all()).toEqual([
        { value: "keep" },
        { value: "after-reader" },
      ]);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      db.$sqlite.close();
    }
  });

  it("does not rewrite a database with no free pages", async () => {
    const { db } = tempDb();
    try {
      expect(db.$sqlite.pragma("freelist_count", { simple: true })).toBe(0);
      await expect(
        vacuumSqlite(db.$sqlite, { maintenanceCacheBytes: 1024 * 1024, ...safeMemory }),
      ).resolves.toBeUndefined();
    } finally {
      db.$sqlite.close();
    }
  });
});
