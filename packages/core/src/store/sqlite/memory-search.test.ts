import type { MemoryFactInput } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/14 / docs/12 P8 — hybrid fact retrieval over sqlite. These pin the highest-risk
// decisions: CJK matches via the trigram tokenizer (unicode61 would not), account
// isolation, superseded facts stay hidden, and the vector leg (sqlite-vec) re-ranks.

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

function freshStore(): SqliteMemoryStore {
  return new SqliteMemoryStore(createSqliteDb(":memory:"));
}

describe("SqliteMemoryStore.searchFacts (hybrid recall)", () => {
  it("FTS-only: a CJK query matches via the trigram tokenizer (substring, mid-string)", async () => {
    const store = freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [
        makeFact("acct-a", "用户最喜欢的编程语言是 TypeScript"),
        makeFact("acct-a", "项目部署在 la.atmy.work"),
      ],
    });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "编程语言",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.map((f) => f.factText)).toContain("用户最喜欢的编程语言是 TypeScript");
  });

  it("is account-scoped: another account's matching fact never surfaces", async () => {
    const store = freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "编程语言是 TypeScript")],
    });
    await store.insertFactsReconciled({
      accountId: "acct-b",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-b", "编程语言机密信息")],
    });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "编程语言",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.every((f) => f.ownerId === "acct-a")).toBe(true);
    expect(hits?.map((f) => f.factText)).not.toContain("编程语言机密信息");
  });

  it("matches an English query via trigram too", async () => {
    const store = freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [
        makeFact("acct-a", "User prefers dark mode"),
        makeFact("acct-a", "Timezone is UTC+8"),
      ],
    });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "dark mode",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.map((f) => f.factText)).toContain("User prefers dark mode");
  });

  it("a soft-deleted (pruned + expired) fact never surfaces", async () => {
    const store = freshStore();
    const res = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "临时的编程语言笔记")],
    });
    const id = res.insertedIds[0];
    expect(id).toBeDefined();
    await store.deleteFact?.({ accountId: "acct-a", id: id as string, now: NOW });
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "编程语言",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.map((f) => f.factText)).not.toContain("临时的编程语言笔记");
  });

  it("vector leg: an embedding query recalls the nearest fact and RRF ranks it first", async () => {
    const store = freshStore();
    const res = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [
        makeFact("acct-a", "alpha note about cats", { importance: 0.9 }),
        makeFact("acct-a", "beta note about dogs", { importance: 0.1 }),
        makeFact("acct-a", "gamma note about birds", { importance: 0.1 }),
      ],
    });
    const [id0, id1, id2] = res.insertedIds;
    await store.setFactEmbeddings?.({
      accountId: "acct-a",
      items: [
        { factId: id0 as string, embedding: new Float32Array([1, 0, 0, 0]), model: "test", dim: 4 },
        { factId: id1 as string, embedding: new Float32Array([0, 1, 0, 0]), model: "test", dim: 4 },
        { factId: id2 as string, embedding: new Float32Array([0, 0, 1, 0]), model: "test", dim: 4 },
      ],
    });
    // queryText matches no fact (so FTS is empty); the vector points at id0. id0 also
    // has the top forgetting score (importance 0.9), so RRF puts it first deterministically.
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "zzz",
      queryEmbedding: new Float32Array([0.95, 0.05, 0, 0]),
      limit: 3,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.[0]?.id).toBe(id0);
    expect(hits?.map((f) => f.id)).toContain(id1);
  });

  it("sub-trigram fallback: a 2-char CJK query recalls via LIKE (trigram can't index it)", async () => {
    const store = freshStore();
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "本月的成本超出预算"), makeFact("acct-a", "无关记录")],
    });
    // '成本' is 2 chars → toFtsMatch returns null → the LIKE fallback restores recall.
    const hits = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "成本",
      limit: 10,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(hits?.map((f) => f.factText)).toContain("本月的成本超出预算");
  });

  it("editing a fact's text clears its stale vector (not recalled by the old embedding)", async () => {
    const store = freshStore();
    const res = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now: NOW,
      facts: [makeFact("acct-a", "old text about cats")],
    });
    const id = res.insertedIds[0] as string;
    await store.setFactEmbeddings?.({
      accountId: "acct-a",
      items: [{ factId: id, embedding: new Float32Array([1, 0, 0, 0]), model: "test", dim: 4 }],
    });
    const before = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "zzz",
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      limit: 5,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(before?.map((f) => f.id)).toContain(id);
    // editing the text clears embedding + drops the vec0 row → flagged for re-embed
    await store.updateFact?.({
      accountId: "acct-a",
      id,
      patch: { factText: "new text about dogs" },
      now: NOW,
    });
    expect(
      await store.listFactsNeedingEmbedding?.({
        accountId: "acct-a",
        model: "test",
        dim: 4,
        limit: 10,
      }),
    ).toHaveLength(1);
    const after = await store.searchFacts?.({
      accountId: "acct-a",
      queryText: "zzz",
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      limit: 5,
      now: NOW,
      scoreConfig: SCORE_CONFIG,
    });
    expect(after?.map((f) => f.id)).not.toContain(id);
  });
});
