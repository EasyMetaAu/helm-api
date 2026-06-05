import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

// docs/12 P5 — the decay sweep's store half on the postgres adapter (PGlite in-process,
// supabase == pg dialect). Mirrors the sqlite contract test: listScorableObservations
// (active-only, account-scoped) + archiveObservations (soft-invalidate, account-guarded,
// never a DELETE) + listDecayCandidateAccounts (buffer-flush gate).

async function newStore(now: Date) {
  const db = await createPgliteDb();
  let seq = 0;
  let nowMs = now.getTime();
  const store = new PgMemoryStore(
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

describe("PgMemoryStore decay sweep", () => {
  it("lists only ACTIVE observations of the swept account and archives account-guarded", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b" });
    const obsA = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const obsB = await store.appendObservation({
      threadId: "t-b",
      sourceMessageRange: ["m1", "m2"],
      observationText: "B",
      observedAt: now,
    });

    const rows = await store.listScorableObservations({ accountId: "acct-a" });
    expect(rows).toEqual([
      {
        id: obsA,
        referencedAt: null,
        observedAt: new Date("2026-05-01T00:00:00.000Z"),
        referenceCount: 0,
        importance: 0.5,
      },
    ]);

    // acct-a archives BOTH ids — only its own moves (tenant guard).
    const archivedAt = new Date("2026-06-06T00:00:00.000Z");
    await store.archiveObservations({ accountId: "acct-a", ids: [obsA, obsB], now: archivedAt });
    expect(await store.listScorableObservations({ accountId: "acct-a" })).toEqual([]); // archived → gone
    expect(await store.listScorableObservations({ accountId: "acct-b" })).toHaveLength(1); // untouched
  });

  it("a never-swept account is due; count gate fires on new observations", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store, set } = await newStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: t0,
    });

    // Never swept → due on the time gate.
    expect(
      await store.listDecayCandidateAccounts({
        triggerObservations: 50,
        triggerIntervalS: 3600,
        nowMs: t0.getTime(),
      }),
    ).toEqual(["acct-a"]);

    // Record a sweep at t0; then one more observation after it → count gate (=2) due,
    // even though we are still inside the 1h interval.
    await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } });
    const later = new Date(t0.getTime() + 1000);
    set(later);
    await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m3", "m4"],
      observationText: "B",
      observedAt: later,
    });
    // 1 new observation since sweep; count gate of 1 → due.
    expect(
      await store.listDecayCandidateAccounts({
        triggerObservations: 1,
        triggerIntervalS: 3600,
        nowMs: later.getTime(),
      }),
    ).toEqual(["acct-a"]);
    // count gate of 5 not met AND still inside interval → not due.
    expect(
      await store.listDecayCandidateAccounts({
        triggerObservations: 5,
        triggerIntervalS: 3600,
        nowMs: later.getTime(),
      }),
    ).toEqual([]);
  });
});
