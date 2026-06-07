import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb, type PgDb } from "./migrate.js";

// Auto-compaction store surface on the postgres adapter (PGlite in-process, ==
// hosted Postgres), mirroring the sqlite contract: thread model stamp + the
// idle-flush coverage-frontier sweep.

let seq = 0;
async function newStore(): Promise<{ store: PgMemoryStore; db: PgDb; clock: () => number }> {
  let tickMs = 1_000_000;
  const db = await createPgliteDb();
  const store = new PgMemoryStore(
    db,
    () => {
      seq += 1;
      return `pg-id-${seq}`;
    },
    () => {
      tickMs += 1000;
      return new Date(tickMs);
    },
  );
  return { store, db, clock: () => tickMs };
}

describe("PgMemoryStore — thread model stamp", () => {
  it("stampThreadModel + getThreadMeta round-trip, account-guarded", async () => {
    const { store, db } = await newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });

    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: null,
    });
    await store.stampThreadModel({
      accountId: "acct-a",
      threadId: "t1",
      modelAlias: "anthropic/claude-x",
    });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: "anthropic/claude-x",
    });
    await db.$close();
  });

  it("a foreign account cannot stamp or read; unknown thread reads null", async () => {
    const { store, db } = await newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    await store.stampThreadModel({ accountId: "acct-b", threadId: "t1", modelAlias: "evil" });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: null,
    });
    expect(await store.getThreadMeta({ accountId: "acct-b", threadId: "t1" })).toBeNull();
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "nope" })).toBeNull();
    await db.$close();
  });
});

describe("PgMemoryStore — idle-flush candidates", () => {
  it("returns idle uncovered threads, drops fully-covered ones, detects the tail", async () => {
    const { store, db, clock } = await newStore();
    // Thread A: uncovered tail after a prefix observation (frontier, not observed_at).
    await store.ensureThread({ id: "tA", ownerId: "acct-a" });
    const a1 = await store.appendMessage({
      threadId: "tA",
      role: "user",
      content: "old",
      tokenEstimate: 1,
    });
    const a2 = await store.appendMessage({
      threadId: "tA",
      role: "user",
      content: "old2",
      tokenEstimate: 1,
    });
    await store.appendMessage({
      threadId: "tA",
      role: "user",
      content: "kept tail",
      tokenEstimate: 1,
    });
    await store.appendObservation({
      threadId: "tA",
      sourceMessageRange: [a1, a2],
      observationText: "prefix",
      observedAt: new Date(clock() + 1),
    });

    // Thread B: fully covered → must NOT be a candidate (sweep terminates).
    await store.ensureThread({ id: "tB", ownerId: "acct-a" });
    const b1 = await store.appendMessage({
      threadId: "tB",
      role: "user",
      content: "x",
      tokenEstimate: 1,
    });
    await store.appendObservation({
      threadId: "tB",
      sourceMessageRange: [b1, b1],
      observationText: "covered",
      observedAt: new Date(clock() + 1),
    });

    const candidates = await store.listIdleFlushCandidates({
      idleBeforeMs: clock() + 1000,
      limit: 10,
    });
    expect(candidates).toEqual([{ accountId: "acct-a", threadId: "tA" }]);
    await db.$close();
  });

  it("detects an uncovered tail sharing the frontier's millisecond (created_at,id tiebreak)", async () => {
    const db = await createPgliteDb();
    let n = 0;
    const store = new PgMemoryStore(
      db,
      () => `pgms-${++n}`,
      () => new Date(5_000_000), // frozen — both rows tie on created_at
    );
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const m1 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "covered",
      tokenEstimate: 1,
    });
    await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "same-ms uncovered tail",
      tokenEstimate: 1,
    });
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: [m1, m1],
      observationText: "prefix",
      observedAt: new Date(5_000_000),
    });
    expect(await store.listIdleFlushCandidates({ idleBeforeMs: 6_000_000, limit: 10 })).toEqual([
      { accountId: "acct-a", threadId: "t1" },
    ]);
    await db.$close();
  });
});
