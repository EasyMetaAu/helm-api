import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb, type PgDb } from "./migrate.js";

// docs/12 "Access reinforcement" (P3) — bumpReferences on the postgres adapter,
// mirroring the sqlite contract test. Runs against in-process PGlite so the
// supabase path is validated without a server.

async function readObservation(db: PgDb, id: string) {
  const res = (await db.execute(
    sql`SELECT reference_count, referenced_at FROM memory_observations WHERE id = ${id}`,
  )) as { rows?: Array<{ reference_count: number; referenced_at: number | null }> };
  return res.rows?.[0];
}
async function readReflection(db: PgDb, id: string) {
  const res = (await db.execute(
    sql`SELECT reference_count, referenced_at FROM memory_reflections WHERE id = ${id}`,
  )) as { rows?: Array<{ reference_count: number; referenced_at: number | null }> };
  return res.rows?.[0];
}

function newStore(db: PgDb, now: Date) {
  let seq = 0;
  return new PgMemoryStore(
    db,
    () => `id-${++seq}`,
    () => now,
  );
}

describe("PgMemoryStore.bumpReferences", () => {
  it("increments reference_count and stamps referenced_at for the named rows", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const db = await createPgliteDb();
    const store = newStore(db, now);
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

    const bumpAt = new Date("2026-06-02T00:00:00.000Z");
    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [obsId],
      reflectionIds: [reflId],
      now: bumpAt,
    });

    expect(Number((await readObservation(db, obsId))?.reference_count)).toBe(1);
    expect(Number((await readObservation(db, obsId))?.referenced_at)).toBe(bumpAt.getTime());
    expect(Number((await readReflection(db, reflId))?.reference_count)).toBe(1);
    expect(Number((await readReflection(db, reflId))?.referenced_at)).toBe(bumpAt.getTime());
    await db.$close();
  });

  it("only bumps rows owned by the request account (two-account fixture)", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const db = await createPgliteDb();
    const store = newStore(db, now);
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

    await store.bumpReferences?.({
      accountId: "acct-a",
      observationIds: [obsA, obsB],
      reflectionIds: [reflA, reflB],
      now: new Date("2026-06-05T00:00:00.000Z"),
    });

    expect(Number((await readObservation(db, obsA))?.reference_count)).toBe(1);
    expect(Number((await readObservation(db, obsB))?.reference_count)).toBe(0);
    expect(Number((await readReflection(db, reflA))?.reference_count)).toBe(1);
    expect(Number((await readReflection(db, reflB))?.reference_count)).toBe(0);
    await db.$close();
  });

  it("is a no-op on empty id lists", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const db = await createPgliteDb();
    const store = newStore(db, now);
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
    expect(Number((await readObservation(db, obsId))?.reference_count)).toBe(0);
    expect((await readObservation(db, obsId))?.referenced_at).toBeNull();
    await db.$close();
  });
});
