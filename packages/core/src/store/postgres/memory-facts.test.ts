import type { MemoryFactInput } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

// docs/12 P6 — fact-reconcile store half on the postgres adapter (PGlite in-process,
// supabase == pg dialect). Mirrors the sqlite contract test: insertFactsReconciled
// (idempotent (owner_id, content_hash) dedup + same-(owner_id, subject_key)
// supersede via a pure datetime UPDATE, never a DELETE) + listActiveFacts
// (owner_id + status='active' + expired_at IS NULL).

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

function fact(
  overrides: Partial<MemoryFactInput> & Pick<MemoryFactInput, "ownerId">,
): MemoryFactInput {
  return {
    ownerId: overrides.ownerId,
    subjectKey: overrides.subjectKey ?? "subject",
    factText: overrides.factText ?? "a fact",
    contentHash: overrides.contentHash ?? "hash-default",
    validFrom: overrides.validFrom ?? new Date("2026-05-01T00:00:00.000Z"),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    ...(overrides.resourceId !== undefined ? { resourceId: overrides.resourceId } : {}),
    ...(overrides.threadId !== undefined ? { threadId: overrides.threadId } : {}),
  };
}

describe("PgMemoryStore.insertFactsReconciled (dedup + supersede, docs/12 P6)", () => {
  it("inserts a fresh fact and lists it active", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "fav-lang",
          contentHash: "h1",
          factText: "likes TS",
        }),
      ],
    });

    const active = await store.listActiveFacts({ accountId: "acct-a" });
    expect(active).toHaveLength(1);
    expect(active[0]?.factText).toBe("likes TS");
    expect(active[0]?.expiredAt).toBeNull();
    expect(active[0]?.validFrom).toEqual(new Date("2026-05-01T00:00:00.000Z"));
  });

  it("idempotently SKIPS an identical (owner_id, content_hash)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const f = fact({ ownerId: "acct-a", contentHash: "h1", factText: "likes TS" });
    await store.insertFactsReconciled({ accountId: "acct-a", scope: {}, now, facts: [f] });
    await store.insertFactsReconciled({ accountId: "acct-a", scope: {}, now, facts: [f] });
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(1);
  });

  it("stores the SAME content_hash under TWO accounts (account-scoped dedup)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-a", contentHash: "shared" })],
    });
    await store.insertFactsReconciled({
      accountId: "acct-b",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-b", contentHash: "shared" })],
    });
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(1);
    expect(await store.listActiveFacts({ accountId: "acct-b" })).toHaveLength(1);
  });

  it("supersedes an OLDER same-(owner_id, subject_key) fact: stamps expired_at + invalid_at, never deletes", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const newValidFrom = new Date("2026-06-01T00:00:00.000Z");
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "region",
          contentHash: "old",
          validFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
      ],
    });
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "region",
          contentHash: "new",
          validFrom: newValidFrom,
        }),
      ],
    });

    // Both rows still exist (audit-friendly) — only the fresh one is alive.
    const active = await store.listActiveFacts({ accountId: "acct-a" });
    expect(active).toHaveLength(1);
    expect(active[0]?.contentHash).toBe("new");
  });

  // docs/12 (Codex review fix #2, pg mirror) — supersede narrows by the NEW fact's
  // non-null scope columns only, matching the read path; a newer project-level fact
  // must expire an older same-subject fact that also carries a thread id under that
  // project, while a different project's fact stays alive.
  it("a newer project-level fact supersedes an older same-subject fact with a NARROWER scope under that project", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "deploy-region",
          contentHash: "old-narrow",
          projectId: "p1",
          threadId: "t1",
          validFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
        fact({
          ownerId: "acct-a",
          subjectKey: "deploy-region",
          contentHash: "other-project",
          projectId: "p2",
          validFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
      ],
    });
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "deploy-region",
          contentHash: "new-project",
          projectId: "p1",
          validFrom: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ],
    });

    const p1Active = await store.listActiveFacts({ accountId: "acct-a", projectId: "p1" });
    expect(p1Active.map((f) => f.contentHash)).toEqual(["new-project"]);
    const p2Active = await store.listActiveFacts({ accountId: "acct-a", projectId: "p2" });
    expect(p2Active.map((f) => f.contentHash)).toEqual(["other-project"]);
  });

  it("does NOT supersede across different subject_keys or accounts", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "fav-lang",
          contentHash: "a1",
          validFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
      ],
    });
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "region",
          contentHash: "a2",
          validFrom: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ],
    });
    await store.insertFactsReconciled({
      accountId: "acct-b",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-b",
          subjectKey: "fav-lang",
          contentHash: "b1",
          validFrom: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ],
    });
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(2);
    expect(await store.listActiveFacts({ accountId: "acct-b" })).toHaveLength(1);
  });

  it("listActiveFacts narrows by the in-account scope columns", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: { projectId: "proj-1" },
      now,
      facts: [
        fact({ ownerId: "acct-a", projectId: "proj-1", contentHash: "p1", subjectKey: "s-p" }),
      ],
    });
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: { projectId: "proj-2" },
      now,
      facts: [
        fact({ ownerId: "acct-a", projectId: "proj-2", contentHash: "p2", subjectKey: "s-q" }),
      ],
    });
    const proj1 = await store.listActiveFacts({ accountId: "acct-a", projectId: "proj-1" });
    expect(proj1).toHaveLength(1);
    expect(proj1[0]?.contentHash).toBe("p1");
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(2);
  });
});

// Resurrect-on-re-ingest (pg mirror of the sqlite contract): a manual delete soft-
// prunes the fact but keeps its content_hash, so the UNIQUE(owner_id, content_hash)
// index would suppress every re-extraction. A dedup hit against a NON-live row
// (pruned/archived) REACTIVATES it instead of skipping.
describe("PgMemoryStore.insertFactsReconciled (resurrect deleted fact on re-ingest)", () => {
  it("RESURRECTS a pruned fact when the same content_hash is re-ingested", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const v1 = new Date("2026-05-01T00:00:00.000Z");
    const v2 = new Date("2026-06-04T00:00:00.000Z");

    const first = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({ ownerId: "acct-a", subjectKey: "fav-lang", contentHash: "h1", validFrom: v1 }),
      ],
    });
    const id = first.insertedIds[0];
    expect(id).toBeDefined();

    expect(await store.deleteFact({ accountId: "acct-a", id: id as string, now })).toBe(true);
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(0);

    const again = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({ ownerId: "acct-a", subjectKey: "fav-lang", contentHash: "h1", validFrom: v2 }),
      ],
    });
    expect(again.insertedIds).toEqual([]);
    expect(again.resurrectedIds).toEqual([id]);

    // Reactivated in place — no second row (total over all statuses stays 1).
    const all = await store.listFacts({
      accountId: "acct-a",
      status: "all",
      limit: 100,
      offset: 0,
    });
    expect(all.total).toBe(1);

    const active = await store.listActiveFacts({ accountId: "acct-a" });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(id);
    expect(active[0]?.status).toBe("active");
    expect(active[0]?.expiredAt).toBeNull();
    expect(active[0]?.validFrom).toEqual(v2);
  });

  it("RE-SCOPES the resurrected row to the re-ingest scope (account-global hash, new project wins)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const v1 = new Date("2026-05-01T00:00:00.000Z");
    const v2 = new Date("2026-06-04T00:00:00.000Z");

    const first = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: { projectId: "p1" },
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "fav-color",
          contentHash: "h1",
          validFrom: v1,
          projectId: "p1",
        }),
      ],
    });
    const id = first.insertedIds[0] as string;
    await store.deleteFact({ accountId: "acct-a", id, now });

    // Re-stated under a DIFFERENT project p2 — same content_hash dedup-hits the old
    // (account-global) row; without re-scoping it would revive under p1 and a p2 inject
    // would never see it.
    const again = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: { projectId: "p2" },
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "fav-color",
          contentHash: "h1",
          validFrom: v2,
          projectId: "p2",
        }),
      ],
    });
    expect(again.resurrectedIds).toEqual([id]);

    expect(await store.listActiveFacts({ accountId: "acct-a", projectId: "p2" })).toHaveLength(1);
    expect(await store.listActiveFacts({ accountId: "acct-a", projectId: "p1" })).toHaveLength(0);
  });

  it("a resurrected fact supersedes an older still-active same-subject sibling", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const vOld = new Date("2026-05-01T00:00:00.000Z");
    const vDel = new Date("2026-05-20T00:00:00.000Z");
    const vNew = new Date("2026-06-04T00:00:00.000Z");

    const first = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-a", subjectKey: "s", contentHash: "del", validFrom: vDel })],
    });
    const delId = first.insertedIds[0] as string;
    await store.deleteFact({ accountId: "acct-a", id: delId, now });
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({ ownerId: "acct-a", subjectKey: "s", contentHash: "sibling", validFrom: vOld }),
      ],
    });
    expect(
      (await store.listActiveFacts({ accountId: "acct-a" })).map((f) => f.contentHash),
    ).toEqual(["sibling"]);

    const again = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-a", subjectKey: "s", contentHash: "del", validFrom: vNew })],
    });
    expect(again.resurrectedIds).toEqual([delId]);
    expect(
      (await store.listActiveFacts({ accountId: "acct-a" })).map((f) => f.contentHash),
    ).toEqual(["del"]);
  });

  it("a still-LIVE duplicate is NOT resurrected (stays an idempotent no-op)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = await newStore(now);
    const f = fact({ ownerId: "acct-a", subjectKey: "s", contentHash: "h1" });
    await store.insertFactsReconciled({ accountId: "acct-a", scope: {}, now, facts: [f] });
    const again = await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [f],
    });
    expect(again.insertedIds).toEqual([]);
    expect(again.resurrectedIds).toEqual([]);
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(1);
  });
});
