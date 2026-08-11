import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/08 Phase 2 queue — enqueueJob / claimPendingJobs on the sqlite adapter.
// Covers: enqueue returns an id; same-scope pending observer is deduped (D6);
// claim flips pending → running atomically and decodes the scope (D1); claim
// respects the limit; an empty queue returns [].

function newStore() {
  const db = createSqliteDb(":memory:");
  return { store: new SqliteMemoryStore(db), db };
}

describe("SqliteMemoryStore job queue", () => {
  it("enqueueJob returns a non-empty id", async () => {
    const { store } = newStore();
    const id = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(id).toBeTruthy();
  });

  it("dedupes a second pending observer for the same scope (returns the existing id)", async () => {
    const { store } = newStore();
    const first = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    const second = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(second).toBe(first);
  });

  it("does NOT dedupe across different scopes or types", async () => {
    const { store } = newStore();
    const a = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    const b = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t2" },
    });
    const c = await store.enqueueJob({
      type: "reflector",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("enforces open-job dedupe at the database boundary", async () => {
    const { store, db } = newStore();
    const first = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(() =>
      db.$sqlite
        .prepare(
          "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "manual-duplicate",
          "observer",
          JSON.stringify({ accountId: "acct-a", threadId: "t1" }),
          "pending",
          Date.now(),
          Date.now(),
        ),
    ).toThrow();
    await store.updateJobStatus(first, "done");
    const next = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(next).not.toBe(first);
  });

  it("claimPendingJobs flips pending → running and decodes the scope", async () => {
    const { store } = newStore();
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
    // A second claim returns nothing — the row is now running, not pending.
    expect(await store.claimPendingJobs(10)).toEqual([]);
  });

  it("claimPendingJobs respects the limit", async () => {
    const { store } = newStore();
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } });
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t2" } });
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t3" } });
    const claimed = await store.claimPendingJobs(2);
    expect(claimed.length).toBe(2);
  });

  it("empty queue yields []", async () => {
    const { store } = newStore();
    expect(await store.claimPendingJobs(5)).toEqual([]);
  });

  it("dedupes an observer while the prior same-scope job is running", async () => {
    const { store } = newStore();
    const first = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    await store.claimPendingJobs(10); // first → running
    const second = await store.enqueueJob({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(second).toBe(first);
  });

  it("re-claims a running job whose lease expired (crash recovery)", async () => {
    // A worker that dies between claim and finish leaves a `running` row that
    // enqueue dedupes against FOREVER — claim must treat a lease-expired running
    // row as reclaimable, and re-claiming must refresh the lease.
    let nowMs = 1_000_000;
    let seq = 0;
    const db = createSqliteDb(":memory:");
    const store = new SqliteMemoryStore(
      db,
      () => `id-${++seq}`,
      () => new Date(nowMs),
    );
    await store.enqueueJob({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } });
    const first = await store.claimPendingJobs(10);
    expect(first).toHaveLength(1);

    // Within the lease: the running row is NOT re-claimed.
    nowMs += 60_000;
    expect(await store.claimPendingJobs(10)).toEqual([]);

    // Lease expired: the stale running row is re-claimed (same job id).
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
    expect(
      db.$sqlite.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(first[0]?.jobId) as {
        status: string;
      },
    ).toEqual({ status: "running" });

    // The re-claim refreshed updated_at, so the lease restarts.
    nowMs += 60_000;
    expect(await store.claimPendingJobs(10)).toEqual([]);
  });

  it("fences stale atomic reflector publication after reclaim", async () => {
    let nowMs = 1_000_000;
    const store = new SqliteMemoryStore(
      createSqliteDb(":memory:"),
      undefined,
      () => new Date(nowMs),
    );
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
  });
});
