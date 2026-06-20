import { describe, expect, it } from "vitest";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { MemoryFactContentHashConflictError } from "../ports.js";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/13 — the admin/MCP management half of the fact + reflection store on the
// sqlite adapter: scope enumeration, paginated reads with an explicit status
// filter (superseded/archived/pruned rows VISIBLE — unlike the inject read),
// in-place edit (content_hash recompute + 409 collision), and soft-delete.

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

function addFact(
  store: SqliteMemoryStore,
  opts: {
    accountId: string;
    subjectKey?: string;
    factText: string;
    projectId?: string;
    validFrom?: Date;
    now: Date;
  },
) {
  return store.insertFactsReconciled({
    accountId: opts.accountId,
    scope: opts.projectId !== undefined ? { projectId: opts.projectId } : {},
    now: opts.now,
    facts: [
      {
        ownerId: opts.accountId,
        subjectKey: opts.subjectKey ?? "subject",
        factText: opts.factText,
        contentHash: factContentHash(opts.factText),
        validFrom: opts.validFrom ?? opts.now,
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      },
    ],
  });
}

function addReflection(
  store: SqliteMemoryStore,
  opts: { accountId: string; projectId?: string; text: string; version: number; updatedAt: Date },
) {
  return store.upsertReflection({
    accountId: opts.accountId,
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    reflectionText: opts.text,
    version: opts.version,
    tokenEstimate: Math.ceil(opts.text.length / 4),
    updatedAt: opts.updatedAt,
  });
}

const NOW = new Date("2026-06-19T00:00:00.000Z");

describe("SqliteMemoryStore.insertFactsReconciled return value (docs/13)", () => {
  it("returns the inserted id and no supersede on a fresh fact", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "likes TS", now: NOW });
    expect(res.insertedIds).toHaveLength(1);
    expect(res.supersededIds).toEqual([]);
  });

  it("returns the superseded id when a newer same-subject fact replaces an older one", async () => {
    const { store } = newStore(NOW);
    const first = await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "likes TS",
      validFrom: new Date("2026-05-01T00:00:00.000Z"),
      now: NOW,
    });
    const second = await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "likes Rust",
      validFrom: new Date("2026-06-01T00:00:00.000Z"),
      now: NOW,
    });
    expect(second.insertedIds).toHaveLength(1);
    expect(second.supersededIds).toEqual(first.insertedIds);
  });

  it("returns no inserted id when a fact dedups on (owner_id, content_hash)", async () => {
    const { store } = newStore(NOW);
    await addFact(store, { accountId: "a", factText: "dup", now: NOW });
    const again = await addFact(store, { accountId: "a", factText: "dup", now: NOW });
    expect(again.insertedIds).toEqual([]);
  });
});

describe("SqliteMemoryStore.listMemoryScopes (docs/13)", () => {
  it("enumerates fact-only, reflection-only, and mixed scopes with counts", async () => {
    const { store } = newStore(NOW);
    // project p1: facts only (2)
    await addFact(store, {
      accountId: "a",
      projectId: "p1",
      subjectKey: "s1",
      factText: "f1",
      now: NOW,
    });
    await addFact(store, {
      accountId: "a",
      projectId: "p1",
      subjectKey: "s2",
      factText: "f2",
      now: NOW,
    });
    // project p2: reflection only
    await addReflection(store, {
      accountId: "a",
      projectId: "p2",
      text: "r2",
      version: 1,
      updatedAt: NOW,
    });
    // project p3: both
    await addFact(store, {
      accountId: "a",
      projectId: "p3",
      subjectKey: "s3",
      factText: "f3",
      now: NOW,
    });
    await addReflection(store, {
      accountId: "a",
      projectId: "p3",
      text: "r3",
      version: 1,
      updatedAt: NOW,
    });

    const scopes = await store.listMemoryScopes({ accountId: "a" });
    const byProject = new Map(scopes.map((s) => [s.projectId, s]));
    expect(byProject.get("p1")).toMatchObject({ factCount: 2, reflectionCount: 0 });
    expect(byProject.get("p2")).toMatchObject({ factCount: 0, reflectionCount: 1 });
    expect(byProject.get("p3")).toMatchObject({ factCount: 1, reflectionCount: 1 });
  });

  it("isolates by account", async () => {
    const { store } = newStore(NOW);
    await addFact(store, { accountId: "a", projectId: "p1", factText: "fa", now: NOW });
    await addFact(store, { accountId: "b", projectId: "p1", factText: "fb", now: NOW });
    const onlyA = await store.listMemoryScopes({ accountId: "a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.accountId).toBe("a");
    const all = await store.listMemoryScopes({});
    expect(all.map((s) => s.accountId).sort()).toEqual(["a", "b"]);
  });
});

describe("SqliteMemoryStore fact reads (docs/13)", () => {
  it("getFactById is account-guarded (cross-tenant id → null)", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "secret", now: NOW });
    const id = res.insertedIds[0] as string;
    expect((await store.getFactById({ accountId: "a", id }))?.factText).toBe("secret");
    expect(await store.getFactById({ accountId: "b", id })).toBeNull();
  });

  it("listFacts hides superseded under 'active' but shows them under 'all'", async () => {
    const { store } = newStore(NOW);
    await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "old",
      validFrom: new Date("2026-05-01T00:00:00.000Z"),
      now: NOW,
    });
    await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "new",
      validFrom: new Date("2026-06-01T00:00:00.000Z"),
      now: NOW,
    });
    const active = await store.listFacts({ accountId: "a", limit: 50, offset: 0 });
    expect(active.rows.map((f) => f.factText)).toEqual(["new"]);
    expect(active.total).toBe(1);
    const all = await store.listFacts({ accountId: "a", status: "all", limit: 50, offset: 0 });
    expect(all.rows.map((f) => f.factText).sort()).toEqual(["new", "old"]);
    expect(all.total).toBe(2);
  });

  it("filters by search term and subjectKey", async () => {
    const { store } = newStore(NOW);
    await addFact(store, {
      accountId: "a",
      subjectKey: "lang",
      factText: "loves TypeScript",
      now: NOW,
    });
    await addFact(store, { accountId: "a", subjectKey: "food", factText: "loves ramen", now: NOW });
    const search = await store.listFacts({ accountId: "a", search: "ramen", limit: 50, offset: 0 });
    expect(search.rows.map((f) => f.factText)).toEqual(["loves ramen"]);
    const subject = await store.listFacts({
      accountId: "a",
      subjectKey: "lang",
      limit: 50,
      offset: 0,
    });
    expect(subject.rows.map((f) => f.subjectKey)).toEqual(["lang"]);
  });
});

describe("SqliteMemoryStore.updateFact (docs/13)", () => {
  it("edits factText, recomputes content_hash, preserves subjectKey", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, {
      accountId: "a",
      subjectKey: "fav",
      factText: "old text",
      now: NOW,
    });
    const id = res.insertedIds[0] as string;
    const updated = await store.updateFact({
      accountId: "a",
      id,
      patch: { factText: "new text" },
      now: NOW,
    });
    expect(updated?.factText).toBe("new text");
    expect(updated?.contentHash).toBe(factContentHash("new text"));
    expect(updated?.subjectKey).toBe("fav");
  });

  it("throws on a content_hash collision with a sibling fact", async () => {
    const { store } = newStore(NOW);
    await addFact(store, { accountId: "a", subjectKey: "s1", factText: "alpha", now: NOW });
    const b = await addFact(store, {
      accountId: "a",
      subjectKey: "s2",
      factText: "beta",
      now: NOW,
    });
    const bId = b.insertedIds[0] as string;
    await expect(
      store.updateFact({ accountId: "a", id: bId, patch: { factText: "alpha" }, now: NOW }),
    ).rejects.toBeInstanceOf(MemoryFactContentHashConflictError);
  });

  it("edits importance, status, and invalidAt (tri-state)", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "f", now: NOW });
    const id = res.insertedIds[0] as string;
    const inv = new Date("2026-07-01T00:00:00.000Z");
    const u1 = await store.updateFact({
      accountId: "a",
      id,
      patch: { importance: 0.9, status: "archived", invalidAt: inv },
      now: NOW,
    });
    expect(u1?.importance).toBe(0.9);
    expect(u1?.status).toBe("archived");
    expect(u1?.invalidAt?.getTime()).toBe(inv.getTime());
    // null clears invalidAt
    const u2 = await store.updateFact({ accountId: "a", id, patch: { invalidAt: null }, now: NOW });
    expect(u2?.invalidAt).toBeNull();
  });

  it("returns null for an unknown or cross-tenant id", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "f", now: NOW });
    const id = res.insertedIds[0] as string;
    expect(
      await store.updateFact({ accountId: "a", id: "nope", patch: { importance: 1 }, now: NOW }),
    ).toBeNull();
    expect(
      await store.updateFact({ accountId: "b", id, patch: { importance: 1 }, now: NOW }),
    ).toBeNull();
  });

  it("reactivating a pruned fact clears expired_at so it lists active again", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "f", now: NOW });
    const id = res.insertedIds[0] as string;
    await store.deleteFact({ accountId: "a", id, now: NOW }); // pruned + expired_at stamped
    expect((await store.listFacts({ accountId: "a", limit: 10, offset: 0 })).rows).toHaveLength(0);
    const reactivated = await store.updateFact({
      accountId: "a",
      id,
      patch: { status: "active" },
      now: NOW,
    });
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.expiredAt).toBeNull();
    expect((await store.listFacts({ accountId: "a", limit: 10, offset: 0 })).rows).toHaveLength(1);
  });

  it("editing a fact to pruned stamps expired_at", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "f", now: NOW });
    const id = res.insertedIds[0] as string;
    const pruned = await store.updateFact({
      accountId: "a",
      id,
      patch: { status: "pruned" },
      now: NOW,
    });
    expect(pruned?.status).toBe("pruned");
    expect(pruned?.expiredAt).not.toBeNull();
  });
});

describe("SqliteMemoryStore.deleteFact (docs/13)", () => {
  it("soft-deletes (pruned) — gone from active, visible under 'all'", async () => {
    const { store } = newStore(NOW);
    const res = await addFact(store, { accountId: "a", factText: "f", now: NOW });
    const id = res.insertedIds[0] as string;
    expect(await store.deleteFact({ accountId: "a", id, now: NOW })).toBe(true);
    const active = await store.listFacts({ accountId: "a", limit: 50, offset: 0 });
    expect(active.rows).toHaveLength(0);
    const all = await store.listFacts({ accountId: "a", status: "all", limit: 50, offset: 0 });
    expect(all.rows[0]?.status).toBe("pruned");
    // second delete is a no-op
    expect(await store.deleteFact({ accountId: "a", id, now: NOW })).toBe(false);
    // unknown / cross-tenant
    expect(await store.deleteFact({ accountId: "b", id, now: NOW })).toBe(false);
  });
});

describe("SqliteMemoryStore reflection management (docs/13)", () => {
  it("listReflections returns the latest version per scope by default, all with the flag", async () => {
    const { store } = newStore(NOW);
    await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v1",
      version: 1,
      updatedAt: new Date("2026-06-01"),
    });
    await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v2",
      version: 2,
      updatedAt: new Date("2026-06-02"),
    });
    const latest = await store.listReflections({ accountId: "a", limit: 50, offset: 0 });
    expect(latest.rows.map((r) => r.reflectionText)).toEqual(["v2"]);
    expect(latest.total).toBe(1);
    const all = await store.listReflections({
      accountId: "a",
      includeAllVersions: true,
      limit: 50,
      offset: 0,
    });
    expect(all.rows.map((r) => r.reflectionText).sort()).toEqual(["v1", "v2"]);
  });

  it("updateReflectionText edits in place WITHOUT bumping version", async () => {
    const { store } = newStore(NOW);
    const id = await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "original",
      version: 3,
      updatedAt: NOW,
    });
    const updated = await store.updateReflectionText({
      accountId: "a",
      id,
      reflectionText: "corrected by operator",
      tokenEstimate: 7,
      now: NOW,
    });
    expect(updated?.reflectionText).toBe("corrected by operator");
    expect(updated?.version).toBe(3); // unchanged
    expect(updated?.tokenEstimate).toBe(7);
    expect(
      await store.updateReflectionText({
        accountId: "b",
        id,
        reflectionText: "x",
        tokenEstimate: 1,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("deleteReflection is two-stage: active→archive (soft), archived→purge (hard)", async () => {
    const { store } = newStore(NOW);
    const id = await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "r",
      version: 1,
      updatedAt: NOW,
    });
    expect(await store.getReflection({ accountId: "a", projectId: "p" })).not.toBeNull();
    // Stage 1 — active row: soft delete. Stops injection but the row SURVIVES
    // (status='archived') so the operator can still see/restore it.
    expect(await store.deleteReflection({ accountId: "a", id })).toBe(true);
    expect(await store.getReflection({ accountId: "a", projectId: "p" })).toBeNull();
    expect(await store.getReflectionById({ accountId: "a", id })).not.toBeNull();
    expect((await store.getReflectionById({ accountId: "a", id }))?.status).toBe("archived");
    // Stage 2 — already-archived row: a second delete HARD-purges it (the bug:
    // it used to 404 "reflection not found", leaving an undeletable archived row).
    expect(await store.deleteReflection({ accountId: "a", id })).toBe(true);
    expect(await store.getReflectionById({ accountId: "a", id })).toBeNull();
    // Stage 3 — genuinely gone now → false (real not-found).
    expect(await store.deleteReflection({ accountId: "a", id })).toBe(false);
  });

  it("hard-purge of an archived reflection clears EVERY version of the scope (no zombie resurfaces)", async () => {
    const { store } = newStore(NOW);
    // Multiple version rows for ONE scope (upsertReflection always appends a row).
    const v1 = await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v1",
      version: 1,
      updatedAt: new Date("2026-06-01"),
    });
    const v2 = await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v2",
      version: 2,
      updatedAt: new Date("2026-06-02"),
    });
    // Soft delete archives all active versions of the scope.
    expect(await store.deleteReflection({ accountId: "a", id: v2 })).toBe(true);
    // Hard purge via the latest archived id must drop EVERY archived version,
    // else latestPerScope would resurface v1 in the admin list after "delete".
    expect(await store.deleteReflection({ accountId: "a", id: v2 })).toBe(true);
    expect(await store.getReflectionById({ accountId: "a", id: v1 })).toBeNull();
    expect(await store.getReflectionById({ accountId: "a", id: v2 })).toBeNull();
    const list = await store.listReflections({
      accountId: "a",
      status: "all",
      includeAllVersions: true,
      limit: 10,
      offset: 0,
    });
    expect(list.total).toBe(0);
  });

  it("deleteReflection archives EVERY active version of the scope (not just one id)", async () => {
    const { store } = newStore(NOW);
    // Two active versions of the SAME scope (upsertReflection appends without archiving).
    const v1 = await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v1",
      version: 1,
      updatedAt: new Date("2026-06-01"),
    });
    await addReflection(store, {
      accountId: "a",
      projectId: "p",
      text: "v2",
      version: 2,
      updatedAt: new Date("2026-06-02"),
    });
    expect((await store.getReflection({ accountId: "a", projectId: "p" }))?.reflectionText).toBe(
      "v2",
    );
    // Delete via the OLDER version's id — must still stop injection ENTIRELY (the
    // bug: archiving only v1 left v2 active so getReflection fell back to it).
    expect(await store.deleteReflection({ accountId: "a", id: v1 })).toBe(true);
    expect(await store.getReflection({ accountId: "a", projectId: "p" })).toBeNull();
  });
});
