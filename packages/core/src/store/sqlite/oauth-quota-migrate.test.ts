import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDb } from "./migrate.js";
import { SqliteOAuthQuotaStore } from "./oauth-quota.js";

// Migration v26 upgrade path: a real pre-v26 oauth_quota table (no
// usage_limited_until_ms column) must, on upgrade, gain the nullable column WITHOUT
// losing rows — and a legacy row reads back a null cooldown (not limited). Two
// connections can't share ":memory:", so the fixture lives on disk.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Seed a pre-v26 DB: ledger v1–v25 marked applied (so only v26 runs — v25 is the
// telemetry.generation_ms ALTER, out of scope for this oauth_quota-only fixture) and
// the OLD oauth_quota table (no usage_limited_until_ms) carrying one row.
function seedPreV26(): string {
  const dir = mkdtempSync(join(tmpdir(), "helm-oauth-quota-"));
  dirs.push(dir);
  const dbPath = join(dir, "test.db");
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const ins = raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, 1)");
  for (let v = 1; v <= 25; v += 1) ins.run(v);
  // v26 is this test's target (runs); v27 indexes memory_jobs, absent from this
  // oauth_quota-only fixture → pre-mark applied so only v26 runs.
  ins.run(27);
  // v28 alters memory_facts (+ FTS), absent from this oauth_quota-only fixture → pre-mark.
  ins.run(28);
  raw.exec(`
    CREATE TABLE oauth_quota (
      provider_id TEXT NOT NULL,
      account TEXT NOT NULL,
      windows TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (provider_id, account)
    );
  `);
  raw
    .prepare(
      "INSERT INTO oauth_quota (provider_id, account, windows, captured_at, source) VALUES (?, ?, ?, ?, ?)",
    )
    .run("openai-codex", "default", "[]", 500, "codex-headers");
  raw.close();
  return dbPath;
}

describe("oauth_quota usage_limited_until_ms migration (v26)", () => {
  it("adds the nullable column and the legacy row reads a null cooldown", async () => {
    const db = createSqliteDb(seedPreV26()); // applies v26
    try {
      const cols = db.$sqlite
        .prepare("PRAGMA table_info(oauth_quota)")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(cols).toContain("usage_limited_until_ms");

      // The legacy row survives and reads a null cooldown through the store.
      const store = new SqliteOAuthQuotaStore(db);
      const got = await store.get("openai-codex", "default");
      expect(got?.usageLimitedUntilMs).toBeNull();
      // And the new write path works against the upgraded table.
      await store.setUsageLimit("openai-codex", "default", 12_345);
      expect((await store.get("openai-codex", "default"))?.usageLimitedUntilMs).toBe(12_345);
    } finally {
      db.$sqlite.close();
    }
  });
});
