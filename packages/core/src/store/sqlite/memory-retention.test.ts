import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/12 P7 — the retention HARD-DELETE store half on the sqlite adapter:
// pruneExpiredMemory, the ONLY DELETE in the forgetting system. Account-agnostic (a
// retention age cutoff is tenant-neutral), two deletes in one call:
//   1. archived observations whose archived_at < cutoff (NEVER active rows);
//   2. expired facts whose expired_at < cutoff (NEVER unexpired facts).
// Strict lower bounds (strictly-older-than, mirroring prunePayloads): a row stamped
// exactly at the cutoff survives. Reflections are NEVER hard-deleted (no reflection
// delete here). The gating + cutoff math live in the pure pruner (forgetting/
// retention.test.ts); this exercises the SQL contract.

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

function obsCount(db: ReturnType<typeof createSqliteDb>) {
  return (
    db.$sqlite.prepare("SELECT COUNT(*) AS c FROM memory_observations").get() as { c: number }
  ).c;
}
function obsIds(db: ReturnType<typeof createSqliteDb>): string[] {
  return (
    db.$sqlite.prepare("SELECT id FROM memory_observations ORDER BY id").all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}
function obsRow(
  db: ReturnType<typeof createSqliteDb>,
  id: string,
): { status: string; observation_text: string; source_message_range: string } {
  return db.$sqlite
    .prepare(
      "SELECT status, observation_text, source_message_range FROM memory_observations WHERE id = ?",
    )
    .get(id) as { status: string; observation_text: string; source_message_range: string };
}
function factIds(db: ReturnType<typeof createSqliteDb>): string[] {
  return (
    db.$sqlite.prepare("SELECT id FROM memory_facts ORDER BY id").all() as Array<{ id: string }>
  ).map((r) => r.id);
}

// Insert a fact already stamped expired_at (the supersede outcome P7 collects),
// bypassing the live supersede so the test controls the timestamp directly.
function insertExpiredFact(
  db: ReturnType<typeof createSqliteDb>,
  id: string,
  ownerId: string,
  contentHash: string,
  expiredAt: number | null,
) {
  db.$sqlite
    .prepare(
      `INSERT INTO memory_facts
         (id, owner_id, project_id, resource_id, thread_id, subject_key, fact_text,
          content_hash, importance, reference_count, referenced_at, valid_from,
          invalid_at, expired_at, status, source_observation_range, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 'subj', 'a fact', ?, 0.5, 0, NULL, 1000,
               NULL, ?, 'active', NULL, 1000, 1000)`,
    )
    .run(id, ownerId, contentHash, expiredAt);
}

const NOW = new Date("2026-06-05T00:00:00.000Z");
const DAY_MS = 86_400_000;

describe("SqliteMemoryStore.pruneExpiredMemory (P7 retention hard-delete)", () => {
  it("deletes ONLY archived observations older than the cutoff; active + recent survive", async () => {
    const { store, db } = newStore(NOW);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const aged = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "aged",
      observedAt: NOW,
    });
    const recent = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m3", "m4"],
      observationText: "recent",
      observedAt: NOW,
    });
    const active = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m5", "m6"],
      observationText: "active",
      observedAt: NOW,
    });

    // Archive two rows at different ages; leave `active` active.
    await store.archiveObservations({
      accountId: "acct-a",
      ids: [aged],
      now: new Date(NOW.getTime() - 40 * DAY_MS), // archived 40d ago
    });
    await store.archiveObservations({
      accountId: "acct-a",
      ids: [recent],
      now: new Date(NOW.getTime() - 5 * DAY_MS), // archived 5d ago
    });

    const cutoff = NOW.getTime() - 30 * DAY_MS; // archived_days = 30
    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: cutoff,
      expiredFactsBeforeMs: cutoff,
    });

    expect(res.observationsDeleted).toBe(1); // one row TOMBSTONED (count, not a delete)
    // docs/12 (Codex fix #1) — the aged archived row is NOT deleted: it is TOMBSTONED
    // (status='pruned', bulky text freed) so its sourceMessageRange keeps covering its
    // raw turns (a hard DELETE would resurrect them into inject/observer). All three
    // rows remain; recent-archived + active are untouched.
    expect(obsIds(db).sort()).toEqual([aged, active, recent].sort());
    const tombstoned = obsRow(db, aged);
    expect(tombstoned.status).toBe("pruned");
    expect(tombstoned.observation_text).toBe("[pruned]");
    expect(tombstoned.source_message_range).toBe(JSON.stringify(["m1", "m2"])); // coverage kept
    expect(obsRow(db, recent).status).toBe("archived");
    expect(obsRow(db, active).status).toBe("active");
  });

  it("deletes ONLY expired facts older than the cutoff; unexpired + recently-expired survive", async () => {
    const { store, db } = newStore(NOW);
    insertExpiredFact(db, "f-aged", "acct-a", "h-aged", NOW.getTime() - 100 * DAY_MS); // expired 100d ago
    insertExpiredFact(db, "f-recent", "acct-a", "h-recent", NOW.getTime() - 10 * DAY_MS); // expired 10d ago
    insertExpiredFact(db, "f-active", "acct-a", "h-active", null); // never expired

    const cutoff = NOW.getTime() - 90 * DAY_MS; // facts_expired_days = 90
    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: NOW.getTime() - 30 * DAY_MS,
      expiredFactsBeforeMs: cutoff,
    });

    expect(res.factsDeleted).toBe(1);
    expect(factIds(db).sort()).toEqual(["f-active", "f-recent"].sort());
  });

  it("a row stamped EXACTLY at the cutoff survives (strict lower bound)", async () => {
    const { store, db } = newStore(NOW);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const edge = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "edge",
      observedAt: NOW,
    });
    const cutoff = NOW.getTime() - 30 * DAY_MS;
    await store.archiveObservations({ accountId: "acct-a", ids: [edge], now: new Date(cutoff) });
    insertExpiredFact(db, "f-edge", "acct-a", "h-edge", cutoff);

    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: cutoff,
      expiredFactsBeforeMs: cutoff,
    });

    expect(res.observationsDeleted).toBe(0);
    expect(res.factsDeleted).toBe(0);
    expect(obsCount(db)).toBe(1);
    expect(factIds(db)).toEqual(["f-edge"]);
  });

  // docs/12 (Codex review fix #1) — the WHOLE POINT of tombstoning: after retention
  // prunes an archived observation, its row + sourceMessageRange must still be
  // returned by listObservations so inject/observer keep treating its raw turns as
  // covered (a hard DELETE here would orphan that coverage and resurrect the raw).
  it("keeps the tombstoned row visible to coverage reads (listObservations) so raw stays covered", async () => {
    const { store } = newStore(NOW);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const aged = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "aged",
      observedAt: NOW,
    });
    await store.archiveObservations({
      accountId: "acct-a",
      ids: [aged],
      now: new Date(NOW.getTime() - 40 * DAY_MS),
    });

    await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: NOW.getTime() - 30 * DAY_MS,
      expiredFactsBeforeMs: NOW.getTime() - 90 * DAY_MS,
    });

    // The coverage read (all statuses) still returns the pruned row + its range.
    const all = await store.listObservations({ accountId: "acct-a", threadId: "t-a" });
    const tombstone = all.find((o) => o.id === aged);
    expect(tombstone).toBeDefined();
    expect(tombstone?.status).toBe("pruned");
    expect(tombstone?.sourceMessageRange).toEqual(["m1", "m2"]); // coverage intact
  });

  it("is account-agnostic: ages out rows across every account in one sweep", async () => {
    const { store, db } = newStore(NOW);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    await store.ensureThread({ id: "t-b", ownerId: "acct-b" });
    const a = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "A",
      observedAt: NOW,
    });
    const b = await store.appendObservation({
      threadId: "t-b",
      sourceMessageRange: ["m3", "m4"],
      observationText: "B",
      observedAt: NOW,
    });
    const old = new Date(NOW.getTime() - 40 * DAY_MS);
    await store.archiveObservations({ accountId: "acct-a", ids: [a], now: old });
    await store.archiveObservations({ accountId: "acct-b", ids: [b], now: old });

    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: NOW.getTime() - 30 * DAY_MS,
      expiredFactsBeforeMs: NOW.getTime() - 90 * DAY_MS,
    });

    expect(res.observationsDeleted).toBe(2); // both accounts' aged archives TOMBSTONED
    // Tombstoned, not deleted — both rows remain (status='pruned'), coverage preserved.
    expect(obsCount(db)).toBe(2);
    expect(obsRow(db, a).status).toBe("pruned");
    expect(obsRow(db, b).status).toBe("pruned");
  });
});
