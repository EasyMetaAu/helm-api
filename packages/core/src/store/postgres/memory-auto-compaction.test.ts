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
      messageCount: 0,
      observationCount: 0,
    });
    await store.stampThreadModel({
      accountId: "acct-a",
      threadId: "t1",
      modelAlias: "anthropic/claude-x",
    });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: "anthropic/claude-x",
      messageCount: 0,
      observationCount: 0,
    });
    await db.$close();
  });

  it("a foreign account cannot stamp or read; unknown thread reads null", async () => {
    const { store, db } = await newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    await store.stampThreadModel({ accountId: "acct-b", threadId: "t1", modelAlias: "evil" });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: null,
      messageCount: 0,
      observationCount: 0,
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
    const pageA = await store.listObserverMessagesPage({
      accountId: "acct-a",
      threadId: "tA",
      limit: 2,
      maxBytes: 1024,
      maxTokens: 1024,
    });
    const lastA = pageA.messages.at(-1);
    if (lastA === undefined) throw new Error("expected Observer page");
    await store.appendObservationAndAdvanceFrontier({
      accountId: "acct-a",
      observation: {
        threadId: "tA",
        sourceMessageRange: [a1, a2],
        observationText: "prefix",
        observedAt: new Date(clock() + 1),
      },
      expectedFrontier: pageA.expectedFrontier,
      nextFrontier: { createdAtMs: lastA.createdAt.getTime(), id: lastA.id },
    });

    // Thread B: fully covered → must NOT be a candidate (sweep terminates).
    await store.ensureThread({ id: "tB", ownerId: "acct-a" });
    const b1 = await store.appendMessage({
      threadId: "tB",
      role: "user",
      content: "x",
      tokenEstimate: 1,
    });
    const pageB = await store.listObserverMessagesPage({
      accountId: "acct-a",
      threadId: "tB",
      limit: 10,
      maxBytes: 1024,
      maxTokens: 1024,
    });
    const lastB = pageB.messages.at(-1);
    if (lastB === undefined) throw new Error("expected Observer page");
    await store.appendObservationAndAdvanceFrontier({
      accountId: "acct-a",
      observation: {
        threadId: "tB",
        sourceMessageRange: [b1, b1],
        observationText: "covered",
        observedAt: new Date(clock() + 1),
      },
      expectedFrontier: pageB.expectedFrontier,
      nextFrontier: { createdAtMs: lastB.createdAt.getTime(), id: lastB.id },
    });

    const candidates = await store.listIdleFlushCandidates({
      idleBeforeMs: clock() + 1000,
      limit: 10,
    });
    expect(candidates).toEqual([{ accountId: "acct-a", threadId: "tA" }]);
    expect(
      await store.listIdleFlushCandidates({
        idleBeforeMs: clock() + 1000,
        idleAfterMs: clock() + 1000,
        limit: 10,
      }),
    ).toEqual([]);
    await db.$close();
  });

  it("uses the durable Observer frontier when persisted timestamps are reordered", async () => {
    const { store, db, clock } = await newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const m1 = await store.appendMessage({
      threadId: "t1",
      messageIndex: 0,
      role: "user",
      content: "first in transcript",
      tokenEstimate: 1,
    });
    const m2 = await store.appendMessage({
      threadId: "t1",
      messageIndex: 1,
      role: "user",
      content: "middle in transcript",
      tokenEstimate: 1,
    });
    const m3 = await store.appendMessage({
      threadId: "t1",
      messageIndex: 2,
      role: "user",
      content: "last in transcript",
      tokenEstimate: 1,
    });
    await db.execute(
      `UPDATE memory_messages SET created_at = 1 WHERE id = '${m2.replace(/'/g, "''")}'`,
    );
    const page = await store.listObserverMessagesPage({
      accountId: "acct-a",
      threadId: "t1",
      limit: 10,
      maxBytes: 1024,
      maxTokens: 1024,
    });
    const first = page.messages.at(0);
    const last = page.messages.at(-1);
    if (first === undefined || last === undefined) throw new Error("expected Observer page");
    expect(new Set(page.messages.map((message) => message.id))).toEqual(new Set([m1, m2, m3]));
    await store.appendObservationAndAdvanceFrontier({
      accountId: "acct-a",
      observation: {
        threadId: "t1",
        sourceMessageRange: [first.id, last.id],
        observationText: "covers all persisted messages",
        observedAt: new Date(clock() + 1),
      },
      expectedFrontier: page.expectedFrontier,
      nextFrontier: { createdAtMs: last.createdAt.getTime(), id: last.id },
    });

    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: clock() + 1000, limit: 10 }),
    ).toEqual([]);
    await db.$close();
  });

  it("detects a sparse uncovered GAP before a later observation (interval, not frontier)", async () => {
    const db = await createPgliteDb();
    let tickMs = 1_000_000;
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
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "uncovered gap",
      tokenEstimate: 1,
    });
    const m2 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "covered later",
      tokenEstimate: 1,
    });
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: [m2, m2],
      observationText: "covers only the later message",
      observedAt: new Date(tickMs + 1),
    });
    expect(await store.listIdleFlushCandidates({ idleBeforeMs: tickMs + 1000, limit: 10 })).toEqual(
      [{ accountId: "acct-a", threadId: "t1" }],
    );
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

  it("interleaves idle candidates by project so one backlog cannot monopolize the page", async () => {
    const { store, db, clock } = await newStore();
    for (const id of ["a1", "a2", "a3"]) {
      await store.ensureThread({ id, ownerId: "acct-a", projectId: "proj-a" });
      await store.appendMessage({ threadId: id, role: "user", content: id, tokenEstimate: 1 });
    }
    await store.ensureThread({ id: "b1", ownerId: "acct-a", projectId: "proj-b" });
    await store.appendMessage({ threadId: "b1", role: "user", content: "b1", tokenEstimate: 1 });

    const limited = await store.listIdleFlushCandidates({
      idleBeforeMs: clock() + 1000,
      limit: 2,
    });

    expect(limited.map((c) => c.threadId)).toEqual(["a1", "b1"]);
    await db.$close();
  });
});
