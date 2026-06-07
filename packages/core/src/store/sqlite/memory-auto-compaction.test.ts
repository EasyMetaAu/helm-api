import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// Auto-compaction store surface on the sqlite adapter: the thread model stamp
// (write + read halves, account-guarded) and the idle-flush candidate sweep
// (coverage-FRONTIER detection + termination after a full flush).

function newStore() {
  let seq = 0;
  let tickMs = 1_000_000;
  const db = createSqliteDb(":memory:");
  const store = new SqliteMemoryStore(
    db,
    () => {
      seq += 1;
      return `id-${String(seq).padStart(3, "0")}`;
    },
    () => {
      tickMs += 1000;
      return new Date(tickMs);
    },
  );
  return { store, clock: () => tickMs };
}

describe("SqliteMemoryStore — thread model stamp", () => {
  it("stampThreadModel + getThreadMeta round-trip, account-guarded", async () => {
    const { store } = newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });

    // Never stamped → null alias (not a missing row).
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

    // A later turn served by a different model overwrites the stamp.
    await store.stampThreadModel({
      accountId: "acct-a",
      threadId: "t1",
      modelAlias: "openai/gpt-x",
    });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: "openai/gpt-x",
    });
  });

  it("a foreign account can neither stamp nor read the thread", async () => {
    const { store } = newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    await store.stampThreadModel({
      accountId: "acct-b", // wrong owner → silent no-op
      threadId: "t1",
      modelAlias: "evil/model",
    });
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "t1" })).toEqual({
      lastServedModel: null,
    });
    // Wrong-owner read → null (indistinguishable from an unknown thread).
    expect(await store.getThreadMeta({ accountId: "acct-b", threadId: "t1" })).toBeNull();
  });

  it("getThreadMeta returns null for an unknown thread", async () => {
    const { store } = newStore();
    expect(await store.getThreadMeta({ accountId: "acct-a", threadId: "nope" })).toBeNull();
  });
});

describe("SqliteMemoryStore — idle-flush candidates", () => {
  it("returns an idle thread with uncovered messages; respects the idle cutoff", async () => {
    const { store, clock } = newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    await store.appendMessage({ threadId: "t1", role: "user", content: "hi", tokenEstimate: 2 });

    const afterActivity = clock() + 1;
    // Not yet idle (cutoff before the thread's last activity) → no candidates.
    expect(await store.listIdleFlushCandidates({ idleBeforeMs: 0, limit: 10 })).toEqual([]);
    // Idle (cutoff after last activity) → candidate.
    expect(await store.listIdleFlushCandidates({ idleBeforeMs: afterActivity, limit: 10 })).toEqual(
      [{ accountId: "acct-a", threadId: "t1" }],
    );
  });

  it("a fully-covered thread leaves the candidate set (sweep terminates)", async () => {
    const { store, clock } = newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const m1 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "a",
      tokenEstimate: 1,
    });
    const m2 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "b",
      tokenEstimate: 1,
    });
    // Idle flush wrote one observation covering EVERYTHING.
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: [m1, m2],
      observationText: "covered",
      observedAt: new Date(clock() + 1),
    });
    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: clock() + 1000, limit: 10 }),
    ).toEqual([]);
  });

  it("detects the kept-recent TAIL a writeback pass left uncovered (frontier, not observed_at)", async () => {
    const { store, clock } = newStore();
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const m1 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "old-1",
      tokenEstimate: 1,
    });
    const m2 = await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "old-2",
      tokenEstimate: 1,
    });
    await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "kept tail — uncovered",
      tokenEstimate: 1,
    });
    // Writeback compaction covered only m1..m2; the observer ran AFTER m3 was
    // written (observed_at > every message created_at) — an observed_at
    // comparison would wrongly call this thread fully covered.
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: [m1, m2],
      observationText: "prefix",
      observedAt: new Date(clock() + 1),
    });
    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: clock() + 1000, limit: 10 }),
    ).toEqual([{ accountId: "acct-a", threadId: "t1" }]);
  });

  it("carries the thread's project/resource scope on the candidate (for promotion)", async () => {
    const { store, clock } = newStore();
    await store.ensureThread({
      id: "t1",
      ownerId: "acct-a",
      projectId: "proj-1",
      resourceId: "res-1",
    });
    await store.appendMessage({ threadId: "t1", role: "user", content: "hi", tokenEstimate: 2 });
    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: clock() + 1000, limit: 10 }),
    ).toEqual([{ accountId: "acct-a", threadId: "t1", projectId: "proj-1", resourceId: "res-1" }]);
  });

  it("idleness tracks the last MESSAGE, not the thread row (active threads are not idle)", async () => {
    const { store, clock } = newStore();
    // ensureThread stamps updated_at early; a later appendMessage does NOT touch
    // the thread row, so a stale updated_at must NOT mark this thread idle.
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const threadStamp = clock();
    await store.appendMessage({ threadId: "t1", role: "user", content: "hi", tokenEstimate: 2 });
    const afterMessage = clock();
    // Cutoff between the thread stamp and the message: updated_at would (wrongly)
    // qualify it; MAX(message.created_at) correctly keeps it active.
    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: threadStamp + 1, limit: 10 }),
    ).toEqual([]);
    // Cutoff after the message → genuinely idle.
    expect(
      await store.listIdleFlushCandidates({ idleBeforeMs: afterMessage + 1, limit: 10 }),
    ).toHaveLength(1);
  });

  it("excludes unowned threads and honors the limit", async () => {
    const { store, clock } = newStore();
    await store.ensureThread({ id: "owned-1", ownerId: "acct-a" });
    await store.appendMessage({
      threadId: "owned-1",
      role: "user",
      content: "x",
      tokenEstimate: 1,
    });
    await store.ensureThread({ id: "owned-2", ownerId: "acct-b" });
    await store.appendMessage({
      threadId: "owned-2",
      role: "user",
      content: "y",
      tokenEstimate: 1,
    });
    await store.ensureThread({ id: "unowned" });
    await store.appendMessage({
      threadId: "unowned",
      role: "user",
      content: "z",
      tokenEstimate: 1,
    });

    const all = await store.listIdleFlushCandidates({ idleBeforeMs: clock() + 1000, limit: 10 });
    expect(all).toHaveLength(2); // unowned thread never swept
    expect(all.map((c) => c.threadId)).toEqual(["owned-1", "owned-2"]); // oldest-idle first

    const limited = await store.listIdleFlushCandidates({
      idleBeforeMs: clock() + 1000,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });
});
