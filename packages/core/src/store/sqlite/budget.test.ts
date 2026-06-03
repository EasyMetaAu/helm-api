import { describe, expect, it } from "vitest";
import { SqliteBudgetStore } from "./budget.js";
import { createSqliteDb, type SqliteDb } from "./migrate.js";

const DAY = 86_400_000;

function freshStore(): { store: SqliteBudgetStore; close: () => void } {
  const db: SqliteDb = createSqliteDb(":memory:");
  return { store: new SqliteBudgetStore(db), close: () => db.$sqlite.close() };
}

describe("SqliteBudgetStore", () => {
  it("peek on a cold bucket reads FULL capacity (the key has its whole budget)", async () => {
    const { store, close } = freshStore();
    const r = await store.peek("k1", "usd", 10, DAY, 0);
    expect(r.remaining).toBe(10);
    expect(r.ok).toBe(true);
    close();
  });

  it("peek is READ-ONLY (does not persist a refill / debit)", async () => {
    const { store, close } = freshStore();
    await store.peek("k1", "req", 5, DAY, 0);
    // A subsequent debit still starts from the full bucket (peek wrote nothing).
    const r = await store.debit("k1", "req", 5, DAY, 1, 0);
    expect(r.remaining).toBe(4);
    close();
  });

  it("debit subtracts the settled amount and persists", async () => {
    const { store, close } = freshStore();
    await store.debit("k1", "usd", 10, DAY, 4, 0);
    const r = await store.peek("k1", "usd", 10, DAY, 0);
    expect(r.remaining).toBeCloseTo(6, 5);
    expect(r.ok).toBe(true);
    close();
  });

  it("debit may push the bucket NEGATIVE (soft cap, settled post-served)", async () => {
    const { store, close } = freshStore();
    // Spend 12 against a 10 cap in one settle — over budget by 2.
    const r = await store.debit("k1", "usd", 10, DAY, 12, 0);
    expect(r.remaining).toBeCloseTo(-2, 5);
    const peek = await store.peek("k1", "usd", 10, DAY, 0);
    expect(peek.ok).toBe(false); // remaining <= 0 => over budget
    close();
  });

  it("refills over the configured window (rolling, no hard reset)", async () => {
    const { store, close } = freshStore();
    await store.debit("k1", "usd", 10, DAY, 10, 0); // empty at t=0
    expect((await store.peek("k1", "usd", 10, DAY, 0)).remaining).toBeCloseTo(0, 5);
    // Half a day later, half the budget has refilled.
    expect((await store.peek("k1", "usd", 10, DAY, DAY / 2)).remaining).toBeCloseTo(5, 5);
    close();
  });

  it("two sequential debits accumulate atomically (no lost update)", async () => {
    const { store, close } = freshStore();
    await store.debit("k1", "tok", 100, DAY, 30, 0);
    const r = await store.debit("k1", "tok", 100, DAY, 30, 0);
    expect(r.remaining).toBeCloseTo(40, 5);
    close();
  });
});
