import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteBudgetStore } from "./budget.js";
import { SqliteKeyStore } from "./keystore.js";
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
  it("atomically reserves one request without debiting rejected concurrent calls", async () => {
    const { store, close } = freshStore();
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.reserveRequest("k1", 1, DAY, 0)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.peek("k1", "req", 1, DAY, 0)).remaining).toBe(0);
      expect(await store.reserveRequest("k1", 1, DAY, DAY)).toBe(true);
    } finally {
      close();
    }
  });
});

describe("Sqlite fixed weekly budget", () => {
  const week = 7 * DAY;
  const anchor = Date.parse("2026-11-08T16:00:00Z");
  it("never refills midweek, resets exactly on the boundary and keeps keys isolated", async () => {
    const { store, close } = freshStore();
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
      close();
    }
  });
  it("atomically admits only N requests and starts the next cycle full", async () => {
    const { store, close } = freshStore();
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
      close();
    }
  });
});

it("preserves weekly limits across restart, secret rotation and unrelated key edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-weekly-"));
  const file = join(dir, "db.sqlite");
  let db = createSqliteDb(file);
  try {
    const anchor = "2026-11-08T16:00:00Z";
    const keys = new SqliteKeyStore(db);
    await keys.createKey({
      keyId: "k",
      hash: "old",
      prefix: "old",
      accountId: "a",
      role: "user",
      budgetRequests: 1,
      budgetWeeklyAnchor: anchor,
    });
    await new SqliteBudgetStore(db).reserveRequest(
      "k",
      1,
      604800000,
      Date.parse(anchor),
      Date.parse(anchor),
    );
    await keys.rotateKey("k", { hash: "new", prefix: "new" });
    await keys.updateKey("k", { name: "renamed" });
    db.$sqlite.close();
    db = createSqliteDb(file);
    expect(await new SqliteKeyStore(db).getByHash("new")).toMatchObject({
      budget_weekly_anchor: anchor,
      budget_requests: 1,
      name: "renamed",
    });
    expect(
      await new SqliteBudgetStore(db).reserveRequest(
        "k",
        1,
        604800000,
        Date.parse(anchor) + DAY,
        Date.parse(anchor),
      ),
    ).toBe(false);
  } finally {
    db.$sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
