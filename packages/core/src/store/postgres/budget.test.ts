import { describe, expect, it } from "vitest";
import { PgBudgetStore } from "./budget.js";
import { createPgliteDb, type PgDb } from "./migrate.js";

const DAY = 86_400_000;

async function freshStore(): Promise<{ store: PgBudgetStore; db: PgDb }> {
  const db = await createPgliteDb();
  return { store: new PgBudgetStore(db), db };
}

describe("PgBudgetStore", () => {
  it("peek on a cold bucket reads FULL capacity", async () => {
    const { store, db } = await freshStore();
    const r = await store.peek("k1", "usd", 10, DAY, 0);
    expect(r.remaining).toBe(10);
    expect(r.ok).toBe(true);
    await db.$close();
  });

  it("debit subtracts the settled amount and persists; peek reflects it", async () => {
    const { store, db } = await freshStore();
    await store.debit("k1", "usd", 10, DAY, 4, 0);
    const r = await store.peek("k1", "usd", 10, DAY, 0);
    expect(r.remaining).toBeCloseTo(6, 5);
    await db.$close();
  });

  it("debit may go NEGATIVE (soft cap)", async () => {
    const { store, db } = await freshStore();
    const r = await store.debit("k1", "usd", 10, DAY, 12, 0);
    expect(r.remaining).toBeCloseTo(-2, 5);
    expect((await store.peek("k1", "usd", 10, DAY, 0)).ok).toBe(false);
    await db.$close();
  });

  it("refills over the configured window", async () => {
    const { store, db } = await freshStore();
    await store.debit("k1", "tok", 100, DAY, 100, 0);
    expect((await store.peek("k1", "tok", 100, DAY, DAY / 2)).remaining).toBeCloseTo(50, 5);
    await db.$close();
  });

  it("concurrent debits on the same bucket do not lose an update (FOR UPDATE)", async () => {
    const { store, db } = await freshStore();
    await Promise.all([
      store.debit("k1", "req", 100, DAY, 10, 0),
      store.debit("k1", "req", 100, DAY, 10, 0),
      store.debit("k1", "req", 100, DAY, 10, 0),
    ]);
    const r = await store.peek("k1", "req", 100, DAY, 0);
    expect(r.remaining).toBeCloseTo(70, 5); // 100 - 3*10, none lost
    await db.$close();
  });
  it("atomically reserves one request without debiting rejected concurrent calls", async () => {
    const { store, db } = await freshStore();
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.reserveRequest("k1", 1, DAY, 0)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.peek("k1", "req", 1, DAY, 0)).remaining).toBe(0);
      expect(await store.reserveRequest("k1", 1, DAY, DAY)).toBe(true);
    } finally {
      await db.$close();
    }
  });
});

describe("Pg fixed weekly budget", () => {
  const week = 7 * DAY;
  const anchor = Date.parse("2026-11-08T16:00:00Z");
  it("never refills midweek, resets exactly on the boundary and keeps keys isolated", async () => {
    const { store, db } = await freshStore();
    try {
      await store.debit("weekly", "tok", 100, week, 100, anchor, anchor);
      expect(
        (await store.peek("weekly", "tok", 100, week, anchor + week - 1, anchor)).remaining,
      ).toBe(0);
      expect((await store.peek("weekly", "tok", 100, week, anchor + week, anchor)).remaining).toBe(
        100,
      );
      expect((await store.peek("other", "tok", 100, week, anchor + DAY, anchor)).remaining).toBe(
        100,
      );
      // Changing a cap preserves consumption; changing modes preserves the old rolling bucket.
      expect((await store.peek("weekly", "tok", 150, week, anchor + DAY, anchor)).remaining).toBe(
        50,
      );
      expect((await store.peek("weekly", "tok", 100, week, anchor + DAY)).remaining).toBe(100);
    } finally {
      await db.$close();
    }
  });
  it("atomically admits only N requests and starts the next cycle full", async () => {
    const { store, db } = await freshStore();
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          store.reserveRequest("weekly", 2, week, anchor + DAY, anchor),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await store.reserveRequest("weekly", 2, week, anchor + week - 1, anchor)).toBe(false);
      expect(await store.reserveRequest("weekly", 2, week, anchor + week, anchor)).toBe(true);
      await store.debit("weekly", "usd", 10, week, 12, anchor, anchor);
      expect((await store.peek("weekly", "usd", 10, week, anchor + DAY, anchor)).remaining).toBe(
        -2,
      );
      expect(
        (await store.peek("weekly", "usd", 10, week, anchor + 3 * week, anchor)).remaining,
      ).toBe(10);
    } finally {
      await db.$close();
    }
  });
});
