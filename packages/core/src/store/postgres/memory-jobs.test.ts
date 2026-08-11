import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb, type PgDb } from "./migrate.js";

// docs/08 Phase 2 queue — enqueueJob / claimPendingJobs on the postgres adapter,
// mirroring the sqlite contract tests. Runs against in-process PGlite (supabase ==
// hosted Postgres) so the supabase path is validated without a server.

async function newStore(): Promise<{ store: PgMemoryStore; db: PgDb }> {
  const db = await createPgliteDb();
  return { store: new PgMemoryStore(db), db };
}

describe("PgMemoryStore job queue", () => {
  it("enqueueJob returns a non-empty id", async () => {
    const { store, db } = await newStore();
    const id = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(id).toBeTruthy();
    await db.$close();
  });

  it("dedupes a second pending observer for the same scope", async () => {
    const { store, db } = await newStore();
    const first = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    const second = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(second).toBe(first);
    await db.$close();
  });

  it("atomically dedupes concurrent same-scope observer enqueues", async () => {
    const { store, db } = await newStore();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } }),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await db.execute(
      sql`SELECT id FROM memory_jobs WHERE type = 'observer' AND scope_id = ${JSON.stringify({ accountId: "acct-a", threadId: "t1" })} AND status IN ('pending','running')`,
    );
    expect((rows as { rows?: unknown[] }).rows?.length ?? 0).toBe(1);
    await db.$close();
  });

  it("claimPendingJobs flips pending → running and decodes the scope", async () => {
    const { store, db } = await newStore();
    const id = await store.enqueueJob({
      type: "reflector",
      scope: { accountId: "acct-a", projectId: "p1", threadId: "t1" },
    });
    const claimed = await store.claimPendingJobs(10);
    expect(claimed).toEqual([
      {
        jobId: id,
        leaseGeneration: 1,
        type: "reflector",
        scope: { accountId: "acct-a", projectId: "p1", threadId: "t1" },
      },
    ]);
    expect(await store.claimPendingJobs(10)).toEqual([]);
    await db.$close();
  });

  it("dedupes an observer while the prior same-scope job is running", async () => {
    const { store, db } = await newStore();
    const first = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    await store.claimPendingJobs(10);
    const second = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(second).toBe(first);
    await db.$close();
  });

  it("claimPendingJobs respects the limit", async () => {
    const { store, db } = await newStore();
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } });
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t2" } });
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t3" } });
    const claimed = await store.claimPendingJobs(2);
    expect(claimed.length).toBe(2);
    await db.$close();
  });

  it("empty queue yields []", async () => {
    const { store, db } = await newStore();
    expect(await store.claimPendingJobs(5)).toEqual([]);
    await db.$close();
  });

  it("re-claims a running job whose lease expired (crash recovery)", async () => {
    // Mirrors the sqlite contract: a stale `running` row (worker died mid-job)
    // must be reclaimable after the lease, and the re-claim refreshes the lease.
    let nowMs = 1_000_000;
    let seq = 0;
    const db = await createPgliteDb();
    const store = new PgMemoryStore(
      db,
      () => `id-${++seq}`,
      () => new Date(nowMs),
    );
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } });
    const first = await store.claimPendingJobs(10);
    expect(first).toHaveLength(1);

    nowMs += 60_000;
    expect(await store.claimPendingJobs(10)).toEqual([]);

    nowMs += 10 * 60_000;
    const reclaimed = await store.claimPendingJobs(10);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.jobId).toBe(first[0]?.jobId);
    expect(reclaimed[0]?.leaseGeneration).toBe((first[0]?.leaseGeneration ?? 0) + 1);

    await store.updateJobStatus(
      first[0]?.jobId ?? "",
      "failed",
      "stale owner",
      first[0]?.leaseGeneration,
    );
    const statusRows = await db.execute(
      sql`SELECT status FROM memory_jobs WHERE id = ${first[0]?.jobId ?? ""}`,
    );
    expect((statusRows as { rows?: Array<{ status: string }> }).rows?.[0]?.status).toBe("running");

    nowMs += 60_000;
    expect(await store.claimPendingJobs(10)).toEqual([]);
    await db.$close();
  });

  it("fences stale atomic reflector publication after reclaim", async () => {
    let nowMs = 1_000_000;
    const db = await createPgliteDb();
    const store = new PgMemoryStore(db, undefined, () => new Date(nowMs));
    const target = { accountId: "acct-a", projectId: "p1" };
    const jobId = await store.enqueueJob({ type: "reflector", scope: target });
    const first = (await store.claimPendingJobs(1))[0];
    nowMs += 11 * 60_000;
    const reclaimed = (await store.claimPendingJobs(1))[0];

    expect(
      await store.commitReflectionJob(jobId, {
        leaseGeneration: first?.leaseGeneration ?? 0,
        target,
        reflection: {
          action: "upsert",
          reflectionText: "stale",
          version: 1,
          tokenEstimate: 1,
          updatedAt: new Date(nowMs),
        },
        facts: [],
        now: new Date(nowMs),
      }),
    ).toBeNull();
    expect(await store.getReflection(target)).toBeNull();

    expect(
      await store.commitReflectionJob(jobId, {
        leaseGeneration: reclaimed?.leaseGeneration ?? 0,
        target,
        reflection: {
          action: "upsert",
          reflectionText: "current",
          version: 1,
          tokenEstimate: 1,
          updatedAt: new Date(nowMs),
        },
        facts: [],
        now: new Date(nowMs),
      }),
    ).not.toBeNull();
    expect((await store.getReflection(target))?.reflectionText).toBe("current");
    await db.$close();
  });

  it("fences stale decay, embedding, and eager-fact publication after reclaim", async () => {
    let nowMs = 1_000_000;
    const db = await createPgliteDb();
    const store = new PgMemoryStore(db, undefined, () => new Date(nowMs));
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const observationId = await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: ["m1", "m1"],
      observationText: "keep me",
      observedAt: new Date(nowMs),
    });

    const staleLease = async (type: "decay" | "embedding" | "observer") => {
      const jobId = await store.enqueueJob({
        type,
        scope: { accountId: "acct-a", ...(type === "observer" ? { threadId: "t1" } : {}) },
      });
      const first = (await store.claimPendingJobs(1))[0];
      nowMs += 11 * 60_000;
      await store.claimPendingJobs(10);
      return { id: jobId, leaseGeneration: first?.leaseGeneration ?? 0 };
    };

    const decay = await staleLease("decay");
    expect(
      await store.archiveObservations({
        accountId: "acct-a",
        ids: [observationId],
        now: new Date(nowMs),
        job: decay,
      }),
    ).toBe(false);
    expect(await store.listScorableObservations({ accountId: "acct-a" })).toHaveLength(1);

    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      facts: [
        {
          ownerId: "acct-a",
          subjectKey: "existing",
          factText: "existing fact",
          contentHash: "existing-hash",
          validFrom: new Date(nowMs),
        },
      ],
      now: new Date(nowMs),
    });
    const existing = (await store.listActiveFacts({ accountId: "acct-a" }))[0];
    if (existing === undefined) throw new Error("expected existing fact");
    const embedding = await staleLease("embedding");
    expect(
      await store.setFactEmbeddings({
        accountId: "acct-a",
        items: [
          {
            factId: existing.id,
            embedding: new Float32Array([1, 0]),
            model: "test",
            dim: 2,
          },
        ],
        job: embedding,
      }),
    ).toBe(false);
    expect(
      await store.listFactsNeedingEmbedding({
        accountId: "acct-a",
        model: "test",
        dim: 2,
        limit: 10,
      }),
    ).toHaveLength(1);

    const observer = await staleLease("observer");
    const reconciled = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: { threadId: "t1" },
      facts: [
        {
          ownerId: "acct-a",
          threadId: "t1",
          subjectKey: "stale",
          factText: "stale fact",
          contentHash: "stale-hash",
          validFrom: new Date(nowMs),
        },
      ],
      now: new Date(nowMs),
      job: observer,
    });
    expect(reconciled.accepted).toBe(false);
    expect(
      (await store.listActiveFacts({ accountId: "acct-a" })).map((fact) => fact.factText),
    ).toEqual(["existing fact"]);
    await db.$close();
  });
});
