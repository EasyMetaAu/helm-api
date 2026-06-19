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

  it("by-key resolves to account + default project, 404 when unknown", async () => {
    const { store } = seededStore();
    const keyRow = {
      key_id: "k1",
      account_id: "acct",
      memory_project_id: "proj-x",
    } as unknown as ApiKeyRecord;
    const app = buildApp(store, [keyRow]);
    const ok = (await (await app.request("/admin/api/memory/by-key/k1")).json()) as {
      accountId: string;
      projectId: string | null;
    };
    expect(ok).toMatchObject({ accountId: "acct", projectId: "proj-x" });
    expect((await app.request("/admin/api/memory/by-key/missing")).status).toBe(404);
  });
});
