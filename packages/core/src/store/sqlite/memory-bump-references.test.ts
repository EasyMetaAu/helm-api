import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/12 "Access reinforcement" (P3) — bumpReferences on the sqlite adapter.
// The reinforcement hook is the loop-closer: it bumps reference_count + stamps
// referenced_at on EXACTLY the observations/reflections the injector kept, and is
// ACCOUNT-GUARDED (observations via their thread's owner_id, reflections via
// owner_id) so reinforcement is tenant-safe even with cross-account id collisions.

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

// Read the raw forgetting columns straight off the row (the store read paths do
// not surface reference_count yet, so assert against SQL directly).
function readObservation(db: ReturnType<typeof createSqliteDb>, id: string) {
  return db.$sqlite
    .prepare("SELECT reference_count, referenced_at FROM memory_observations WHERE id = ?")
    .get(id) as { reference_count: number; referenced_at: number | null } | undefined;
}
function readReflection(db: ReturnType<typeof createSqliteDb>, id: string) {
  return db.$sqlite
    .prepare("SELECT reference_count, referenced_at FROM memory_reflections WHERE id = ?")
    .get(id) as { reference_count: number; referenced_at: number | null } | undefined;
}

describe("SqliteMemoryStore.bumpReferences", () => {
  it("increments reference_count and stamps referenced_at for the named rows", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const obsId = await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: ["m1", "m2"],
      observationText: "obs",
      observedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const reflId = await store.upsertReflection({
      accountId: "acct-a",
      projectId: "p1",
      reflectionText: "refl",
      version: 1,
      tokenEstimate: 1,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    // Pre: never reinforced.
    expect(readObservation(db, obsId)).toEqual({ reference_count: 0, referenced_at: null });
    expect(readReflection(db, reflId)).toEqual({ reference_count: 0, referenced_at: null });

    const bumpAt = new Date("2026-06-02T00:00:00.000Z");
    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [obsId],
      reflectionIds: [reflId],
      now: bumpAt,
    });

    expect(readObservation(db, obsId)).toEqual({
      reference_count: 1,
      referenced_at: bumpAt.getTime(),
    });
    expect(readReflection(db, reflId)).toEqual({
      reference_count: 1,
      referenced_at: bumpAt.getTime(),
    });

    // A second bump accumulates the counter (frequency term) and re-stamps.
    const bumpAt2 = new Date("2026-06-03T00:00:00.000Z");
    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [obsId],
      reflectionIds: [],
      now: bumpAt2,
    });
    expect(readObservation(db, obsId)).toEqual({
      reference_count: 2,
      referenced_at: bumpAt2.getTime(),
    });
  });

  it("only bumps rows owned by the request account (tenant isolation, two-account fixture)", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
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
    const reflA = await store.upsertReflection({
      accountId: "acct-a",
      projectId: "p1",
      reflectionText: "RA",
      version: 1,
      tokenEstimate: 1,
      updatedAt: now,
    });
    const reflB = await store.upsertReflection({
      accountId: "acct-b",
      projectId: "p1",
      reflectionText: "RB",
      version: 1,
      tokenEstimate: 1,
      updatedAt: now,
    });

    // acct-a tries to bump BOTH accounts' ids — only its own must move.
    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [obsA, obsB],
      reflectionIds: [reflA, reflB],
      now: new Date("2026-06-05T00:00:00.000Z"),
    });

    expect(readObservation(db, obsA)?.reference_count).toBe(1);
    expect(readObservation(db, obsB)?.reference_count).toBe(0); // other account untouched
    expect(readReflection(db, reflA)?.reference_count).toBe(1);
    expect(readReflection(db, reflB)?.reference_count).toBe(0);
  });

  it("is a no-op on empty id lists", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const { store, db } = newStore(now);
    await store.ensureThread({ id: "t1", ownerId: "acct-a" });
    const obsId = await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: ["m1", "m2"],
      observationText: "obs",
      observedAt: now,
    });
    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [],
      reflectionIds: [],
      now: new Date("2026-06-05T00:00:00.000Z"),
    });
    expect(readObservation(db, obsId)).toEqual({ reference_count: 0, referenced_at: null });
  });
});
