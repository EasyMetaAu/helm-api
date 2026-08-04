import { describe, expect, it } from "vitest";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteOAuthUsageStore } from "./oauth-usage.js";

const HOUR = 3_600_000;
// Fixed UTC-hour anchors + a couple of within-hour instants.
const H0 = Date.UTC(2026, 5, 3, 0); // 2026-06-03 00:00 UTC (an hour floor)
const H1 = Date.UTC(2026, 5, 3, 1); // 2026-06-03 01:00 UTC
const T0 = H0 + 60_000; // first call, +1 min
const T1 = H0 + 5 * 60_000; // later call, +5 min

function freshStore(): { store: SqliteOAuthUsageStore; close: () => void } {
  const db: SqliteDb = createSqliteDb(":memory:");
  return { store: new SqliteOAuthUsageStore(db), close: () => db.$sqlite.close() };
}

describe("SqliteOAuthUsageStore", () => {
  it("record folds served calls in the same hour into one additive bucket", async () => {
    const { store, close } = freshStore();
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 100,
      costUsd: 0.01,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 250,
      costUsd: 0.02,
      nowMs: T1,
    });
    const rows = await store.queryRange(H0, H0 + HOUR);
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

  it("queryRange rolls up multiple hour buckets in the window and excludes those outside it", async () => {
    const { store, close } = freshStore();
    // H0 and H1 are both inside [H0, H0+2h); the hour BEFORE the window is excluded.
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 100,
      costUsd: 0.01,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H1,
      tokens: 30,
      costUsd: null,
      nowMs: H1 + 60_000,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0 - HOUR, // previous hour — OUTSIDE the window
      tokens: 999,
      costUsd: 9,
      nowMs: H0 - HOUR + 1000,
    });
    const rows = await store.queryRange(H0, H0 + 2 * HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "anthropic",
      account: "a",
      requests: 2, // H0 + H1 (the 999-token prior hour is excluded)
      tokens: 130,
      firstSeenMs: T0, // MIN across the window
    });
    expect(rows[0]?.costUsd).toBeCloseTo(0.01, 6); // 0.01 + null → 0.01 (null-aware)
    close();
  });

  it("cost stays NULL while never measured, becomes concrete once a cost arrives", async () => {
    const { store, close } = freshStore();
    // Two unpriced (flat-rate) calls → cost stays null.
    await store.record({
      providerId: "openai-codex",
      account: "a",
      bucketMs: H0,
      tokens: 10,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "openai-codex",
      account: "a",
      bucketMs: H0,
      tokens: 10,
      costUsd: null,
      nowMs: T1,
    });
    expect((await store.queryRange(H0, H0 + HOUR))[0]?.costUsd).toBeNull();
    // A measured cost arrives → the running total is concrete (null treated as 0).
    await store.record({
      providerId: "openai-codex",
      account: "a",
      bucketMs: H0,
      tokens: 10,
      costUsd: 0.05,
      nowMs: T1,
    });
    expect((await store.queryRange(H0, H0 + HOUR))[0]?.costUsd).toBeCloseTo(0.05, 6);
    close();
  });

  it("queryBuckets returns raw un-grouped buckets for one account, ascending, half-open", async () => {
    const { store, close } = freshStore();
    // Two buckets for account a, one for b, plus one for a OUTSIDE the window.
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 100,
      costUsd: 0.01,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H1,
      tokens: 30,
      costUsd: null,
      nowMs: H1 + 1000,
    });
    await store.record({
      providerId: "anthropic",
      account: "b",
      bucketMs: H0,
      tokens: 7,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0 + 2 * HOUR,
      tokens: 999,
      costUsd: 9,
      nowMs: T0,
    });
    // window [H0, H0+2h): includes H0 and H1, excludes H0+2h (end exclusive).
    const rows = await store.queryBuckets(H0, H0 + 2 * HOUR, "anthropic", "a");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ bucketMs: H0, requests: 1, tokens: 100, costUsd: 0.01 });
    expect(rows[1]).toEqual({ bucketMs: H1, requests: 1, tokens: 30, costUsd: null });
    // ascending by bucketMs
    expect((rows[0]?.bucketMs ?? 0) < (rows[1]?.bucketMs ?? 0)).toBe(true);
    // start inclusive: a bucket exactly at H0 is present; empty result for an account with none
    expect(await store.queryBuckets(H0, H0 + HOUR, "anthropic", "zzz")).toHaveLength(0);
    close();
  });

  it("isolates rows by (provider, account, bucket) and rolls each account separately", async () => {
    const { store, close } = freshStore();
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 1,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "b",
      bucketMs: H0,
      tokens: 1,
      costUsd: null,
      nowMs: T0,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H1,
      tokens: 4,
      costUsd: null,
      nowMs: H1 + 1000,
    });
    const rows = await store.queryRange(H0, H0 + 2 * HOUR);
    expect(rows).toHaveLength(2); // a + b
    const a = rows.find((r) => r.account === "a");
    const b = rows.find((r) => r.account === "b");
    expect(a).toMatchObject({ requests: 2, tokens: 5 }); // a's two hours summed
    expect(b).toMatchObject({ requests: 1, tokens: 1 });
    close();
  });
});
