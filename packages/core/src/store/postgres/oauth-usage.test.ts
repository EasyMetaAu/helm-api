import type { OAuthQuotaSnapshot } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createPgliteDb, type PgDb } from "./migrate.js";
import { PgOAuthQuotaStore } from "./oauth-quota.js";
import { PgOAuthResetPeriodStore } from "./oauth-reset-period.js";
import { PgOAuthUsageStore } from "./oauth-usage.js";

// supabase == hosted Postgres; pglite runs the SAME pg-dialect adapters in-process
// so this validates the supabase path (incl. the null-aware cost CASE + LEAST) with
// no server.
const HOUR = 3_600_000;
const H0 = Date.UTC(2026, 5, 3, 0); // an hour floor
const H1 = Date.UTC(2026, 5, 3, 1);
const T0 = H0 + 60_000;
const T1 = H0 + 5 * 60_000;

describe("PgOAuthUsageStore (pglite)", () => {
  it("queryRange rolls per-hour buckets up per account (and coerces pg's string SUMs)", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
    // Two calls in hour H0 + one in hour H1; all inside [H0, H0+2h).
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
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H1,
      tokens: 30,
      costUsd: null,
      nowMs: H1 + 60_000,
    });
    const rows = await store.queryRange(H0, H0 + 2 * HOUR);
    expect(rows).toHaveLength(1);
    // Numbers, not pg's bigint strings — toRow must coerce with Number().
    expect(rows[0]).toMatchObject({ requests: 3, tokens: 380, firstSeenMs: T0 });
    expect(rows[0]?.costUsd).toBeCloseTo(0.03, 6);
    await db.$close();
  });

  it("prunes usage in bounded database batches", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ deleted: 1_000 }] })
      .mockResolvedValueOnce({ rows: [{ deleted: "2" }] });
    const store = new PgOAuthUsageStore({ execute } as unknown as PgDb);

    await expect(store.pruneUsageOlderThan(2_000)).resolves.toBe(1_002);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("excludes hour buckets outside the window", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0 - HOUR, // before the window
      tokens: 999,
      costUsd: 9,
      nowMs: H0 - HOUR + 1000,
    });
    await store.record({
      providerId: "anthropic",
      account: "a",
      bucketMs: H0,
      tokens: 5,
      costUsd: null,
      nowMs: T0,
    });
    const rows = await store.queryRange(H0, H0 + HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 1, tokens: 5 });
    await db.$close();
  });

  it("queryBuckets returns raw un-grouped buckets for one account, ascending, half-open (coerces pg strings)", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
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
    const rows = await store.queryBuckets(H0, H0 + 2 * HOUR, "anthropic", "a");
    expect(rows).toHaveLength(2);
    // Numbers, not pg bigint strings.
    expect(rows[0]).toEqual({ bucketMs: H0, requests: 1, tokens: 100, costUsd: 0.01 });
    expect(rows[1]).toEqual({ bucketMs: H1, requests: 1, tokens: 30, costUsd: null });
    expect(await store.queryBuckets(H0, H0 + HOUR, "anthropic", "zzz")).toHaveLength(0);
    await db.$close();
  });

  it("cost stays NULL while never measured, becomes concrete once a cost arrives", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
    await store.record({
      providerId: "openai-codex",
      account: "a",
      bucketMs: H0,
      tokens: 10,
      costUsd: null,
      nowMs: T0,
    });
    expect((await store.queryRange(H0, H0 + HOUR))[0]?.costUsd).toBeNull();
    await store.record({
      providerId: "openai-codex",
      account: "a",
      bucketMs: H0,
      tokens: 10,
      costUsd: 0.05,
      nowMs: T1,
    });
    expect((await store.queryRange(H0, H0 + HOUR))[0]?.costUsd).toBeCloseTo(0.05, 6);
    await db.$close();
  });
});

const snap = (over: Partial<OAuthQuotaSnapshot> = {}): OAuthQuotaSnapshot => ({
  providerId: "anthropic",
  account: "a",
  windows: [{ key: "5h", usedPercent: 6, resetsAtMs: 1_000, windowMinutes: null }],
  capturedAt: 500,
  source: "anthropic",
  usageLimitedUntilMs: null,
  ...over,
});

describe("PgOAuthQuotaStore (pglite)", () => {
  it("upsert is latest-wins; getAll returns each account", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);
    await store.upsert(snap({ capturedAt: 500 }));
    await store.upsert(snap({ capturedAt: 999 }));
    expect((await store.get("anthropic", "a"))?.capturedAt).toBe(999);
    await store.upsert(snap({ account: "b" }));
    expect(await store.getAll()).toHaveLength(2);
    await db.$close();
  });

  it("round-trips reset credits and preserves them when a header snapshot omits the count", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);
    await store.upsert(
      snap({
        providerId: "openai-codex",
        source: "codex",
        resetCredits: 2,
      }),
    );
    expect((await store.get("openai-codex", "a"))?.resetCredits).toBe(2);

    await store.upsert(
      snap({
        providerId: "openai-codex",
        source: "codex-headers",
        capturedAt: 999,
        resetCredits: undefined,
      }),
    );
    expect((await store.get("openai-codex", "a"))?.resetCredits).toBe(2);
    await db.$close();
  });

  it("setUsageLimit upserts a synthetic row; a window upsert preserves the cooldown; null clears it", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);
    // 429 parks an account that has no snapshot yet → synthetic row carries the cooldown.
    await store.setUsageLimit("openai-codex", "fresh", 9_000);
    let got = await store.get("openai-codex", "fresh");
    expect(got?.usageLimitedUntilMs).toBe(9_000);
    expect(got?.windows).toEqual([]);
    // A later observability refresh must NOT clobber the active cooldown.
    await store.upsert(snap({ providerId: "openai-codex", account: "fresh", capturedAt: 1_234 }));
    got = await store.get("openai-codex", "fresh");
    expect(got?.usageLimitedUntilMs).toBe(9_000);
    expect(got?.capturedAt).toBe(1_234);
    // Reset (null) clears it.
    await store.setUsageLimit("openai-codex", "fresh", null);
    expect((await store.get("openai-codex", "fresh"))?.usageLimitedUntilMs).toBeNull();
    await db.$close();
  });

  it("marks a synthetic xAI cooldown row with the honest source", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);
    await store.setUsageLimit("xai", "subscription", 9_000);
    expect(await store.get("xai", "subscription")).toMatchObject({
      source: "xai",
      usageLimitedUntilMs: 9_000,
      windows: [],
    });
    await db.$close();
  });
});

describe("PgOAuthResetPeriodStore (pglite)", () => {
  it("record is idempotent; queryPeriods filters + orders most-recent first (coerces pg bigints)", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthResetPeriodStore(db);
    const base = {
      providerId: "anthropic",
      account: "a@x.com",
      windowKey: "5h",
      detectedAtMs: 19500,
      approximate: false,
    };
    await store.record({ ...base, periodStartMs: 1000, periodEndMs: 19000 });
    await store.record({ ...base, periodStartMs: 1000, periodEndMs: 19000, detectedAtMs: 99999 }); // dup PK → no-op
    await store.record({ ...base, periodStartMs: 19000, periodEndMs: 37000 });
    await store.record({ ...base, windowKey: "7d", periodStartMs: 1000, periodEndMs: 605000 }); // other window
    const rows = await store.queryPeriods("anthropic", "a@x.com", "5h", 10);
    expect(rows).toHaveLength(2);
    // numbers, not pg bigint strings; descending by periodEndMs
    expect(rows.map((r) => r.periodEndMs)).toEqual([37000, 19000]);
    expect(rows[1]?.detectedAtMs).toBe(19500); // first write wins
    await store.record({
      ...base,
      periodStartMs: 37000,
      periodEndMs: 38000,
      approximate: true,
    });
    expect((await store.queryPeriods("anthropic", "a@x.com", "5h", 1))[0]?.approximate).toBe(true);
    expect(await store.queryPeriods("anthropic", "nobody", "5h", 10)).toHaveLength(0);

    await store.record({ ...base, periodStartMs: 39000, periodEndMs: 40000, approximate: true });
    await store.record({ ...base, periodStartMs: 39000, periodEndMs: 41000, approximate: false });
    await store.record({ ...base, periodStartMs: 39000, periodEndMs: 42000, approximate: true });
    expect(await store.queryPeriods("anthropic", "a@x.com", "5h", 1)).toMatchObject([
      { periodEndMs: 41000, approximate: false },
    ]);

    await store.record({
      ...base,
      windowKey: "7d",
      periodStartMs: 37000,
      periodEndMs: 55000,
      detectedAtMs: 55000,
    });
    await store.record({
      ...base,
      windowKey: "7d",
      periodStartMs: 55000,
      periodEndMs: 90000,
      detectedAtMs: 60000,
    });
    await store.record({
      ...base,
      windowKey: "7d",
      periodStartMs: 60000,
      periodEndMs: 65000,
      detectedAtMs: 65000,
      approximate: true,
    });
    expect(await store.latestResetAt("anthropic", "a@x.com", 70000)).toBe(55000);
    expect(await store.latestResetAt("anthropic", "a@x.com", 70000, "5h")).toBe(19000);
    expect(await store.latestResetAt("anthropic", "nobody", 70000)).toBeNull();
    await db.$close();
  });
});
