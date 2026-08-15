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
    await store.ensureThread({ id: "t-a", ownerId: "acct-a", projectId: "p-a" });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b", projectId: "p-b" });
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

  // docs/12 (Codex review fix) — the scorable READ is bounded by `limit` and returns
  // OLDEST-first, so a huge tenant cannot load an unbounded set before the bounded
  // archive loop even starts. Leftover (newer) rows are swept on the next trigger.
  it("bounds the scan by `limit` and returns oldest-first", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const day = 86_400_000;
    // 5 observations, observed_at increasing (o0 oldest … o4 newest).
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
    expect(capped.map((r) => r.id)).toEqual([ids[0], ids[1]]); // the two OLDEST only
    // No limit → all five, still oldest-first.
    const all = await store.listScorableObservations({ accountId: "acct-a" });
    expect(all.map((r) => r.id)).toEqual(ids);
  });

  // docs/12 (Codex review fix II — starvation) — with only a LIMIT, the oldest-first
  // page could fill up with SURVIVORS (recently-reinforced rows) and re-select the
  // same page every sweep, never reaching condemned rows beyond it. With `candidates`
  // the forgetting score runs IN SQL and the page contains ONLY below-threshold rows.
  it("candidates filter returns ONLY below-threshold rows — survivors never occupy the page", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const day = 86_400_000;
    // Three OLD survivors (recently referenced → recency ~1 → score ≈ 0.5) that are
    // OLDER (by observed_at) than the condemned row, so a limit-only page of 3 would
    // contain exactly these survivors and starve the condemned row forever.
    const survivors: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await store.appendObservation({
        threadId: "t-a",
        sourceMessageRange: [`s${i}a`, `s${i}b`],
        observationText: `survivor ${i}`,
        observedAt: new Date(now.getTime() - (30 - i) * day),
      });
      survivors.push(id);
      // Reinforce: referenced_at = now → recency ~1.
      db.$sqlite
        .prepare(
          "UPDATE memory_observations SET referenced_at = ?, reference_count = 1 WHERE id = ?",
        )
        .run(now.getTime(), id);
    }
    // One NEWER (by observed_at) but never-referenced row, 10 half-lives stale → condemned.
    const condemned = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["c1", "c2"],
      observationText: "condemned",
      observedAt: new Date(now.getTime() - 10 * day),
    });

    const candidates = {
      nowMs: now.getTime(),
      half_life_s: 86_400, // 1 day
      importance_floor: 0.1,
      importance_ceil: 1.0,
      access_weight: 0.15,
      threshold: 0.05,
    };
    // Limit-sized page of 3: WITHOUT candidates it would be the 3 oldest = the
    // survivors (the starvation mode). WITH candidates, only the condemned row.
    const page = await store.listScorableObservations({
      accountId: "acct-a",
      limit: 3,
      candidates,
    });
    expect(page.map((r) => r.id)).toEqual([condemned]);
    for (const s of survivors) expect(page.map((r) => r.id)).not.toContain(s);
  });

  it("archiveObservations soft-invalidates only the named ACTIVE rows of the account", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
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

  it("archives a parentless observation without enqueueing a thread-only reflector", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "legacy-thread", ownerId: "acct-a" });
    const observationId = await store.appendObservation({
      threadId: "legacy-thread",
      sourceMessageRange: ["m1", "m2"],
      observationText: "legacy",
      observedAt: now,
    });

    await store.archiveObservations({ accountId: "acct-a", ids: [observationId], now });

    expect(readStatus(db, observationId)?.status).toBe("archived");
    expect(await store.claimPendingJobs(10)).toEqual([]);
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

  // docs/12 (Codex review fix #3) — the gate matches the decay job's scope_id via
  // json_extract, NOT a string-concatenated lookalike literal. An account id with
  // JSON-special characters (quote/backslash) is escaped by encodeScopeId, so a
  // concat would never match → last_sweep stays null → the account re-triggers on
  // every worker tick. json_extract sees through the escaping.
  it("matches last_sweep for an account id containing JSON-special characters", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const weird = 'acct-"quote\\back';
    const { store, set } = clockStore(t0);
    await store.ensureThread({ id: "t-w", ownerId: weird });
    await store.enqueueJob({ type: "decay", scope: { accountId: weird } }); // sweep at t0
    await store.appendObservation({
      threadId: "t-w",
      sourceMessageRange: ["m1", "m2"],
      observationText: "W",
      observedAt: t0,
    });

    // Within the interval + below the count gate → NOT due. With the old concat
    // matching, last_sweep would be null and the time gate would fire spuriously.
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

  it("extracts each decay job scope once instead of once per observation", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store, db, set } = clockStore(t0);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.enqueueJob({ type: "decay", scope: { accountId: "acct-a" } });
    set(new Date(t0.getTime() + 1000));
    for (let i = 0; i < 20; i += 1) {
      await store.appendObservation({
        threadId: "t-a",
        sourceMessageRange: [`m${i}`, `m${i}`],
        observationText: `observation ${i}`,
        observedAt: new Date(t0.getTime() + 1000),
      });
    }

    let jsonExtractCalls = 0;
    db.$sqlite.function("json_extract", { deterministic: true }, (raw: unknown, path: unknown) => {
      jsonExtractCalls += 1;
      if (typeof raw !== "string" || path !== "$.accountId") return null;
      const parsed = JSON.parse(raw) as { accountId?: unknown };
      return typeof parsed.accountId === "string" ? parsed.accountId : null;
    });

    await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime() + 60_000,
    });
    expect(jsonExtractCalls).toBeLessThan(10);
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

  it("returns due accounts in deterministic bounded pages", async () => {
    const t0 = new Date("2026-06-05T00:00:00.000Z");
    const { store } = clockStore(t0);
    for (let i = 0; i < 105; i += 1) {
      const accountId = `acct-${String(i).padStart(3, "0")}`;
      await store.ensureThread({ id: `thread-${i}`, ownerId: accountId });
      await store.appendObservation({
        threadId: `thread-${i}`,
        sourceMessageRange: [`m-${i}`, `m-${i}`],
        observationText: "due",
        observedAt: t0,
      });
    }

    const defaultPage = await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime(),
    });
    const first = await store.listDecayCandidateAccounts({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: t0.getTime(),
      limit: 2,
    });

    expect(defaultPage).toHaveLength(100);
    expect(defaultPage.at(-1)).toBe("acct-099");
    expect(first).toEqual(["acct-000", "acct-001"]);
  });
});
