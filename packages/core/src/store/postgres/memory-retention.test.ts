import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

// docs/12 P7 — the retention HARD-DELETE store half on the postgres adapter (PGlite
// in-process, supabase == pg dialect). Mirrors the sqlite contract: pruneExpiredMemory,
// the ONLY DELETE in the forgetting system. Account-agnostic, two deletes in one call:
//   1. archived observations whose archived_at < cutoff (NEVER active rows);
//   2. expired facts whose expired_at < cutoff (NEVER unexpired facts).
// Strict lower bounds (a row stamped exactly at the cutoff survives). Reflections are
// never hard-deleted. Gating + cutoff math live in the pure pruner (forgetting/
// retention.test.ts); this exercises the SQL.

async function newStore(now: Date) {
  const db = await createPgliteDb();
  let seq = 0;
  const store = new PgMemoryStore(
    db,
    () => `id-${++seq}`,
    () => now,
  );
  return { store, db };
}

async function countRows(
  db: Awaited<ReturnType<typeof createPgliteDb>>,
  table: "memory_observations" | "memory_facts",
): Promise<number> {
  const out = (await db.execute(
    table === "memory_observations"
      ? sql`SELECT COUNT(*)::int AS c FROM memory_observations`
      : sql`SELECT COUNT(*)::int AS c FROM memory_facts`,
  )) as unknown;
  const rows = (Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? [])) as Array<{
    c: number | string;
  }>;
  return Number(rows[0]?.c ?? 0);
}

async function obsIds(db: Awaited<ReturnType<typeof createPgliteDb>>): Promise<string[]> {
  const out = (await db.execute(sql`SELECT id FROM memory_observations ORDER BY id`)) as unknown;
  const rows = (Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id);
}

async function obsStatus(
  db: Awaited<ReturnType<typeof createPgliteDb>>,
  id: string,
): Promise<{ status: string; observation_text: string }> {
  const out = (await db.execute(
    sql`SELECT status, observation_text FROM memory_observations WHERE id = ${id}`,
  )) as unknown;
  const rows = (Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? [])) as Array<{
    status: string;
    observation_text: string;
  }>;
  return rows[0] as { status: string; observation_text: string };
}

// Insert a fact already stamped expired_at (the supersede outcome P7 collects),
// controlling the timestamp directly.
async function insertExpiredFact(
  db: Awaited<ReturnType<typeof createPgliteDb>>,
  id: string,
  ownerId: string,
  contentHash: string,
  expiredAt: number | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO memory_facts
      (id, owner_id, project_id, resource_id, thread_id, subject_key, fact_text,
       content_hash, importance, reference_count, referenced_at, valid_from,
       invalid_at, expired_at, status, source_observation_range, created_at, updated_at)
    VALUES (${id}, ${ownerId}, NULL, NULL, NULL, 'subj', 'a fact', ${contentHash}, 0.5, 0,
            NULL, 1000, NULL, ${expiredAt}, 'active', NULL, 1000, 1000)
  `);
}

const NOW = new Date("2026-06-05T00:00:00.000Z");
const DAY_MS = 86_400_000;

describe("PgMemoryStore.pruneExpiredMemory (P7 retention hard-delete)", () => {
  it("deletes ONLY archived observations older than the cutoff; active + recent survive", async () => {
    const { store, db } = await newStore(NOW);
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

    await store.archiveObservations({
      accountId: "acct-a",
      ids: [aged],
      now: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    await store.archiveObservations({
      accountId: "acct-a",
      ids: [recent],
      now: new Date(NOW.getTime() - 5 * DAY_MS),
    });

    const cutoff = NOW.getTime() - 30 * DAY_MS;
    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: cutoff,
      expiredFactsBeforeMs: cutoff,
    });

    expect(res.observationsDeleted).toBe(1); // one row TOMBSTONED (count, not a delete)
    // docs/12 (Codex fix #1) — TOMBSTONE not delete: the aged row stays (status='pruned',
    // text freed) so its coverage survives; recent + active untouched. All three remain.
    expect((await obsIds(db)).sort()).toEqual([aged, active, recent].sort());
    const tombstoned = await obsStatus(db, aged);
    expect(tombstoned.status).toBe("pruned");
    expect(tombstoned.observation_text).toBe("[pruned]");
    expect((await obsStatus(db, recent)).status).toBe("archived");
    expect((await obsStatus(db, active)).status).toBe("active");
  });

  it("deletes ONLY expired facts older than the cutoff; unexpired + recently-expired survive", async () => {
    const { store, db } = await newStore(NOW);
    await insertExpiredFact(db, "f-aged", "acct-a", "h-aged", NOW.getTime() - 100 * DAY_MS);
    await insertExpiredFact(db, "f-recent", "acct-a", "h-recent", NOW.getTime() - 10 * DAY_MS);
    await insertExpiredFact(db, "f-active", "acct-a", "h-active", null);

    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: NOW.getTime() - 30 * DAY_MS,
      expiredFactsBeforeMs: NOW.getTime() - 90 * DAY_MS,
    });

    expect(res.factsDeleted).toBe(1);
    expect(await countRows(db, "memory_facts")).toBe(2); // f-active + f-recent
  });

  it("a row stamped EXACTLY at the cutoff survives (strict lower bound)", async () => {
    const { store, db } = await newStore(NOW);
    await store.ensureThread({ id: "t-a", ownerId: "acct-a" });
    const edge = await store.appendObservation({
      threadId: "t-a",
      sourceMessageRange: ["m1", "m2"],
      observationText: "edge",
      observedAt: NOW,
    });
    const cutoff = NOW.getTime() - 30 * DAY_MS;
    await store.archiveObservations({ accountId: "acct-a", ids: [edge], now: new Date(cutoff) });
    await insertExpiredFact(db, "f-edge", "acct-a", "h-edge", cutoff);

    const res = await store.pruneExpiredMemory({
      archivedObservationsBeforeMs: cutoff,
      expiredFactsBeforeMs: cutoff,
    });

    expect(res.observationsDeleted).toBe(0);
    expect(res.factsDeleted).toBe(0);
    expect(await countRows(db, "memory_observations")).toBe(1);
    expect(await countRows(db, "memory_facts")).toBe(1);
  });

  it("is account-agnostic: ages out rows across every account in one sweep", async () => {
    const { store, db } = await newStore(NOW);
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
    expect(await countRows(db, "memory_observations")).toBe(2);
    expect((await obsStatus(db, a)).status).toBe("pruned");
    expect((await obsStatus(db, b)).status).toBe("pruned");
  });
});
