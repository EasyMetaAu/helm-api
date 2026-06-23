import type { MemoryFactInput } from "@helm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

// docs/14 / docs/12 P8 — hybrid fact retrieval over Postgres (pg mirror of the sqlite
// suite). FTS via tsvector('simple') + the vector leg via pgvector (<=>), fused by RRF.
// 'simple' does not segment CJK, so the FTS cases use English (the vector leg carries
// cross-lingual recall in production); these pin account isolation + the pgvector path.

const SCORE_CONFIG = {
  half_life_s: 86400,
  importance_floor: 0.1,
  importance_ceil: 1.0,
  access_weight: 0.15,
};
const NOW = new Date("2026-06-23T00:00:00.000Z");

function makeFact(
  ownerId: string,
  factText: string,
  over: Partial<MemoryFactInput> = {},
): MemoryFactInput {
  return {
    ownerId,
    subjectKey: factText.slice(0, 24),
    factText,
    contentHash: factContentHash(factText),
    importance: 0.5,
    referenceCount: 0,
    referencedAt: null,
    validFrom: NOW,
    invalidAt: null,
    expiredAt: null,
    status: "active",
    ...over,
  };
}

describe("PgMemoryStore.searchFacts (hybrid recall, pg mirror)", () => {
  let closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
  });
  async function freshStore(): Promise<PgMemoryStore> {
    const db = await createPgliteDb();
    closers.push(() => db.$close());
    return new PgMemoryStore(db);
  }

  it("FTS leg: an English query matches via tsvector('simple'), account-scoped", async () => {
    const store = await freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "user prefers dark mode"), makeFact("acct-a", "timezone is utc8")],
    });
    await store.insertFactsReconciled({
      accountId: "acct-b",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-b", "dark secret mode")],
    });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "dark mode",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    const texts = (hits ?? []).map((f) => f.factText);
    expect(texts).toContain("user prefers dark mode");
    expect((hits ?? []).every((f) => f.ownerId === "acct-a")).toBe(true);
    expect(texts).not.toContain("dark secret mode");
  });

  it("vector leg: an embedding query recalls the nearest fact via pgvector (<=>)", async () => {
    const store = await freshStore();
    const res = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "alpha", { importance: 0.9 }), makeFact("acct-a", "beta")],
    });
    const [id0, id1] = res.insertedIds;
    await store.setFactEmbeddings?.({
      accountId: "acct-a",
      items: [
        { factId: id0 as string, embedding: new Float32Array([1, 0, 0, 0]), model: "test", dim: 4 },
        { factId: id1 as string, embedding: new Float32Array([0, 1, 0, 0]), model: "test", dim: 4 },
      ],
    });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "zzz",
      queryEmbedding: new Float32Array([0.95, 0.05, 0, 0]),
      limit: 2,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.[0]?.id).toBe(id0);
  });

  it("listFactsNeedingEmbedding lists un-embedded facts, then clears after a write", async () => {
    const store = await freshStore();
    const res = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "gamma fact")],
    });
    let pending = await store.listFactsNeedingEmbedding?.({
      accountId: "acct-a",
      model: "m",
      dim: 4,
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    await store.setFactEmbeddings?.({
      accountId: "acct-a",
      items: [
        {
          factId: res.insertedIds[0] as string,
          embedding: new Float32Array([1, 0, 0, 0]),
          model: "m",
          dim: 4,
        },
      ],
    });
    pending = await store.listFactsNeedingEmbedding?.({
      accountId: "acct-a",
      model: "m",
      dim: 4,
      limit: 10,
    });
    expect(pending).toHaveLength(0);
  });

  it("ILIKE fallback: a CJK substring query recalls via fact_text when tsquery can't segment", async () => {
    const store = await freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "本月的成本超出预算"), makeFact("acct-a", "无关记录")],
    });
    // '成本' (2 chars, no spaces) won't tokenize under tsvector('simple') → ILIKE leg.
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "成本",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect((hits ?? []).map((f) => f.factText)).toContain("本月的成本超出预算");
  });
});
