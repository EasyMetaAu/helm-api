import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDb } from "./migrate.js";
import { SqliteOAuthUsageStore } from "./oauth-usage.js";

// Migration v23 upgrade path: a real pre-v23 oauth_usage table (column `day` =
// UTC-midnight epoch ms, with the idx_oauth_usage_day index) must, on upgrade,
// rename `day` -> `bucket_ms` WITHOUT losing rows — the historical daily rows stay
// readable through queryRange (re-interpreted as the 00:00 UTC-hour bucket). Mirrors
// the memory-dedup pre-vN upgrade tests. Two connections can't share ":memory:", so
// the fixture lives on disk.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const D1 = Date.UTC(2026, 5, 3); // 2026-06-03 00:00 UTC (also an hour floor)

// Seed a pre-v23 DB on disk: ledger v1–v22 marked applied (so only v23 runs) and
// the OLD oauth_usage table (column `day`) carrying two rows.
function seedPreV23(): string {
  const dir = mkdtempSync(join(tmpdir(), "helm-oauth-usage-"));
  dirs.push(dir);
  const dbPath = join(dir, "test.db");
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const ins = raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, 1)");
  for (let v = 1; v <= 22; v += 1) ins.run(v);
  raw.exec(`
    CREATE TABLE oauth_usage (
      provider_id TEXT NOT NULL,
      account TEXT NOT NULL,
      day INTEGER NOT NULL,
      requests INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      cost_usd REAL,
      first_seen_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, account, day)
    );
    CREATE INDEX idx_oauth_usage_day ON oauth_usage (day);
  `);
  const insRow = raw.prepare(
    "INSERT INTO oauth_usage (provider_id, account, day, requests, tokens, cost_usd, first_seen_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insRow.run("anthropic", "a", D1, 120, 10, 0.5, D1 + 60_000, D1 + 120_000);
  insRow.run("anthropic", "b", D1, 5, 1, null, D1, D1);
  raw.close();
  return dbPath;
}

describe("oauth_usage day->bucket_ms migration (v23)", () => {
  it("renames the column and keeps existing rows readable via queryRange", async () => {
    const db = createSqliteDb(seedPreV23()); // applies v23
    try {
      // The column was renamed (and the index re-pointed).
      const cols = db.$sqlite
        .prepare("PRAGMA table_info(oauth_usage)")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(cols).toContain("bucket_ms");
      expect(cols).not.toContain("day");

      // The two legacy rows survive: querying the day's first hour rolls them up.
      const store = new SqliteOAuthUsageStore(db);
      const rows = await store.queryRange(D1, D1 + HOUR);
      expect(rows).toHaveLength(2);
      const a = rows.find((r) => r.account === "a");
      const b = rows.find((r) => r.account === "b");
      expect(a).toMatchObject({ requests: 120, tokens: 10, firstSeenMs: D1 + 60_000 });
      expect(a?.costUsd).toBeCloseTo(0.5, 6);
      expect(b).toMatchObject({ requests: 5, tokens: 1 });
      expect(b?.costUsd).toBeNull(); // unpriced stays null
    } finally {
      db.$sqlite.close();
    }
  });
});
