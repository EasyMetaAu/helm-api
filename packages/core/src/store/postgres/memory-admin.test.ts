import { describe, expect, it } from "vitest";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { MemoryFactContentHashConflictError } from "../ports.js";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

// docs/13 — the admin/MCP management half on the postgres adapter (PGlite,
// supabase == pg dialect). Mirrors memory-admin.test.ts (sqlite) and focuses on
// the dialect-sensitive paths: the listMemoryScopes UNION + bigint boxing, ILIKE
// search, the content_hash 409, soft-delete via .returning(), and reflection
// latest-per-scope grouping + in-place edit.

const NOW = new Date("2026-06-19T00:00:00.000Z");

async function newStore() {
  const db = await createPgliteDb();
  let seq = 0;
  const store = new PgMemoryStore(
    db,
    () => `id-${++seq}`,
    () => NOW,
  );
  return { store };
}

function addFact(
  store: PgMemoryStore,
  opts: {
    accountId: string;
    subjectKey?: string;
    factText: string;
    projectId?: string;
    validFrom?: Date;
  },
) {
  return store.insertFactsReconciled({
    accountId: opts.accountId,
    scope: opts.projectId !== undefined ? { projectId: opts.projectId } : {},
    now: NOW,
    facts: [
      {
        ownerId: opts.accountId,
        subjectKey: opts.subjectKey ?? "subject",
        factText: opts.factText,
        contentHash: factContentHash(opts.factText),
        validFrom: opts.validFrom ?? NOW,
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      },
    ],
  });
}

describe("PgMemoryStore admin/MCP surface (docs/13)", () => {
  it("listMemoryScopes aggregates facts ⊎ reflections with bigint counts", async () => {
    const { store } = await newStore();
    await addFact(store, { accountId: "a", projectId: "p1", subjectKey: "s1", factText: "f1" });
    await addFact(store, { accountId: "a", projectId: "p1", subjectKey: "s2", factText: "f2" });
    await store.upsertReflection({
      accountId: "a",
      projectId: "p2",
      reflectionText: "r",
      version: 1,
      tokenEstimate: 1,
      updatedAt: NOW,
    });
    const scopes = await store.listMemoryScopes({ accountId: "a" });
    const byProject = new Map(scopes.map((s) => [s.projectId, s]));
    expect(byProject.get("p1")).toMatchObject({ factCount: 2, reflectionCount: 0 });
    expect(byProject.get("p2")).toMatchObject({ factCount: 0, reflectionCount: 1 });
    expect(byProject.get("p1")?.lastUpdated).toBeInstanceOf(Date);
  });

  it("getMemoryAdminStats returns scoped storage and queue status", async () => {
    const { store } = await newStore();
    await store.ensureThread({ id: "t1", ownerId: "a", projectId: "p1" });
    const first = await store.appendMessage({
      threadId: "t1",
      messageIndex: 0,
      role: "user",
      content: "hello",
      tokenEstimate: 1,
    });
    const last = await store.appendMessage({
      threadId: "t1",
      messageIndex: 1,
      role: "assistant",
      content: "world",
      tokenEstimate: 1,
    });
    await store.appendObservation({
      threadId: "t1",
      sourceMessageRange: [first, last],
      observationText: "User said hello.",
      observedAt: NOW,
    });
    await addFact(store, { accountId: "a", projectId: "p1", factText: "User said hello." });
    await store.enqueueJob({
      type: "observer",
      scope: { accountId: "a", projectId: "p1", threadId: "t1" },
    });

    const stats = await store.getMemoryAdminStats({
      accountId: "a",
      projectId: "p1",
      now: NOW,
    });

    expect(stats.storage).toMatchObject({
      threads: 1,
      messages: 2,
      observations: 1,
      activeFacts: 1,
    });
    expect(stats.queue).toMatchObject({ pending: 1, running: 0, open: 1 });
    expect(stats.queue.byType).toContainEqual({ type: "observer", status: "pending", count: 1 });
    expect(stats.activity.lastMessageAt).toBeInstanceOf(Date);
    expect(stats.activity.lastObservationAt).toBeInstanceOf(Date);

    const globalStats = await store.getMemoryAdminStats({ now: NOW });
    expect(globalStats.storage).toMatchObject({
      threads: 1,
      messages: 2,
      observations: 1,
      activeFacts: 1,
    });
    expect(globalStats.queue).toMatchObject({ pending: 1, running: 0, open: 1 });
  });

  it("listFacts: 'active' hides superseded, 'all' shows it; ILIKE search works", async () => {
    const { store } = await newStore();
    await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "old",
      validFrom: new Date("2026-05-01"),
    });
    await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "NEW value",
      validFrom: new Date("2026-06-01"),
    });
    const active = await store.listFacts({ accountId: "a", limit: 50, offset: 0 });
    expect(active.rows.map((f) => f.factText)).toEqual(["NEW value"]);
    const all = await store.listFacts({ accountId: "a", status: "all", limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    // 'superseded' is the inverse of 'active': only the replaced row (active + expired).
    const superseded = await store.listFacts({
      accountId: "a",
      status: "superseded",
      limit: 50,
      offset: 0,
    });
    expect(superseded.rows.map((f) => f.factText)).toEqual(["old"]);
    expect(superseded.rows[0]?.expiredAt).not.toBeNull();
    const search = await store.listFacts({ accountId: "a", search: "new", limit: 50, offset: 0 }); // case-insensitive
    expect(search.rows.map((f) => f.factText)).toEqual(["NEW value"]);
  });

  it("updateFact recomputes hash + throws on collision; cross-tenant → null", async () => {
    const { store } = await newStore();
    await addFact(store, { accountId: "a", subjectKey: "s1", factText: "alpha" });
    const b = await addFact(store, { accountId: "a", subjectKey: "s2", factText: "beta" });
    const bId = b.insertedIds[0] as string;
    const updated = await store.updateFact({
      accountId: "a",
      id: bId,
      patch: { factText: "gamma" },
      now: NOW,
    });
    expect(updated?.contentHash).toBe(factContentHash("gamma"));
    expect(updated?.subjectKey).toBe("s2");
    await expect(
      store.updateFact({ accountId: "a", id: bId, patch: { factText: "alpha" }, now: NOW }),
    ).rejects.toBeInstanceOf(MemoryFactContentHashConflictError);
    expect(
      await store.updateFact({ accountId: "b", id: bId, patch: { importance: 1 }, now: NOW }),
    ).toBeNull();
  });

  it("deleteFact soft-prunes; deleteReflection archives; updateReflectionText keeps version", async () => {
    const { store } = await newStore();
    const f = await addFact(store, { accountId: "a", factText: "f" });
    const fId = f.insertedIds[0] as string;
    expect(await store.deleteFact({ accountId: "a", id: fId, now: NOW })).toBe(true);
    expect((await store.listFacts({ accountId: "a", limit: 10, offset: 0 })).rows).toHaveLength(0);

    const rId = await store.upsertReflection({
      accountId: "a",
      projectId: "p",
      reflectionText: "orig",
      version: 5,
      tokenEstimate: 2,
      updatedAt: NOW,
    });
    const edited = await store.updateReflectionText({
      accountId: "a",
      id: rId,
      reflectionText: "fixed",
      tokenEstimate: 3,
      now: NOW,
    });
    expect(edited?.reflectionText).toBe("fixed");
    expect(edited?.version).toBe(5);
    // Stage 1 — active row: soft delete (archive). Row survives for the operator.
    expect(await store.deleteReflection({ accountId: "a", id: rId })).toBe(true);
    expect(await store.getReflection({ accountId: "a", projectId: "p" })).toBeNull();
    expect((await store.getReflectionById({ accountId: "a", id: rId }))?.status).toBe("archived");
    // Stage 2 — already-archived row: a second delete HARD-purges it (was a 404).
    expect(await store.deleteReflection({ accountId: "a", id: rId })).toBe(true);
    expect(await store.getReflectionById({ accountId: "a", id: rId })).toBeNull();
    expect(await store.deleteReflection({ accountId: "a", id: rId })).toBe(false);
  });

  it("listReflections returns latest version per scope, all with the flag", async () => {
    const { store } = await newStore();
    await store.upsertReflection({
      accountId: "a",
      projectId: "p",
      reflectionText: "v1",
      version: 1,
      tokenEstimate: 1,
      updatedAt: new Date("2026-06-01"),
    });
    await store.upsertReflection({
      accountId: "a",
      projectId: "p",
      reflectionText: "v2",
      version: 2,
      tokenEstimate: 1,
      updatedAt: new Date("2026-06-02"),
    });
    const latest = await store.listReflections({ accountId: "a", limit: 10, offset: 0 });
    expect(latest.rows.map((r) => r.reflectionText)).toEqual(["v2"]);
    const all = await store.listReflections({
      accountId: "a",
      includeAllVersions: true,
      limit: 10,
      offset: 0,
    });
    expect(all.rows.map((r) => r.reflectionText).sort()).toEqual(["v1", "v2"]);
  });

  it("lifecycle fixes: multi-version reflection delete + fact reactivation expiry (pg)", async () => {
    const { store } = await newStore();
    // deleteReflection archives EVERY active version of the scope (not just one id).
    const v1 = await store.upsertReflection({
      accountId: "a",
      projectId: "p",
      reflectionText: "v1",
      version: 1,
      tokenEstimate: 1,
      updatedAt: new Date("2026-06-01"),
    });
    await store.upsertReflection({
      accountId: "a",
      projectId: "p",
      reflectionText: "v2",
      version: 2,
      tokenEstimate: 1,
      updatedAt: new Date("2026-06-02"),
    });
    expect(await store.deleteReflection({ accountId: "a", id: v1 })).toBe(true); // via older id
    expect(await store.getReflection({ accountId: "a", projectId: "p" })).toBeNull();
    // A second delete via the older id HARD-purges every archived version of the
    // scope — no zombie version resurfaces in the admin list after "delete".
    expect(await store.deleteReflection({ accountId: "a", id: v1 })).toBe(true);
    expect(
      (await store.listReflections({ accountId: "a", status: "all", limit: 10, offset: 0 })).total,
    ).toBe(0);

    // Reactivating a pruned fact clears expired_at so it lists active again.
    const f = await addFact(store, { accountId: "a", factText: "f" });
    const fId = f.insertedIds[0] as string;
    await store.deleteFact({ accountId: "a", id: fId, now: NOW });
    expect((await store.listFacts({ accountId: "a", limit: 10, offset: 0 })).rows).toHaveLength(0);
    const reactivated = await store.updateFact({
      accountId: "a",
      id: fId,
      patch: { status: "active" },
      now: NOW,
    });
    expect(reactivated?.expiredAt).toBeNull();
    expect((await store.listFacts({ accountId: "a", limit: 10, offset: 0 })).rows).toHaveLength(1);
  });
});
