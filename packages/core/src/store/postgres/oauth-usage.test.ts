import type { OAuthQuotaSnapshot } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createPgliteDb, type PgDb } from "./migrate.js";
import { PgOAuthQuotaStore } from "./oauth-quota.js";
import { PgOAuthUsageStore } from "./oauth-usage.js";

// supabase == hosted Postgres; pglite runs the SAME pg-dialect adapters in-process
// so this validates the supabase path (incl. the null-aware cost CASE + LEAST) with
// no server.
const D1 = Date.UTC(2026, 5, 3);
const T0 = D1 + 60_000;
const T1 = D1 + 5 * 60_000;

describe("PgOAuthUsageStore (pglite)", () => {
  it("record folds served calls into one additive daily row", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
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
    expect(rows[0]).toMatchObject({ requests: 2, tokens: 350, firstSeenMs: T0 });
    expect(rows[0]?.costUsd).toBeCloseTo(0.03, 6);
    await db.$close();
  });

  it("cost stays NULL while never measured, becomes concrete once a cost arrives", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthUsageStore(db);
    await store.record({
      providerId: "openai-codex",
      account: "a",
      dayMs: D1,
      tokens: 10,
      costUsd: null,
      nowMs: T0,
    });
    expect((await store.queryDay(D1))[0]?.costUsd).toBeNull();
    await store.record({
      providerId: "openai-codex",
      account: "a",
      dayMs: D1,
      tokens: 10,
      costUsd: 0.05,
      nowMs: T1,
    });
    expect((await store.queryDay(D1))[0]?.costUsd).toBeCloseTo(0.05, 6);
    await db.$close();
  });
});

const snap = (over: Partial<OAuthQuotaSnapshot> = {}): OAuthQuotaSnapshot => ({
  providerId: "anthropic",
  account: "a",
  windows: [{ key: "5h", usedPercent: 6, resetsAtMs: 1_000, windowMinutes: null }],
  capturedAt: 500,
  source: "anthropic",
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
});
