import { describe, expect, it } from "vitest";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteOAuthUsageStore } from "./oauth-usage.js";

const DAY = 86_400_000;
// A fixed UTC-midnight anchor + a couple of within-day instants.
const D1 = Date.UTC(2026, 5, 3); // 2026-06-03 00:00 UTC
const T0 = D1 + 60_000; // first call, +1 min
const T1 = D1 + 5 * 60_000; // later call, +5 min

function freshStore(): { store: SqliteOAuthUsageStore; close: () => void } {
  const db: SqliteDb = createSqliteDb(":memory:");
  return { store: new SqliteOAuthUsageStore(db), close: () => db.$sqlite.close() };
}

describe("SqliteOAuthUsageStore", () => {
  it("record folds served calls into one additive daily row", async () => {
    const { store, close } = freshStore();
    await store.record({
      providerId: "anthropic",
      account: "a",
      dayMs: D1,
      tokens: 100,
      costUsd: 0.01,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      dayMs: D1,
      tokens: 250,
      costUsd: 0.02,
      nowMs: T1,
    });
    const rows = await store.queryDay(D1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "anthropic",
      account: "a",
      requests: 2,
      tokens: 350,
      firstSeenMs: T0, // MIN across calls
    });
    expect(rows[0]?.costUsd).toBeCloseTo(0.03, 6);
    close();
  });

  it("cost stays NULL while never measured, becomes concrete once a cost arrives", async () => {
    const { store, close } = freshStore();
    // Two unpriced (flat-rate) calls → cost stays null.
    await store.record({
      providerId: "openai-codex",
      account: "a",
      dayMs: D1,
      tokens: 10,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "openai-codex",
      account: "a",
      dayMs: D1,
      tokens: 10,
      costUsd: null,
      nowMs: T1,
    });
    expect((await store.queryDay(D1))[0]?.costUsd).toBeNull();
    // A measured cost arrives → the running total is concrete (null treated as 0).
    await store.record({
      providerId: "openai-codex",
      account: "a",
      dayMs: D1,
      tokens: 10,
      costUsd: 0.05,
      nowMs: T1,
    });
    expect((await store.queryDay(D1))[0]?.costUsd).toBeCloseTo(0.05, 6);
    close();
  });

  it("isolates rows by (provider, account, day)", async () => {
    const { store, close } = freshStore();
    await store.record({
      providerId: "anthropic",
      account: "a",
      dayMs: D1,
      tokens: 1,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "b",
      dayMs: D1,
      tokens: 1,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      dayMs: D1 + DAY,
      tokens: 1,
      costUsd: null,
      nowMs: T0 + DAY,
    });
    expect(await store.queryDay(D1)).toHaveLength(2); // a + b on D1
    expect(await store.queryDay(D1 + DAY)).toHaveLength(1); // only a on D2
    close();
  });
});
