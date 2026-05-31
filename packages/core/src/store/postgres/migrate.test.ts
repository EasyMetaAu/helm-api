import type { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPgliteDb, runPgMigrations } from "./migrate.js";

// A statement-recording RawExecutor stand-in. `failOn` makes one matching
// statement throw, simulating a mid-migration failure so we can assert the
// per-migration transaction rolls back (no half-applied ledger).
function recorder(failOn?: (stmt: string) => boolean) {
  const stmts: string[] = [];
  const execute = async (query: ReturnType<typeof sql.raw>): Promise<unknown> => {
    // drizzle's sql.raw wraps the raw string in queryChunks[0].value (string[]).
    const chunks = (query as unknown as { queryChunks: Array<{ value: string[] }> }).queryChunks;
    const text = (chunks[0]?.value ?? []).join("");
    stmts.push(text);
    if (text.startsWith("SELECT version")) return [];
    if (failOn?.(text)) throw new Error(`boom: ${text}`);
    return [];
  };
  return { stmts, execute };
}

describe("runPgMigrations — per-migration atomicity", () => {
  it("wraps each migration's statements + ledger INSERT in a transaction", async () => {
    const rec = recorder();
    await runPgMigrations(rec);
    // Every migration block must open with BEGIN and close with COMMIT, and the
    // ledger INSERT for that version must fall BETWEEN them.
    const begins = rec.stmts.filter((s) => s === "BEGIN").length;
    const commits = rec.stmts.filter((s) => s === "COMMIT").length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(commits);
    const firstBegin = rec.stmts.indexOf("BEGIN");
    const firstInsert = rec.stmts.findIndex((s) => s.startsWith("INSERT INTO _migrations"));
    const firstCommit = rec.stmts.indexOf("COMMIT");
    expect(firstBegin).toBeLessThan(firstInsert);
    expect(firstInsert).toBeLessThan(firstCommit);
  });

  it("rolls back and never records the ledger row when a statement fails", async () => {
    // Fail on the first CREATE TABLE of migration v1.
    const rec = recorder((s) => s.startsWith("CREATE TABLE IF NOT EXISTS api_keys"));
    await expect(runPgMigrations(rec)).rejects.toThrow(/boom/);
    expect(rec.stmts).toContain("ROLLBACK");
    // The version-1 ledger INSERT must NOT have been issued.
    expect(rec.stmts.some((s) => /INSERT INTO _migrations.*VALUES \(1,/.test(s))).toBe(false);
  });

  it("still applies cleanly against a real PGlite database (idempotent)", async () => {
    const db = await createPgliteDb();
    // Re-running is a no-op (ledger already full); must not throw.
    await runPgMigrations(db);
    await db.$close();
  });
});
