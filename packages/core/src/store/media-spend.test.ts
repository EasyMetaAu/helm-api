import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { PgBudgetStore } from "./postgres/budget.js";
import * as pgSchema from "./postgres/schema.js";
import { SqliteBudgetStore } from "./sqlite/budget.js";
import * as sqliteSchema from "./sqlite/schema.js";

// Exercise this store in isolation; unrelated legacy Memory migrations are outside this task.
const ddl = `CREATE TABLE usage_budget_buckets (key_id TEXT NOT NULL,dim TEXT NOT NULL,tokens DOUBLE PRECISION NOT NULL,last_refill_ms BIGINT NOT NULL,PRIMARY KEY(key_id,dim));
CREATE TABLE weekly_budget_usage (key_id TEXT NOT NULL,dim TEXT NOT NULL,period_start_ms BIGINT NOT NULL,used DOUBLE PRECISION NOT NULL,PRIMARY KEY(key_id,dim,period_start_ms));
CREATE TABLE media_spend_records (id TEXT PRIMARY KEY,key_id TEXT NOT NULL,record_json TEXT NOT NULL);`;
function createSqliteDb(_path: string) {
  const raw = new Database(":memory:");
  raw.exec(ddl);
  return Object.assign(sqliteDrizzle(raw, { schema: sqliteSchema }), {
    $sqlite: raw,
    $vecLoaded: false,
  });
}
async function createPgliteDb() {
  const raw = await PGlite.create();
  await raw.exec(ddl);
  return Object.assign(pgDrizzle(raw, { schema: pgSchema }), { $close: () => raw.close() });
}
const record = {
  id: "operation-1",
  keyId: "key-1",
  alias: "minimax/speech",
  providerModel: "speech-2.8-hd",
  state: "reserved" as const,
  reservedUsd: 0.7,
  costUsd: null,
  capacity: 1,
  windowMs: 86400000,
  admittedAtMs: 1000,
  anchorMs: null,
  usage: null,
};
for (const kind of ["sqlite", "postgres"] as const)
  describe(`${kind} media spend`, () => {
    it("atomically holds money, retains unknown cost, settles once, and isolates owners", async () => {
      const db = kind === "sqlite" ? createSqliteDb(":memory:") : await createPgliteDb();
      const store =
        kind === "sqlite"
          ? new SqliteBudgetStore(db as ReturnType<typeof createSqliteDb>)
          : new PgBudgetStore(db as Awaited<ReturnType<typeof createPgliteDb>>);
      try {
        const holds = await Promise.all([
          store.reserveMediaSpend(record),
          store.reserveMediaSpend({ ...record, id: "operation-2" }),
        ]);
        expect(holds).toEqual([true, false]);
        expect((await store.peek(record.keyId, "usd", 1, 86400000, 1000)).remaining).toBeCloseTo(
          0.3,
        );
        expect(await store.getMediaSpend(record.id, "another-key")).toBeNull();
        await store.settleMediaSpend(
          record.id,
          record.keyId,
          { costUsd: null, usage: { usage_characters: 5 } },
          1000,
        );
        expect((await store.getMediaSpend(record.id, record.keyId))?.state).toBe("outcome_unknown");
        expect((await store.peek(record.keyId, "usd", 1, 86400000, 1000)).remaining).toBeCloseTo(
          0.3,
        );
        await store.settleMediaSpend(
          record.id,
          record.keyId,
          { costUsd: 0.2, usage: { usage_characters: 5 } },
          1000,
        );
        await store.settleMediaSpend(
          record.id,
          record.keyId,
          { costUsd: 0.2, usage: { usage_characters: 5 } },
          1000,
        );
        expect((await store.peek(record.keyId, "usd", 1, 86400000, 1000)).remaining).toBeCloseTo(
          0.8,
        );
        expect((await store.getMediaSpend(record.id, record.keyId))?.costUsd).toBe(0.2);
        // Duplicate IDs roll back their attempted debit, including in another key's scope.
        await expect(store.reserveMediaSpend({ ...record, keyId: "key-2" })).rejects.toThrow();
        expect((await store.peek("key-2", "usd", 1, 86400000, 1000)).remaining).toBe(1);
        const weekly = {
          ...record,
          id: "weekly",
          keyId: "weekly-key",
          admittedAtMs: 1000,
          anchorMs: 0,
        };
        expect(await store.reserveMediaSpend(weekly)).toBe(true);
        await store.settleMediaSpend(
          weekly.id,
          weekly.keyId,
          { costUsd: 0, usage: null },
          8 * 86400000,
        );
        expect((await store.peek(weekly.keyId, "usd", 1, 7 * 86400000, 1000, 0)).remaining).toBe(1);
        expect(
          (await store.peek(weekly.keyId, "usd", 1, 7 * 86400000, 8 * 86400000, 0)).remaining,
        ).toBe(1);
      } finally {
        if ("$sqlite" in db) db.$sqlite.close();
        else await db.$close();
      }
    });
  });
