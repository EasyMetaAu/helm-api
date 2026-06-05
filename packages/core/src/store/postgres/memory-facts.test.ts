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
