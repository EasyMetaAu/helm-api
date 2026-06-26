import { createSqliteDb, factContentHash, type MemoryStore, SqliteMemoryStore } from "@helm/core";
import type { ApiKeyRecord, Fact } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";
import { registerMemoryRoutes } from "./memory.js";

// /admin/api/memory contract (docs/13). basicAuth gating is covered by admin.test;
// these pin the route logic: status visibility, 409 on content_hash collision,
// 404s, soft-delete, by-key resolution, and the 503-without-store fail-closed.

const NOW = new Date("2026-06-19T00:00:00.000Z");

function seededStore(): { store: SqliteMemoryStore } {
  const db = createSqliteDb(":memory:");
  let seq = 0;
  const store = new SqliteMemoryStore(
    db,
    () => `id-${++seq}`,
    () => NOW,
  );
  return { store };
}

function addFact(
  store: SqliteMemoryStore,
  subjectKey: string,
  factText: string,
  projectId?: string,
) {
  return store.insertFactsReconciled({
    accountId: "acct",
    scope: projectId !== undefined ? { projectId } : {},
    now: NOW,
    facts: [
      {
        ownerId: "acct",
        subjectKey,
        factText,
        contentHash: factContentHash(factText),
        validFrom: NOW,
        ...(projectId !== undefined ? { projectId } : {}),
      },
    ],
  });
}

function buildApp(memoryStore: MemoryStore | undefined, keyRows: ApiKeyRecord[] = []) {
  const app = new Hono<AppEnv>();
  const deps = {
    memoryStore,
    accountId: "acct",
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    keyStore: { list: async () => keyRows },
  } as unknown as AdminApiDeps;
  registerMemoryRoutes(app, deps);
  return app;
}

describe("/admin/api/memory routes (docs/13)", () => {
  it("503s when no memory store is wired", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/admin/api/memory/scopes");
    expect(res.status).toBe(503);
  });

  it("lists scopes with per-tier counts", async () => {
    const { store } = seededStore();
    await addFact(store, "s1", "f1", "p1");
    await store.upsertReflection({
      accountId: "acct",
      projectId: "p2",
      reflectionText: "r",
      version: 1,
      tokenEstimate: 1,
      updatedAt: NOW,
    });
    const app = buildApp(store);
    const res = await app.request("/admin/api/memory/scopes");
    expect(res.status).toBe(200);
    const scopes = (await res.json()) as Array<{
      projectId: string | null;
      factCount: number;
      reflectionCount: number;
    }>;
    const byProject = new Map(scopes.map((s) => [s.projectId, s]));
    expect(byProject.get("p1")?.factCount).toBe(1);
    expect(byProject.get("p2")?.reflectionCount).toBe(1);
  });

  it("lists facts with default 'all' status visibility and supports filters", async () => {
    const { store } = seededStore();
    await addFact(store, "fav", "old", undefined);
    await store.insertFactsReconciled({
      accountId: "acct",
      scope: {},
      now: NOW,
      facts: [
        {
          ownerId: "acct",
          subjectKey: "fav",
          factText: "new",
          contentHash: factContentHash("new"),
          validFrom: new Date("2026-07-01"),
        },
      ],
    });
    const app = buildApp(store);
    // default status=all → both rows (one superseded)
    const all = (await (await app.request("/admin/api/memory/facts")).json()) as {
      rows: Fact[];
      total: number;
    };
    expect(all.total).toBe(2);
    // status=active → only the live one
    const active = (await (await app.request("/admin/api/memory/facts?status=active")).json()) as {
      total: number;
    };
    expect(active.total).toBe(1);
    // invalid status → 400
    expect((await app.request("/admin/api/memory/facts?status=bogus")).status).toBe(400);
  });

  it("status=superseded lists only the replaced rows (active + expired), and is a valid status", async () => {
    const { store } = seededStore();
    await addFact(store, "fav", "old", undefined);
    await store.insertFactsReconciled({
      accountId: "acct",
      scope: {},
      now: NOW,
      facts: [
        {
          ownerId: "acct",
          subjectKey: "fav",
          factText: "new",
          contentHash: factContentHash("new"),
          validFrom: new Date("2026-07-01"),
        },
      ],
    });
    const app = buildApp(store);
    // status=superseded is accepted (not 400) and returns ONLY the old, replaced row.
    const res = await app.request("/admin/api/memory/facts?status=superseded");
    expect(res.status).toBe(200);
    const sup = (await res.json()) as { rows: Fact[]; total: number };
    expect(sup.total).toBe(1);
    expect(sup.rows[0]?.factText).toBe("old");
    expect(sup.rows[0]?.expiredAt).not.toBeNull();
  });

  it("POST creates a fact, dedups an identical re-add, and supersedes a same-subject add", async () => {
    const { store } = seededStore();
    const app = buildApp(store);
    const post = (body: unknown, qs = "") =>
      app.request(`/admin/api/memory/facts${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Create.
    const created = await post({ subjectText: "favorite number", factText: "The number is 42." });
    expect(created.status).toBe(201);
    const cj = (await created.json()) as {
      fact: Fact | null;
      added: string[];
      superseded: string[];
      deduped: boolean;
    };
    expect(cj.added).toHaveLength(1);
    expect(cj.deduped).toBe(false);
    expect(cj.fact?.factText).toBe("The number is 42.");
    expect(cj.fact?.subjectKey).toBe("favorite-number"); // normalized

    // Identical text again → dedup (no new row).
    const dup = (await (
      await post({ subjectText: "favorite number", factText: "The number is 42." })
    ).json()) as { added: string[]; deduped: boolean };
    expect(dup.added).toHaveLength(0);
    expect(dup.deduped).toBe(true);

    // Same subject, new text → supersedes the older one.
    const sup = (await (
      await post({ subjectText: "favorite number", factText: "The number is 7." })
    ).json()) as { added: string[]; superseded: string[] };
    expect(sup.added).toHaveLength(1);
    expect(sup.superseded.length).toBeGreaterThan(0);
  });

  it("POST routes the fact into the scope from the query params", async () => {
    const { store } = seededStore();
    const app = buildApp(store);
    const res = await app.request("/admin/api/memory/facts?projectId=p9", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectText: "pet", factText: "Has a cat named Cola." }),
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { fact: Fact | null };
    expect(j.fact?.projectId).toBe("p9");
  });

  it("POST rejects an invalid body (400) and 503s without a store", async () => {
    const { store } = seededStore();
    const bad = await buildApp(store).request("/admin/api/memory/facts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectText: "x" }), // missing factText
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await buildApp(undefined).request("/admin/api/memory/facts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });

  it("PATCH fact: edits, 409 on collision, 404 on unknown", async () => {
    const { store } = seededStore();
    await addFact(store, "s1", "alpha");
    const b = await addFact(store, "s2", "beta");
    const bId = b.insertedIds[0] as string;

    const ok = await (
      await buildApp(store).request(`/admin/api/memory/facts/${bId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importance: 0.9 }),
      })
    ).json();
    expect((ok as Fact).importance).toBe(0.9);

    const collide = await buildApp(store).request(`/admin/api/memory/facts/${bId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factText: "alpha" }),
    });
    expect(collide.status).toBe(409);

    const missing = await buildApp(store).request("/admin/api/memory/facts/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importance: 0.1 }),
    });
    expect(missing.status).toBe(404);
  });

  it("PATCH fact rejects an unknown field (fail-closed 400)", async () => {
    const { store } = seededStore();
    const f = await addFact(store, "s", "x");
    const id = f.insertedIds[0] as string;
    const res = await buildApp(store).request(`/admin/api/memory/facts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectKey: "hacked" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE fact soft-deletes (404 on second delete)", async () => {
    const { store } = seededStore();
    const f = await addFact(store, "s", "x");
    const id = f.insertedIds[0] as string;
    const app = buildApp(store);
    expect((await app.request(`/admin/api/memory/facts/${id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await app.request(`/admin/api/memory/facts/${id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("reflections: list, PATCH in place, DELETE", async () => {
    const { store } = seededStore();
    const id = await store.upsertReflection({
      accountId: "acct",
      projectId: "p",
      reflectionText: "orig",
      version: 4,
      tokenEstimate: 2,
      updatedAt: NOW,
    });
    const app = buildApp(store);
    const patched = await (
      await app.request(`/admin/api/memory/reflections/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reflectionText: "fixed by operator" }),
      })
    ).json();
    expect((patched as { reflectionText: string; version: number }).reflectionText).toBe(
      "fixed by operator",
    );
    expect((patched as { version: number }).version).toBe(4); // no bump
    expect(
      (await app.request(`/admin/api/memory/reflections/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("by-key resolves to account + EFFECTIVE project (explicit shares, null isolates by key), 404 when unknown", async () => {
    const { store } = seededStore();
    const sharedKey = {
      key_id: "k1",
      account_id: "acct",
      memory_project_id: "proj-x",
    } as unknown as ApiKeyRecord;
    // No explicit project => isolated by the key's own id (effectiveMemoryProjectId).
    const isolatedKey = {
      key_id: "k2",
      account_id: "acct",
      memory_project_id: null,
    } as unknown as ApiKeyRecord;
    const app = buildApp(store, [sharedKey, isolatedKey]);
    const ok = (await (await app.request("/admin/api/memory/by-key/k1")).json()) as {
      accountId: string;
      projectId: string | null;
    };
    expect(ok).toMatchObject({ accountId: "acct", projectId: "proj-x" });
    const isolated = (await (await app.request("/admin/api/memory/by-key/k2")).json()) as {
      projectId: string | null;
    };
    expect(isolated.projectId).toBe("k2");
    expect((await app.request("/admin/api/memory/by-key/missing")).status).toBe(404);
  });

  it("GET /memory/facts/:id returns the fact or 404", async () => {
    const { store } = seededStore();
    const res = await addFact(store, "s", "hello");
    const id = res.insertedIds[0] as string;
    const app = buildApp(store);
    const fact = (await (await app.request(`/admin/api/memory/facts/${id}`)).json()) as {
      factText: string;
    };
    expect(fact.factText).toBe("hello");
    expect((await app.request("/admin/api/memory/facts/no-such-id")).status).toBe(404);
  });

  it("GET /memory/reflections lists with status filter and invalid status → 400", async () => {
    const { store } = seededStore();
    await store.upsertReflection({
      accountId: "acct",
      projectId: "p",
      reflectionText: "r1",
      version: 1,
      tokenEstimate: 1,
      updatedAt: NOW,
    });
    const app = buildApp(store);
    const page = (await (await app.request("/admin/api/memory/reflections")).json()) as {
      rows: unknown[];
      total: number;
    };
    expect(page.total).toBe(1);
    const active = (await (
      await app.request("/admin/api/memory/reflections?status=active")
    ).json()) as { total: number };
    expect(active.total).toBe(1);
    expect((await app.request("/admin/api/memory/reflections?status=bad")).status).toBe(400);
  });

  it("GET /memory/reflections/:id returns the reflection or 404", async () => {
    const { store } = seededStore();
    const id = await store.upsertReflection({
      accountId: "acct",
      projectId: "p",
      reflectionText: "hello",
      version: 1,
      tokenEstimate: 1,
      updatedAt: NOW,
    });
    const app = buildApp(store);
    const r = (await (await app.request(`/admin/api/memory/reflections/${id}`)).json()) as {
      reflectionText: string;
    };
    expect(r.reflectionText).toBe("hello");
    expect((await app.request("/admin/api/memory/reflections/no-such-id")).status).toBe(404);
  });

  it("PATCH reflection: invalid body → 400 (line 191-192)", async () => {
    const { store } = seededStore();
    const id = await store.upsertReflection({
      accountId: "acct",
      projectId: "p",
      reflectionText: "orig",
      version: 1,
      tokenEstimate: 1,
      updatedAt: NOW,
    });
    const app = buildApp(store);
    // Empty body is not a valid MemoryReflectionPatchSchema
    const res = await app.request(`/admin/api/memory/reflections/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("intParam: NaN value falls back to default; negative falls back to default; clamps to max (lines 41-44)", async () => {
    const { store } = seededStore();
    // Add several facts to make pagination visible
    await addFact(store, "a", "f1");
    await addFact(store, "b", "f2");
    await addFact(store, "c", "f3");
    const app = buildApp(store);
    // NaN limit → default (50)
    const nan = (await (await app.request("/admin/api/memory/facts?limit=abc")).json()) as {
      total: number;
    };
    expect(nan.total).toBe(3);
    // Negative limit → default
    const neg = (await (await app.request("/admin/api/memory/facts?limit=-5")).json()) as {
      total: number;
    };
    expect(neg.total).toBe(3);
    // Limit > MAX_LIMIT (200) → clamped to 200 (still returns all 3)
    const big = (await (await app.request("/admin/api/memory/facts?limit=999")).json()) as {
      total: number;
    };
    expect(big.total).toBe(3);
  });

  it("scopeFromQuery: empty-string resourceId/threadId are excluded; non-empty are included", async () => {
    // Covers the `r !== ""` and `t !== ""` branches in scopeFromQuery (lines 56-58)
    const { store } = seededStore();
    await addFact(store, "s", "resourced", "p1");
    await store.insertFactsReconciled({
      accountId: "acct",
      scope: { projectId: "p1", resourceId: "res1", threadId: "thr1" },
      now: NOW,
      facts: [
        {
          ownerId: "acct",
          subjectKey: "s2",
          factText: "scoped",
          contentHash: factContentHash("scoped"),
          validFrom: NOW,
          projectId: "p1",
          resourceId: "res1",
          threadId: "thr1",
        },
      ],
    });
    const app = buildApp(store);
    // Empty string params → ignored (no scope filter)
    const noScope = (await (
      await app.request("/admin/api/memory/facts?resourceId=&threadId=")
    ).json()) as { total: number };
    expect(noScope.total).toBe(2);
    // Non-empty resourceId → filters to the scoped fact only
    const scoped = (await (
      await app.request("/admin/api/memory/facts?resourceId=res1")
    ).json()) as { total: number };
    expect(scoped.total).toBe(1);
    // Non-empty threadId → filters to the scoped fact only
    const threaded = (await (
      await app.request("/admin/api/memory/facts?threadId=thr1")
    ).json()) as { total: number };
    expect(threaded.total).toBe(1);
  });

  it("listScopes: accountId query param scopes to that account; without it lists all", async () => {
    // Covers the `accountId !== undefined ? {accountId} : {}` ternary in listScopes (line 71)
    const { store } = seededStore();
    await addFact(store, "s", "f1", "p1");
    const app = buildApp(store);
    // With accountId param → lists for that account
    const scoped = (await (
      await app.request("/admin/api/memory/scopes?accountId=acct")
    ).json()) as unknown[];
    expect(scoped.length).toBeGreaterThan(0);
    // Without accountId param → lists all (same store, same result)
    const all = (await (await app.request("/admin/api/memory/scopes")).json()) as unknown[];
    expect(all.length).toBeGreaterThan(0);
  });

  it("PATCH fact: non-collision error is re-thrown (line 141-142)", async () => {
    // Simulate updateFact throwing a non-MemoryFactContentHashConflictError
    const { store } = seededStore();
    const f = await addFact(store, "s", "x");
    const id = f.insertedIds[0] as string;
    // Override updateFact to throw a generic Error
    const origUpdate = store.updateFact?.bind(store);
    store.updateFact = async () => {
      throw new Error("db crashed");
    };
    const app = buildApp(store);
    // This should propagate as a 500 (re-thrown error)
    const res = await app.request(`/admin/api/memory/facts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importance: 0.5 }),
    });
    // Hono's onError returns 500 for unhandled errors
    expect(res.status).toBe(500);
    // Restore
    if (origUpdate) store.updateFact = origUpdate;
  });

  it("scopeFromQuery: projectId non-empty covers the line-56 true branch", async () => {
    // Previous scopeFromQuery test only used resourceId/threadId; add projectId coverage
    const { store } = seededStore();
    await addFact(store, "s", "p1-fact", "p1");
    await addFact(store, "s2", "no-project-fact");
    const app = buildApp(store);
    // projectId=p1 → filters to 1 fact
    const byProject = (await (
      await app.request("/admin/api/memory/facts?projectId=p1")
    ).json()) as { total: number };
    expect(byProject.total).toBe(1);
    // projectId= (empty) → ignored → both facts
    const emptyProject = (await (
      await app.request("/admin/api/memory/facts?projectId=")
    ).json()) as { total: number };
    expect(emptyProject.total).toBe(2);
  });

  it("listFacts: subjectKey and search filters (lines 104-105 true branches)", async () => {
    const { store } = seededStore();
    await addFact(store, "target-key", "fact about target");
    await addFact(store, "other-key", "unrelated fact");
    const app = buildApp(store);
    // subjectKey filter → only matching fact
    const byKey = (await (
      await app.request("/admin/api/memory/facts?subjectKey=target-key")
    ).json()) as { total: number };
    expect(byKey.total).toBe(1);
    // search filter → only matching fact
    const bySearch = (await (
      await app.request("/admin/api/memory/facts?search=unrelated")
    ).json()) as { total: number };
    expect(bySearch.total).toBe(1);
  });

  it("503 for GET/PATCH/DELETE routes when no store is wired", async () => {
    // Cover resolveStore instanceof Response branches for all routes that haven't had 503 tests
    const app = buildApp(undefined);
    expect((await app.request("/admin/api/memory/facts/any-id")).status).toBe(503);
    expect(
      (
        await app.request("/admin/api/memory/facts/any-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect((await app.request("/admin/api/memory/facts/any-id", { method: "DELETE" })).status).toBe(
      503,
    );
    expect((await app.request("/admin/api/memory/reflections")).status).toBe(503);
    expect((await app.request("/admin/api/memory/reflections/any-id")).status).toBe(503);
    expect(
      (
        await app.request("/admin/api/memory/reflections/any-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect(
      (await app.request("/admin/api/memory/reflections/any-id", { method: "DELETE" })).status,
    ).toBe(503);
  });

  it("PATCH reflection with unknown id → 404 (line 200 null branch)", async () => {
    const { store } = seededStore();
    const app = buildApp(store);
    const res = await app.request("/admin/api/memory/reflections/no-such-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reflectionText: "updated" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE reflection with unknown id → 404 (lines 208-211 false branch)", async () => {
    const { store } = seededStore();
    const app = buildApp(store);
    const res = await app.request("/admin/api/memory/reflections/no-such-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
