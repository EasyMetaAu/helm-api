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

    nowMs += 60_000;
    expect(await store.claimPendingJobs(10)).toEqual([]);
    await db.$close();
  });
});
