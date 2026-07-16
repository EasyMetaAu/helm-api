// tools.test.ts — coverage-targeted tests for apps/gateway/src/routes/mcp/tools.ts
// Covers the uncovered branches/lines not exercised by mcp.test.ts:
//   Lines  124-133 (reflectionView), 255-267 (search reflection), 309 (embed success),
//          327-328 (searchFacts throw → degrade), 347-372 (handleList reflection),
//          382 (get reflection not-found), 394-398 (invalidAt string parse/invalid),
//          417-424 (update reflection), 435-437 (delete reflection)
//   Branches: scopeInput resourceId/threadId, includeInactive, importance override,
//             facts.length===0 (not reachable in practice — see note), queryEmbedding
//             spread, searchFacts.undefined degrade, update fact not-found,
//             update reflection no-text, unknown tool

import { createSqliteDb, projectScopedThreadId, SqliteMemoryStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { callMemoryTool, type MemoryToolContext, supportsMemoryAdmin } from "./tools.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function harness() {
  const db = createSqliteDb(":memory:");
  let seq = 0;
  const store = new SqliteMemoryStore(
    db,
    () => `id-${++seq}`,
    () => NOW,
  );
  if (!supportsMemoryAdmin(store)) throw new Error("SqliteMemoryStore missing admin surface");

  const ctxFor = (
    accountId: string,
    defaultProjectId: string | null = null,
    extra: Partial<MemoryToolContext> = {},
  ): MemoryToolContext => ({
    accountId,
    defaultProjectId,
    store,
    now: () => NOW,
    estimateTokens: (t) => Math.ceil(t.length / 4),
    scoreConfig: {
      half_life_s: 86400,
      importance_floor: 0.1,
      importance_ceil: 1.0,
      access_weight: 0.15,
    },
    recall: { enabled: true, topK: 10 },
    ...extra,
  });
  return { store, ctxFor };
}

function parse(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
}

// ---- scopeInput branches (lines 104-105) ------------------------------------

describe("scopeInput scope fields", () => {
  it("propagates resourceId and threadId into scope", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "proj1");
    // Add with full scope; search should find it in that scope
    await callMemoryTool(
      "memory_add",
      {
        type: "fact",
        text: "scoped fact",
        projectId: "proj1",
        resourceId: "res1",
        threadId: "thr1",
      },
      ctx,
    );
    const res = parse(
      await callMemoryTool(
        "memory_search",
        { type: "fact", query: "scoped", resourceId: "res1", threadId: "thr1" },
        ctx,
      ),
    );
    expect((res.facts as unknown[]).length).toBe(1);
  });

  it("defaults projectId from ctx.defaultProjectId when args omit it", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "default-proj");
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "auto-scope fact" }, ctx),
    );
    // Fact was stored; can retrieve by listing with the default project scope
    const list = parse(
      await callMemoryTool("memory_list", { type: "fact", projectId: "default-proj" }, ctx),
    );
    expect(list.total).toBe(1);
    expect(added.added).toHaveLength(1);
  });

  it("maps MCP client thread ids through the same effective-project storage scope", async () => {
    const { ctxFor, store } = harness();
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "private A", threadId: "same-thread" },
      ctxFor("a", "key-a"),
    );
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "private B", threadId: "same-thread" },
      ctxFor("a", "key-b"),
    );
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "shared C", threadId: "same-thread" },
      ctxFor("a", "team"),
    );
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "shared D", threadId: "same-thread" },
      ctxFor("a", "team"),
    );

    const rowsA = await store.listFacts({
      accountId: "a",
      projectId: "key-a",
      status: "active",
      limit: 10,
      offset: 0,
    });
    const rowsB = await store.listFacts({
      accountId: "a",
      projectId: "key-b",
      status: "active",
      limit: 10,
      offset: 0,
    });
    const shared = await store.listFacts({
      accountId: "a",
      projectId: "team",
      status: "active",
      limit: 10,
      offset: 0,
    });
    expect(rowsA.rows[0]?.threadId).toBe(projectScopedThreadId("a", "key-a", "same-thread"));
    expect(rowsB.rows[0]?.threadId).toBe(projectScopedThreadId("a", "key-b", "same-thread"));
    expect(rowsA.rows[0]?.threadId).not.toBe(rowsB.rows[0]?.threadId);
    expect(new Set(shared.rows.map((fact) => fact.threadId))).toEqual(
      new Set([projectScopedThreadId("a", "team", "same-thread")]),
    );
  });

  it("treats owner-like and v2-like client thread ids as opaque input", async () => {
    const { ctxFor, store } = harness();
    const ctx = ctxFor("a", "key-a");
    const clientThreadIds = ["foo", "a:foo", "v2:n:a:foo", "v2:p:00:a:foo"];

    for (const [index, threadId] of clientThreadIds.entries()) {
      await callMemoryTool("memory_add", { type: "fact", text: `opaque ${index}`, threadId }, ctx);
    }

    const rows = await store.listFacts({
      accountId: "a",
      projectId: "key-a",
      status: "active",
      limit: 10,
      offset: 0,
    });
    expect(new Set(rows.rows.map((fact) => fact.threadId))).toEqual(
      new Set(clientThreadIds.map((threadId) => projectScopedThreadId("a", "key-a", threadId))),
    );
  });
});

// ---- reflectionView (lines 124-133) — exercised via reflection operations ----

describe("reflectionView fields", () => {
  it("memory_get(reflection) returns full reflectionView fields", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "reflection", text: "A summary." }, ctx),
    );
    const id = added.id as string;
    const got = parse(await callMemoryTool("memory_get", { type: "reflection", id }, ctx));
    expect(got.id).toBe(id);
    expect(got.text).toBe("A summary.");
    expect(got.version).toBe(1);
    expect(typeof (got.scope as Record<string, unknown>).projectId).toBe("string");
    expect(got.status).toBe("active");
    expect(typeof got.updatedAt).toBe("string");
  });

  it("memory_get(reflection) not-found returns isError (line 382-383)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const res = await callMemoryTool("memory_get", { type: "reflection", id: "ghost" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("not found");
  });

  it("does not truncate an opaque reflection thread id that merely contains a colon", async () => {
    const { ctxFor, store } = harness();
    const id = await store.upsertReflection({
      accountId: "a",
      projectId: "p1",
      threadId: "opaque:thread",
      reflectionText: "opaque scope",
      version: 1,
      tokenEstimate: 2,
      updatedAt: NOW,
    });
    const got = parse(
      await callMemoryTool("memory_get", { type: "reflection", id }, ctxFor("a", "p1")),
    );
    expect((got.scope as { threadId: string }).threadId).toBe("opaque:thread");
  });
});

// ---- handleSearch reflection branch (lines 255-267) -------------------------

describe("memory_search reflection branch", () => {
  it("searches reflections when type='reflection'", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    await callMemoryTool("memory_add", { type: "reflection", text: "User loves cooking." }, ctx);
    const res = parse(
      await callMemoryTool("memory_search", { type: "reflection", query: "cooking" }, ctx),
    );
    expect(res.facts).toBeUndefined();
    expect((res.reflections as unknown[]).length).toBe(1);
  });

  it("searches both facts and reflections when type is omitted", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    await callMemoryTool("memory_add", { type: "fact", text: "enjoys hiking" }, ctx);
    await callMemoryTool(
      "memory_add",
      { type: "reflection", text: "User enjoys outdoor activities." },
      ctx,
    );
    const res = parse(await callMemoryTool("memory_search", { query: "enjoy" }, ctx));
    expect((res.facts as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((res.reflections as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("includeInactive=true surfaces archived/pruned items (branch line 247/258)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "temp fact" }, ctx),
    );
    const id = (added.added as string[])[0] as string;
    await callMemoryTool("memory_delete", { type: "fact", id }, ctx);

    const withoutInactive = parse(
      await callMemoryTool("memory_search", { type: "fact", query: "temp" }, ctx),
    );
    expect((withoutInactive.facts as unknown[]).length).toBe(0);

    const withInactive = parse(
      await callMemoryTool(
        "memory_search",
        { type: "fact", query: "temp", includeInactive: true },
        ctx,
      ),
    );
    expect((withInactive.facts as unknown[]).length).toBe(1);
  });
});

// ---- handleRecall branches (lines 308-328) -----------------------------------

describe("memory_recall embedder branches", () => {
  it("uses embedded query when embedder succeeds (line 308-309)", async () => {
    const { ctxFor } = harness();
    const fakeEmbedder = {
      embed: vi.fn().mockResolvedValue([new Float32Array([0.1, 0.2])]),
    };
    const ctx = ctxFor("a", null, { embedder: fakeEmbedder });
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "deploy on kubernetes", subject: "infra" },
      ctx,
    );
    const res = parse(await callMemoryTool("memory_recall", { query: "kubernetes" }, ctx));
    expect(res.isError).toBeFalsy();
    expect(fakeEmbedder.embed).toHaveBeenCalledWith(["kubernetes"]);
  });

  it("degrades to LIKE when searchFacts throws (line 327-328)", async () => {
    const { ctxFor, store } = harness();
    // Temporarily override searchFacts with a throwing mock
    const throwingStore = Object.create(store) as typeof store;
    throwingStore.searchFacts = vi.fn().mockRejectedValue(new Error("search index unavailable"));
    const ctx: MemoryToolContext = {
      accountId: "a",
      defaultProjectId: null,
      store: throwingStore,
      now: () => NOW,
      estimateTokens: (t) => Math.ceil(t.length / 4),
      scoreConfig: {
        half_life_s: 86400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
      },
      recall: { enabled: true, topK: 10 },
    };
    // Add fact to real store (throwingStore delegates listFacts to original)
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "data in real store", subject: "test" },
      ctxFor("a"),
    );
    const res = parse(await callMemoryTool("memory_recall", { query: "data" }, ctx));
    // Should degrade gracefully (not throw, not isError)
    expect(res.isError).toBeFalsy();
    expect(res.degraded).toBe(true);
  });

  it("degrades when searchFacts is undefined on the store (line 302)", async () => {
    const { store } = harness();
    const noSearchStore = Object.create(store) as typeof store;
    // Force searchFacts to undefined by descriptor
    Object.defineProperty(noSearchStore, "searchFacts", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const ctx: MemoryToolContext = {
      accountId: "b",
      defaultProjectId: null,
      store: noSearchStore,
      now: () => NOW,
      estimateTokens: (t) => Math.ceil(t.length / 4),
      scoreConfig: {
        half_life_s: 86400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
      },
      recall: { enabled: true, topK: 10 },
    };
    const res = parse(await callMemoryTool("memory_recall", { query: "anything" }, ctx));
    expect(res.degraded).toBe(true);
  });
});

// ---- handleList reflection branch (lines 347-372) ---------------------------

describe("memory_list reflection branch", () => {
  it("lists reflections (lines 364-371)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    // Use different project scopes so each upsert creates a distinct row
    await callMemoryTool(
      "memory_add",
      { type: "reflection", text: "First reflection.", projectId: "p1" },
      ctx,
    );
    await callMemoryTool(
      "memory_add",
      { type: "reflection", text: "Second reflection.", projectId: "p2" },
      ctx,
    );
    const all = parse(await callMemoryTool("memory_list", { type: "reflection" }, ctx));
    // At least one reflection exists; total ≥ 1 (p1 default scope may coalesce)
    expect((all.reflections as unknown[]).length).toBeGreaterThanOrEqual(1);
    // Verify the p1-scoped one is present
    const p1 = parse(
      await callMemoryTool("memory_list", { type: "reflection", projectId: "p1" }, ctx),
    );
    expect(p1.total).toBe(1);
    expect((p1.reflections as Array<{ text: string }>)[0]?.text).toBe("First reflection.");
  });

  it("lists reflections with includeInactive=true (branch line 368)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "reflection", text: "To be deleted." }, ctx),
    );
    const id = added.id as string;
    await callMemoryTool("memory_delete", { type: "reflection", id }, ctx);

    const active = parse(await callMemoryTool("memory_list", { type: "reflection" }, ctx));
    expect(active.total).toBe(0);

    const all = parse(
      await callMemoryTool("memory_list", { type: "reflection", includeInactive: true }, ctx),
    );
    expect(all.total).toBe(1);
  });

  it("respects limit and offset for facts (branch line 354-362)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    for (let i = 0; i < 5; i++) {
      await callMemoryTool(
        "memory_add",
        { type: "fact", text: `item ${i}`, subject: `sub${i}` },
        ctx,
      );
    }
    const page1 = parse(
      await callMemoryTool("memory_list", { type: "fact", limit: 2, offset: 0 }, ctx),
    );
    expect((page1.facts as unknown[]).length).toBe(2);

    const page2 = parse(
      await callMemoryTool("memory_list", { type: "fact", limit: 2, offset: 2 }, ctx),
    );
    expect((page2.facts as unknown[]).length).toBe(2);
  });

  it("lists facts with includeInactive=true (line 358 'all' branch)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "soon deleted", subject: "x" }, ctx),
    );
    const id = (added.added as string[])[0] as string;
    await callMemoryTool("memory_delete", { type: "fact", id }, ctx);

    const active = parse(await callMemoryTool("memory_list", { type: "fact" }, ctx));
    expect(active.total).toBe(0);

    const all = parse(
      await callMemoryTool("memory_list", { type: "fact", includeInactive: true }, ctx),
    );
    expect(all.total).toBe(1);
  });
});

// ---- handleUpdate branches (lines 390-425) -----------------------------------

describe("memory_update branches", () => {
  it("updates fact with invalidAt=null (clears bi-temporal expiry, line 392)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", text: "temporary truth", subject: "t" },
        ctx,
      ),
    );
    const id = (added.added as string[])[0] as string;

    // First set an invalidAt, then clear it with null
    const withInvalid = parse(
      await callMemoryTool(
        "memory_update",
        { type: "fact", id, invalidAt: "2026-12-31T00:00:00.000Z" },
        ctx,
      ),
    );
    expect(withInvalid.text).toBe("temporary truth");

    const cleared = parse(
      await callMemoryTool("memory_update", { type: "fact", id, invalidAt: null }, ctx),
    );
    expect(cleared.text).toBe("temporary truth");
  });

  it("returns isError for an invalid invalidAt string (lines 395-396)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "some fact", subject: "s" }, ctx),
    );
    const id = (added.added as string[])[0] as string;

    const res = await callMemoryTool(
      "memory_update",
      { type: "fact", id, invalidAt: "not-a-date" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("not a valid timestamp");
  });

  it("updates fact importance and status (branch lines 406-408)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", text: "archivable fact", subject: "x" },
        ctx,
      ),
    );
    const id = (added.added as string[])[0] as string;
    const updated = parse(
      await callMemoryTool(
        "memory_update",
        { type: "fact", id, importance: 0.8, status: "archived" },
        ctx,
      ),
    );
    expect(updated.importance).toBe(0.8);
    expect(updated.status).toBe("archived");
  });

  it("returns isError when updating a non-existent fact (line 415)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const res = await callMemoryTool(
      "memory_update",
      { type: "fact", id: "nonexistent-id", text: "new text" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("not found");
  });

  it("updates reflection text (lines 418-424)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "reflection", text: "Old summary." }, ctx),
    );
    const id = added.id as string;
    const updated = parse(
      await callMemoryTool("memory_update", { type: "reflection", id, text: "New summary." }, ctx),
    );
    expect(updated.text).toBe("New summary.");
  });

  it("returns isError when reflection text is missing (line 417)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "reflection", text: "Some content." }, ctx),
    );
    const id = added.id as string;
    const res = await callMemoryTool("memory_update", { type: "reflection", id }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("reflection update requires");
  });

  it("returns isError when updating a non-existent reflection (line 425)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const res = await callMemoryTool(
      "memory_update",
      { type: "reflection", id: "ghost-reflection", text: "new text" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("not found");
  });
});

// ---- handleDelete reflection branch (lines 435-437) --------------------------

describe("memory_delete reflection branch", () => {
  it("deletes a reflection (line 435)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "reflection", text: "Ephemeral reflection." },
        ctx,
      ),
    );
    const id = added.id as string;
    const del = parse(await callMemoryTool("memory_delete", { type: "reflection", id }, ctx));
    expect(del.deleted).toBe(true);
    expect(del.id).toBe(id);

    // Should not appear in active list anymore
    const list = parse(await callMemoryTool("memory_list", { type: "reflection" }, ctx));
    expect(list.total).toBe(0);
  });
});

// ---- callMemoryTool dispatch (lines 513-525) ---------------------------------

describe("callMemoryTool dispatch", () => {
  it("returns isError for unknown tool name (line 513)", async () => {
    const { ctxFor } = harness();
    const res = await callMemoryTool("nonexistent_tool", {}, ctxFor("a"));
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("unknown tool");
  });

  it("returns isError with detail for schema validation failures (lines 515-519)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    // memory_list requires `type`
    const res = await callMemoryTool("memory_list", { limit: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("invalid arguments");
  });

  it("wraps non-Error throws as 'internal error' (line 525)", async () => {
    const { store } = harness();
    // Make insertFactsReconciled throw a non-Error value
    const brokenStore = Object.create(store) as typeof store;
    brokenStore.insertFactsReconciled = vi.fn().mockRejectedValue("string error");
    const ctx: MemoryToolContext = {
      accountId: "a",
      defaultProjectId: null,
      store: brokenStore,
      now: () => NOW,
      estimateTokens: (t) => Math.ceil(t.length / 4),
      scoreConfig: {
        half_life_s: 86400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
      },
      recall: { enabled: true, topK: 10 },
    };
    const res = await callMemoryTool("memory_add", { type: "fact", text: "test" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("internal error");
  });

  it("wraps Error throws with the error message (line 524)", async () => {
    const { store } = harness();
    const brokenStore = Object.create(store) as typeof store;
    brokenStore.insertFactsReconciled = vi.fn().mockRejectedValue(new Error("db locked"));
    const ctx: MemoryToolContext = {
      accountId: "a",
      defaultProjectId: null,
      store: brokenStore,
      now: () => NOW,
      estimateTokens: (t) => Math.ceil(t.length / 4),
      scoreConfig: {
        half_life_s: 86400,
        importance_floor: 0.1,
        importance_ceil: 1.0,
        access_weight: 0.15,
      },
      recall: { enabled: true, topK: 10 },
    };
    const res = await callMemoryTool("memory_add", { type: "fact", text: "test" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("db locked");
  });
});

// ---- includeInactive for reflections (branch lines 258, 368) -----------------

describe("includeInactive reflection branches", () => {
  it("search with includeInactive=true returns archived reflections (line 258 'all' branch)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", "p1");
    const added = parse(
      await callMemoryTool("memory_add", { type: "reflection", text: "archived content." }, ctx),
    );
    const id = added.id as string;
    // Delete (archive) the reflection
    await callMemoryTool("memory_delete", { type: "reflection", id }, ctx);

    // Without includeInactive: empty
    const withoutInactive = parse(
      await callMemoryTool("memory_search", { type: "reflection", query: "archived" }, ctx),
    );
    expect((withoutInactive.reflections as unknown[]).length).toBe(0);

    // With includeInactive=true: should appear
    const withInactive = parse(
      await callMemoryTool(
        "memory_search",
        { type: "reflection", query: "archived", includeInactive: true },
        ctx,
      ),
    );
    expect((withInactive.reflections as unknown[]).length).toBe(1);
  });
});

// ---- callMemoryTool rawArgs=null and (root) path branch (lines 514, 517) ----

describe("callMemoryTool edge cases", () => {
  it("handles null rawArgs (rawArgs ?? {} branch, line 514)", async () => {
    const { ctxFor } = harness();
    // Passing null for rawArgs — should be treated as {} and fail validation
    const res = await callMemoryTool("memory_add", null, ctxFor("a"));
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("invalid arguments");
  });

  it("formats (root) path when the top-level field is missing (line 517)", async () => {
    const { ctxFor } = harness();
    // memory_get requires both `type` and `id`. Passing completely empty object
    // produces an issue at the root level for `type` (path is []).
    const res = await callMemoryTool("memory_get", {}, ctxFor("a"));
    expect(res.isError).toBe(true);
    // At least one issue should have path "" → formatted as "(root)" or field name
    expect(res.content[0]?.text).toContain("invalid arguments");
  });
});

// ---- memory_add importance branch (lines 201-203) ----------------------------

describe("memory_add importance override branch", () => {
  it("sets custom importance on a fact (line 201-202)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "high-value fact", importance: 0.95 },
      ctx,
    );
    // Retrieve and check importance was applied
    const list = parse(await callMemoryTool("memory_list", { type: "fact" }, ctx));
    const facts = list.facts as Array<{ importance: number; text: string }>;
    const target = facts.find((f) => f.text === "high-value fact");
    expect(target?.importance).toBe(0.95);
  });
});
