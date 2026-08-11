import type { MemoryFactInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { SqliteMemoryStore } from "../../store/sqlite/memory-store.js";
import { createSqliteDb } from "../../store/sqlite/migrate.js";
import { factContentHash } from "../forgetting/facts.js";
import type { Embedder } from "./embedder.js";
import { runEmbeddingJob } from "./embedding-job.js";

const NOW = new Date("2026-06-23T00:00:00.000Z");

function makeFact(text: string): MemoryFactInput {
  return {
    ownerId: "a",
    subjectKey: text.slice(0, 24),
    factText: text,
    contentHash: factContentHash(text),
    importance: 0.5,
    referenceCount: 0,
    referencedAt: null,
    validFrom: NOW,
    invalidAt: null,
    expiredAt: null,
    status: "active",
  };
}

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
};

function deps(store: SqliteMemoryStore, embedder: Embedder = fakeEmbedder) {
  return {
    memoryStore: store,
    embedder,
    model: "test-model",
    dim: 4,
    batchSize: 64,
    log: () => {},
  };
}

async function claimOne(
  store: SqliteMemoryStore,
): Promise<{ jobId: string; leaseGeneration?: number; scope: { accountId: string } }> {
  await store.enqueueJob({ type: "embedding", scope: { accountId: "a" } });
  const [job] = await store.claimPendingJobs(10);
  if (job === undefined) throw new Error("no job claimed");
  return { jobId: job.jobId, leaseGeneration: job.leaseGeneration, scope: job.scope };
}

describe("runEmbeddingJob (docs/14)", () => {
  it("embeds pending facts so they no longer need embedding (vector leg gets data)", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await store.insertFactsReconciled({
      accountId: "a",
      scope: {},
      now: NOW,
      facts: [makeFact("alpha note"), makeFact("beta note")],
    });
    await runEmbeddingJob(await claimOne(store), deps(store));
    const pending = await store.listFactsNeedingEmbedding?.({
      accountId: "a",
      model: "test-model",
      dim: 4,
      limit: 10,
    });
    expect(pending).toHaveLength(0);

    // the vector leg now returns results for a matching query embedding
    const hits = await store.searchFacts?.({
      accountId: "a",
      queryText: "zzz",
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      limit: 5,
      now: NOW,
      scoreConfig: {
        half_life_s: 86400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
      },
    });
    expect((hits ?? []).length).toBeGreaterThan(0);
  });

  it("no pending facts ⇒ job completes as a noop (never throws)", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await expect(runEmbeddingJob(await claimOne(store), deps(store))).resolves.toBeUndefined();
  });

  it("an embedder error fails the job cleanly (fail-open); facts stay pending for retry", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await store.insertFactsReconciled({
      accountId: "a",
      scope: {},
      now: NOW,
      facts: [makeFact("gamma note")],
    });
    const throwing: Embedder = {
      embed: async () => {
        throw new Error("embedder down");
      },
    };
    await expect(
      runEmbeddingJob(await claimOne(store), deps(store, throwing)),
    ).resolves.toBeUndefined();
    const pending = await store.listFactsNeedingEmbedding?.({
      accountId: "a",
      model: "test-model",
      dim: 4,
      limit: 10,
    });
    expect(pending).toHaveLength(1);
  });

  it("stops without completing or re-enqueueing when embedding publication is stale", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await store.insertFactsReconciled({
      accountId: "a",
      scope: {},
      now: NOW,
      facts: [makeFact("stale embedding")],
    });
    const sink = vi.spyOn(store, "setFactEmbeddings").mockResolvedValueOnce(false);
    const log = vi.fn();
    const job = await claimOne(store);

    await runEmbeddingJob(job, { ...deps(store), log });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        job: { id: job.jobId, leaseGeneration: job.leaseGeneration },
      }),
    );
    expect(log).toHaveBeenCalledWith("memory.embedding.stale", { account_id: "a" });
    expect((await store.claimPendingJobs(10)).some((next) => next.type === "embedding")).toBe(
      false,
    );
  });

  it("re-enqueues a follow-up job after a FULL batch so the backlog drains", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await store.insertFactsReconciled({
      accountId: "a",
      scope: {},
      now: NOW,
      facts: [makeFact("f1"), makeFact("f2"), makeFact("f3")],
    });
    // batchSize 2 with 3 pending → embeds 2, then re-enqueues for the remaining one.
    await runEmbeddingJob(await claimOne(store), { ...deps(store), batchSize: 2 });
    const pending = await store.listFactsNeedingEmbedding?.({
      accountId: "a",
      model: "test-model",
      dim: 4,
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    const next = await store.claimPendingJobs(10);
    expect(next.some((j) => j.type === "embedding")).toBe(true);
  });

  it("re-embeds when the configured dim changes (dim mismatch is flagged)", async () => {
    const store = new SqliteMemoryStore(createSqliteDb(":memory:"));
    await store.insertFactsReconciled({
      accountId: "a",
      scope: {},
      now: NOW,
      facts: [makeFact("delta")],
    });
    await runEmbeddingJob(await claimOne(store), deps(store)); // embeds at dim 4
    expect(
      await store.listFactsNeedingEmbedding?.({
        accountId: "a",
        model: "test-model",
        dim: 4,
        limit: 10,
      }),
    ).toHaveLength(0);
    // a DIFFERENT dim ⇒ the fact needs re-embedding
    expect(
      await store.listFactsNeedingEmbedding?.({
        accountId: "a",
        model: "test-model",
        dim: 8,
        limit: 10,
      }),
    ).toHaveLength(1);
  });
});
