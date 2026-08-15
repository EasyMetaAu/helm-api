import { sql } from "drizzle-orm";
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
    await store.ensureThread({
      id: "t-a",
      ownerId: "acct-a",
      projectId: "p-a",
      resourceId: "r-a",
    });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b", projectId: "p-b" });
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
    expect(await store.claimPendingJobs(10)).toEqual(
      expect.arrayContaining([
        {
          jobId: expect.any(String),
          leaseGeneration: 1,
          type: "reflector",
          scope: { accountId: "acct-a", projectId: "p-a" },
        },
        {
          jobId: expect.any(String),
          leaseGeneration: 1,
          type: "reflector",
          scope: { accountId: "acct-a", resourceId: "r-a" },
        },
      ]),
    );
  });

  it("archives a parentless observation without enqueueing a thread-only reflector", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.ensureThread({ id: "legacy-thread", ownerId: "acct-a" });
    const observationId = await store.appendObservation({
      threadId: "legacy-thread",
      sourceMessageRange: ["m1", "m2"],
      observationText: "legacy",
      observedAt: now,
    });

    await store.archiveObservations({ accountId: "acct-a", ids: [observationId], now });

    expect(await store.listScorableObservations({ accountId: "acct-a" })).toEqual([]);
    expect(await store.claimPendingJobs(10)).toEqual([]);
  });

  // docs/12 (Codex review fix II — starvation; pg mirror) — with `candidates` the
  // forgetting score runs IN SQL, so a limit-sized page can never fill with survivors
  // and starve condemned rows beyond it.
  it("candidates filter returns ONLY below-threshold rows — survivors never occupy the page", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = await newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const day = 86_400_000;
    const survivors: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await store.appendObservation({
        threadId: "t-a",
        sourceMessageRange: [`s${i}a`, `s${i}b`],
        observationText: `survivor ${i}`,
        observedAt: new Date(now.getTime() - (30 - i) * day),
      });
      survivors.push(id);
      await db.execute(
        sql`UPDATE memory_observations SET referenced_at = ${now.getTime()}, reference_count = 1 WHERE id = ${id}`,
      );
    }
    const condemned = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["c1", "c2"],
      observationText: "condemned",
      observedAt: new Date(now.getTime() - 10 * day),
    });

    const page = await store.listScorableObservations({
      accountId: "acct-a",
      limit: 3,
      candidates: {
        nowMs: now.getTime(),
        half_life_s: 86_400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
        threshold: 0.05,
      },
    });
    expect(page.map((r) => r.id)).toEqual([condemned]);
    for (const s of survivors) expect(page.map((r) => r.id)).not.toContain(s);
  });

  // docs/12 (Codex review fix, pg mirror) — the scorable read is bounded by `limit`
  // and oldest-first, so a huge tenant cannot load an unbounded set before the
  // bounded archive loop starts.
  it("bounds the scan by `limit` and returns oldest-first", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const day = 86_400_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await store.appendObservation({
          threadId: "t-a",
          sourceMessageRange: [`m${i}a`, `m${i}b`],
          observationText: `obs ${i}`,
          observedAt: new Date(now.getTime() - (5 - i) * day),
        }),
      );
    }

    const capped = await store.listScorableObservations({ accountId: "acct-a", limit: 2 });
    expect(capped.map((r) => r.id)).toEqual([ids[0], ids[1]]); // two OLDEST only
    const all = await store.listScorableObservations({ accountId: "acct-a" });
    expect(all.map((r) => r.id)).toEqual(ids);
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

  // docs/12 (Codex review fix #3, pg mirror) — the gate matches scope_id via
  // `scope_id::jsonb ->> 'accountId'`, never a string-concatenated literal, so an
  // account id with JSON-special characters (escaped by encodeScopeId) still finds
  // its last_sweep instead of re-triggering on every worker tick.
  it("matches last_sweep for an account id containing JSON-special characters", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const weird = 'acct-"quote\\back';
    const { store, set } = await newStore(t0);
    await store.ensureThread({ id: "t-w", ownerId: weird });
    await store.enqueueJob({ type: "decay", scope: { accountId: weird } }); // sweep at t0
    await store.appendObservation({
      threadId: "t-w",
      sourceMessageRange: ["m1", "m2"],
      observationText: "W",
      observedAt: t0,
    });

    // Within the interval + below the count gate → NOT due (last_sweep matched).
    set(new Date(t0.getTime() + 60_000));
    expect(
      await store.listDecayCandidateAccounts({
        triggerObservations: 50,
        triggerIntervalS: 3600,
        nowMs: t0.getTime() + 60_000,
      }),
    ).toEqual([]);
  });

  it("returns due accounts in deterministic bounded pages", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(t0);
    for (let i = 0; i < 3; i += 1) {
      const accountId = `acct-${String(i).padStart(3, "0")}`;
      await store.ensureThread({ id: `thread-${i}`, ownerId: accountId });
      await store.appendObservation({
        threadId: `thread-${i}`,
        sourceMessageRange: [`m-${i}`, `m-${i}`],
        observationText: "due",
        observedAt: t0,
      });
    }

    expect(
      await store.listDecayCandidateAccounts({
        triggerObservations: 50,
        triggerIntervalS: 3600,
        nowMs: t0.getTime(),
        limit: 1,
      }),
    ).toEqual(["acct-000"]);
  });
});
