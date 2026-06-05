import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/12 P5 — the decay sweep's store half on the sqlite adapter:
// listScorableObservations (active-only, account-scoped, score-input columns) +
// archiveObservations (soft-invalidate, account-guarded, never a DELETE, never touches
// raw messages). These back runDecayJob; the scoring/threshold logic lives + is tested
// in the pure runDecayJob (forgetting/decay.test.ts).

function newStore(now: Date) {
  const db = createSqliteDb(":memory:");
  let seq = 0;
  const store = new SqliteMemoryStore(
    db,
    () => `id-${++seq}`,
    () => now,
  );
  return { store, db };
}

function readStatus(db: ReturnType<typeof createSqliteDb>, id: string) {
  return db.$sqlite
    .prepare("SELECT status, archived_at FROM memory_observations WHERE id = ?")
    .get(id) as { status: string; archived_at: number | null } | undefined;
}

describe("SqliteMemoryStore decay sweep (listScorableObservations / archiveObservations)", () => {
  it("lists only ACTIVE observations of the swept account with the score-input fields", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b" });
    const obsA = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    await store.appendObservation({
      threadId: "t-b",
      sourceMessageRange: ["m1", "m2"],
      observationText: "B",
      observedAt: now,
    });

    const rows = await store.listScorableObservations({ accountId: "acct-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: obsA,
      referencedAt: null, // never reinforced → score coalesces to observedAt
      observedAt: new Date("2026-05-01T00:00:00.000Z"),
      referenceCount: 0,
      importance: 0.5,
    });
  });

  it("archiveObservations soft-invalidates only the named ACTIVE rows of the account", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b" });
    const obsA = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: now,
    });
    const obsB = await store.appendObservation({
      threadId: "t-b",
      sourceMessageRange: ["m1", "m2"],
      observationText: "B",
      observedAt: now,
    });

    // acct-a tries to archive BOTH accounts' ids — only its own moves (tenant guard).
    const archivedAt = new Date("2026-06-06T00:00:00.000Z");
    await store.archiveObservations({ accountId: "acct-a", ids: [obsA, obsB], now: archivedAt });

    expect(readStatus(db, obsA)).toEqual({ status: "archived", archived_at: archivedAt.getTime() });
    expect(readStatus(db, obsB)).toEqual({ status: "active", archived_at: null }); // other account untouched

    // Archived rows drop out of the scorable list → idempotent re-sweep finds nothing new.
    const remaining = await store.listScorableObservations({ accountId: "acct-a" });
    expect(remaining).toEqual([]);
  });

  it("never touches raw messages, and is a no-op on an empty id list", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const msgId = await store.appendMessage({
      threadId: "t-a",
      role: "user",
      content: "hello",
      tokenEstimate: 1,
    });
    const obsA = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: [msgId, msgId],
      observationText: "A",
      observedAt: now,
    });

    await store.archiveObservations({ accountId: "acct-a", ids: [], now });
    expect(readStatus(db, obsA)).toEqual({ status: "active", archived_at: null });

    // The raw message row is still present + untouched (decay only hides observations).
    const raw = db.$sqlite
      .prepare("SELECT id, content FROM memory_messages WHERE id = ?")
      .get(msgId) as { id: string; content: string } | undefined;
    expect(raw).toEqual({ id: msgId, content: "hello" });
  });
});

describe("SqliteMemoryStore.listDecayCandidateAccounts (P5 buffer-flush gate)", () => {
  // A store whose clock can be advanced between writes so enqueue/observe timestamps
  // are controllable (the gate is time-sensitive).
  function clockStore(start: Date) {
    const db = createSqliteDb(":memory:");
    let seq = 0;
    let nowMs = start.getTime();
    const store = new SqliteMemoryStore(
      db,
      () => `id-${++seq}`,
      () => new Date(nowMs),
    );
    return {
      store,
      db,
      set: (d: Date) => {
        nowMs = d.getTime();
      },
    };
  }

  it("a never-swept account with active observations is due on the time gate", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: t0,
    });

    const due = await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime(),
    });
    expect(due).toEqual(["acct-a"]);
  });

  it("an account swept within the interval and below the count gate is NOT due", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store, set } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    // Record a sweep at t0 (a 'decay' job row stamps created_at = t0).
    await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } });
    // One observation observed AT t0 (not strictly newer than the sweep → 0 new).
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: t0,
    });

    // 1 minute later — well within the 1h interval, and only 0 new observations.
    set(new Date(t0.getTime() + 60_000));
    const due = await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime() + 60_000,
    });
    expect(due).toEqual([]);
  });

  it("crosses the count gate when enough NEW observations accumulate since the last sweep", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store, set } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } }); // sweep at t0

    // Two observations observed AFTER the sweep.
    const later = new Date(t0.getTime() + 1000);
    set(later);
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: later,
    });
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m3", "m4"],
      observationText: "B",
      observedAt: later,
    });

    // triggerObservations=2 → count gate met; still inside the 1h interval.
    const due = await store.listDecayCandidateAccounts({
      triggerObservations: 2,
      triggerIntervalS: 3600,
      nowMs: later.getTime(),
    });
    expect(due).toEqual(["acct-a"]);
  });

  it("ignores accounts whose only observations are already archived", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const obsA = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: t0,
    });
    await store.archiveObservations({ accountId: "acct-a", ids: [obsA], now: t0 });

    const due = await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime(),
    });
    expect(due).toEqual([]); // no active observations → not a candidate
  });

  it("decay enqueue dedupes against an existing open decay job for the same account", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const first = await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } });
    const second = await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } });
    expect(second).toBe(first); // same open row id returned

    const openCount = db.$sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_jobs WHERE type='decay' AND status IN ('pending','running')",
      )
      .get() as { c: number };
    expect(openCount.c).toBe(1); // only ONE open decay row despite two enqueues
  });
});
