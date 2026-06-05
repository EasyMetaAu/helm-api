import type { MemoryFactInput } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

// docs/12 P6 — the fact-reconcile store half on the sqlite adapter:
// insertFactsReconciled (idempotent dedup by (owner_id, content_hash) + same-
// (owner_id, subject_key) supersede via a pure datetime UPDATE, never a DELETE) +
// listActiveFacts (owner_id + status='active' + expired_at IS NULL). The
// extraction/subject-key/hash derivation lives + is tested in the pure Reflector
// path; this exercises the SQL contract + tenant isolation.

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
    ...(overrides.importance !== undefined ? { importance: overrides.importance } : {}),
    ...(overrides.sourceObservationRange !== undefined
      ? { sourceObservationRange: overrides.sourceObservationRange }
      : {}),
  };
}

function rawFacts(db: ReturnType<typeof createSqliteDb>) {
  return db.$sqlite
    .prepare(
      "SELECT id, owner_id, subject_key, content_hash, status, valid_from, invalid_at, expired_at FROM memory_facts ORDER BY created_at ASC, id ASC",
    )
    .all() as Array<{
    id: string;
    owner_id: string;
    subject_key: string;
    content_hash: string;
    status: string;
    valid_from: number;
    invalid_at: number | null;
    expired_at: number | null;
  }>;
}

describe("SqliteMemoryStore.insertFactsReconciled (dedup + supersede, docs/12 P6)", () => {
  it("inserts a fresh fact and lists it active", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
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
    expect(active[0]?.subjectKey).toBe("fav-lang");
    expect(active[0]?.status).toBe("active");
    expect(active[0]?.expiredAt).toBeNull();
  });

  it("idempotently SKIPS an identical (owner_id, content_hash) — no second row", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    const f = fact({
      ownerId: "acct-a",
      subjectKey: "fav-lang",
      contentHash: "h1",
      factText: "likes TS",
    });
    await store.insertFactsReconciled({ accountId: "acct-a", scope: {}, now, facts: [f] });
    // Re-ingest the SAME fact (same content_hash) — the UNIQUE(owner_id, content_hash) skips it.
    await store.insertFactsReconciled({ accountId: "acct-a", scope: {}, now, facts: [f] });

    expect(rawFacts(db)).toHaveLength(1);
    const active = await store.listActiveFacts({ accountId: "acct-a" });
    expect(active).toHaveLength(1);
  });

  it("stores the SAME fact text under TWO accounts (account-scoped dedup, not global)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
    // Two accounts assert the same content_hash — both must persist (the UNIQUE
    // index is (owner_id, content_hash), never global).
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-a", contentHash: "shared-hash", factText: "the sky is blue" })],
    });
    await store.insertFactsReconciled({
      accountId: "acct-b",
      scope: {},
      now,
      facts: [fact({ ownerId: "acct-b", contentHash: "shared-hash", factText: "the sky is blue" })],
    });

    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(1);
    expect(await store.listActiveFacts({ accountId: "acct-b" })).toHaveLength(1);
  });

  it("supersedes an OLDER same-(owner_id, subject_key) fact: stamps expired_at=now + invalid_at=new.valid_from, never deletes", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store, db } = newStore(now);
    const oldValidFrom = new Date("2026-05-01T00:00:00.000Z");
    const newValidFrom = new Date("2026-06-01T00:00:00.000Z");

    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "deploy-region",
          contentHash: "old",
          factText: "deploys to us-east",
          validFrom: oldValidFrom,
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
          contentHash: "new",
          factText: "deploys to eu-west",
          validFrom: newValidFrom,
        }),
      ],
    });

    const rows = rawFacts(db);
    // Both rows still PRESENT — supersede never deletes (audit-friendly).
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.content_hash === "old");
    const fresh = rows.find((r) => r.content_hash === "new");
    expect(old?.status).toBe("active"); // status is NOT flipped by supersede — expired_at is the visibility gate
    expect(old?.expired_at).toBe(now.getTime());
    expect(old?.invalid_at).toBe(newValidFrom.getTime());
    expect(fresh?.expired_at).toBeNull();

    // Only the fresh fact is alive (expired_at IS NULL filter).
    const active = await store.listActiveFacts({ accountId: "acct-a" });
    expect(active).toHaveLength(1);
    expect(active[0]?.contentHash).toBe("new");
  });

  it("does NOT supersede across different subject_keys or different accounts", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
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
    // Different subject_key for acct-a, and a same-subject fact for acct-b — neither supersedes the first.
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "deploy-region",
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

    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(2); // both still active
    expect(await store.listActiveFacts({ accountId: "acct-b" })).toHaveLength(1);
  });

  it("does NOT supersede a NEWER existing fact when the incoming fact is older (valid_from gate)", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
    // Existing fact has the NEWER valid_from; an incoming older fact must NOT expire it.
    await store.insertFactsReconciled({
      accountId: "acct-a",
      scope: {},
      now,
      facts: [
        fact({
          ownerId: "acct-a",
          subjectKey: "region",
          contentHash: "newer",
          validFrom: new Date("2026-06-01T00:00:00.000Z"),
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
          contentHash: "older",
          validFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
      ],
    });

    const active = await store.listActiveFacts({ accountId: "acct-a" });
    // Both remain active — only an OLDER existing row gets superseded by a newer arrival.
    expect(active.map((f) => f.contentHash).sort()).toEqual(["newer", "older"]);
  });

  it("listActiveFacts filters by owner_id and the in-account scope columns", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const { store } = newStore(now);
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
    // No scope filter → both of the account's facts.
    expect(await store.listActiveFacts({ accountId: "acct-a" })).toHaveLength(2);
  });
});
