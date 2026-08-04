import { type ApiKeyRecord, createSqliteDb, hashKey, SqliteMemoryStore } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import { authMiddleware } from "../../middleware/auth.js";
import { createTrackedBackgroundTasks } from "../../runtime/maintenance-gate.js";
import type { McpDeps } from "./deps.js";
import { registerMcpServer } from "./index.js";
import {
  callMemoryTool,
  listMemoryTools,
  type MemoryToolContext,
  supportsMemoryAdmin,
} from "./tools.js";

const NOW = new Date("2026-06-19T00:00:00.000Z");

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: null,
    allowed_lanes: ["economy", "balanced"],
    allow_custom_model: false,
    blocked_models: null,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "off" as const,
    memory_project_id: null,
    memory_thread_source: "header" as const,
    request_content_mode: null,
    max_reasoning_effort: null,
    ...overrides,
  };
}

// One in-memory store shared by every ctx so add→read flows within a test see the
// same rows. ctxFor() varies the account so tenant isolation can be asserted.
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

describe("memory MCP tools (docs/13)", () => {
  it("lists the seven tools with input schemas", () => {
    const tools = listMemoryTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_add",
      "memory_delete",
      "memory_get",
      "memory_list",
      "memory_recall",
      "memory_search",
      "memory_update",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("memory_add(fact) → memory_get → memory_search round-trips", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", text: "loves TypeScript", subject: "lang" },
        ctx,
      ),
    );
    const id = (added.added as string[])[0] as string;
    expect(id).toBeTruthy();

    const got = parse(await callMemoryTool("memory_get", { type: "fact", id }, ctx));
    expect(got.text).toBe("loves TypeScript");
    expect(got.subject).toBe("lang");

    const found = parse(
      await callMemoryTool("memory_search", { type: "fact", query: "typescript" }, ctx),
    );
    expect((found.facts as unknown[]).length).toBe(1);
  });

  it("memory_recall hybrid-recalls a fact (CJK trigram), account-scoped", async () => {
    const { ctxFor } = harness();
    const ctxA = ctxFor("acct-a");
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "用户最喜欢的编程语言是 TypeScript", subject: "lang" },
      ctxA,
    );
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "项目部署在 la.atmy.work", subject: "deploy" },
      ctxA,
    );
    // another account's matching fact must NOT surface for acct-a
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "编程语言机密信息", subject: "x" },
      ctxFor("acct-b"),
    );
    const res = parse(await callMemoryTool("memory_recall", { query: "编程语言" }, ctxA));
    const texts = (res.facts as Array<{ text: string }>).map((f) => f.text);
    expect(texts).toContain("用户最喜欢的编程语言是 TypeScript");
    expect(texts).not.toContain("编程语言机密信息");
  });

  it("memory_recall degrades to substring LIKE when facts_retrieval is disabled", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a", null, { recall: { enabled: false, topK: 10 } });
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "loves TypeScript", subject: "lang" },
      ctx,
    );
    const res = parse(await callMemoryTool("memory_recall", { query: "TypeScript" }, ctx));
    expect(res.degraded).toBe(true);
    expect((res.facts as unknown[]).length).toBe(1);
  });

  it("memory_recall is fail-open: an embedder error still returns FTS+score results", async () => {
    const { ctxFor } = harness();
    const throwingEmbedder = { embed: vi.fn().mockRejectedValue(new Error("embed down")) };
    const ctx = ctxFor("a", null, { embedder: throwingEmbedder });
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "deploy target is la.atmy.work", subject: "deploy" },
      ctx,
    );
    const result = await callMemoryTool("memory_recall", { query: "deploy target" }, ctx);
    expect(result.isError).toBeFalsy();
    const res = parse(result);
    expect((res.facts as Array<{ text: string }>).map((f) => f.text)).toContain(
      "deploy target is la.atmy.work",
    );
  });

  it("memory_recall reinforces recalled facts (reference bump)", async () => {
    const { ctxFor, store } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", text: "prefers dark mode theme", subject: "ui" },
        ctx,
      ),
    );
    const id = (added.added as string[])[0] as string;
    await callMemoryTool("memory_recall", { query: "dark mode" }, ctx);
    // better-sqlite3 is synchronous, so the fire-and-forget bump has already run.
    const got = await store.getFactById?.({ accountId: "a", id });
    expect(got?.referenceCount).toBe(1);
  });

  it("registers the recall reference bump so maintenance waits for it", async () => {
    const { ctxFor, store } = harness();
    const background = createTrackedBackgroundTasks();
    const runInBackground = vi.fn(background.run);
    const ctx = ctxFor("a", null, { runInBackground });
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "maintenance-safe recall", subject: "runtime" },
      ctx,
    );
    let finishBump = () => {};
    store.bumpReferences = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBump = resolve;
        }),
    );

    await callMemoryTool("memory_recall", { query: "maintenance-safe" }, ctx);
    expect(runInBackground).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.bumpReferences).toHaveBeenCalledOnce());
    let paused = false;
    const waiting = background.pauseAndWait().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);

    finishBump();
    await waiting;
    expect(paused).toBe(true);
  });

  it("keeps recall fail-open without writing when maintenance rejects the bump", async () => {
    const { ctxFor, store } = harness();
    const ctx = ctxFor("a", null, { runInBackground: () => false });
    await callMemoryTool(
      "memory_add",
      { type: "fact", text: "reject unsafe background write", subject: "runtime" },
      ctx,
    );
    store.bumpReferences = vi.fn(async () => {});

    const result = await callMemoryTool("memory_recall", { query: "unsafe background" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(store.bumpReferences).not.toHaveBeenCalled();
  });

  it("memory_add(reflection) returns id + version", async () => {
    const { ctxFor } = harness();
    const res = parse(
      await callMemoryTool(
        "memory_add",
        { type: "reflection", text: "the user is an expert" },
        ctxFor("a", "p1"),
      ),
    );
    expect(res.id).toBeTruthy();
    expect(res.version).toBe(1);
  });

  it("memory_update(fact) rewords; identical-text collision is an isError", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const alpha = parse(
      await callMemoryTool("memory_add", { type: "fact", subject: "s1", text: "alpha" }, ctx),
    );
    const beta = parse(
      await callMemoryTool("memory_add", { type: "fact", subject: "s2", text: "beta" }, ctx),
    );
    const betaId = (beta.added as string[])[0] as string;

    const reworded = parse(
      await callMemoryTool("memory_update", { type: "fact", id: betaId, text: "gamma" }, ctx),
    );
    expect(reworded.text).toBe("gamma");

    const collide = await callMemoryTool(
      "memory_update",
      { type: "fact", id: betaId, text: "alpha" },
      ctx,
    );
    expect(collide.isError).toBe(true);
    expect(alpha.added).toBeTruthy(); // sanity: alpha exists
  });

  it("memory_delete(fact) soft-deletes so search no longer returns it", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "secret note" }, ctx),
    );
    const id = (added.added as string[])[0] as string;
    const del = parse(await callMemoryTool("memory_delete", { type: "fact", id }, ctx));
    expect(del.deleted).toBe(true);
    const found = parse(
      await callMemoryTool("memory_search", { type: "fact", query: "secret" }, ctx),
    );
    expect((found.facts as unknown[]).length).toBe(0);
  });

  it("memory_add re-adds a DELETED fact by RESURRECTING it (not a silent dedup)", async () => {
    const { ctxFor } = harness();
    const ctx = ctxFor("a");
    const added = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", subject: "lang", text: "loves Rust" },
        ctx,
      ),
    );
    const id = (added.added as string[])[0] as string;
    await callMemoryTool("memory_delete", { type: "fact", id }, ctx);
    const gone = parse(await callMemoryTool("memory_search", { type: "fact", query: "rust" }, ctx));
    expect((gone.facts as unknown[]).length).toBe(0);

    // Re-add the SAME fact text → reactivated in place, reported as resurrected.
    const re = parse(
      await callMemoryTool(
        "memory_add",
        { type: "fact", subject: "lang", text: "loves Rust" },
        ctx,
      ),
    );
    expect(re.added).toEqual([]);
    expect(re.resurrected).toEqual([id]);
    expect(re.deduped).toBe(false);
    const back = parse(await callMemoryTool("memory_search", { type: "fact", query: "rust" }, ctx));
    expect((back.facts as unknown[]).length).toBe(1);
  });

  it("enforces tenant isolation — another account cannot get a fact by id", async () => {
    const { ctxFor } = harness();
    const added = parse(
      await callMemoryTool("memory_add", { type: "fact", text: "tenant a only" }, ctxFor("a")),
    );
    const id = (added.added as string[])[0] as string;
    const cross = await callMemoryTool("memory_get", { type: "fact", id }, ctxFor("b"));
    expect(cross.isError).toBe(true);
    expect(cross.content[0]?.text).toContain("not found");
  });

  it("rejects invalid arguments with an isError result (not a throw)", async () => {
    const { ctxFor } = harness();
    const res = await callMemoryTool("memory_add", { type: "fact" }, ctxFor("a")); // missing text
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("invalid arguments");
  });
});

// ---- route / JSON-RPC / auth -----------------------------------------------

function mcpApp(
  rec: ApiKeyRecord | null,
  runInBackground: McpDeps["runInBackground"] = (task) => {
    void task();
    return true;
  },
) {
  const db = createSqliteDb(":memory:");
  let seq = 0;
  const store = new SqliteMemoryStore(
    db,
    () => `id-${++seq}`,
    () => NOW,
  );
  const app = new Hono<AppEnv>();
  app.use(
    "/mcp",
    authMiddleware({ keyStore: { getByHash: vi.fn().mockResolvedValue(rec) }, log: () => {} }),
  );
  registerMcpServer(app, {
    memoryStore: store,
    now: () => NOW,
    estimateTokens: (t) => Math.ceil(t.length / 4),
    runInBackground,
    scoreConfig: {
      half_life_s: 86400,
      importance_floor: 0.1,
      importance_ceil: 1.0,
      access_weight: 0.15,
    },
    recall: { enabled: true, topK: 10 },
  });
  return app;
}

function rpc(method: string, params?: unknown, id: number | string | null = 1) {
  return {
    method: "POST",
    headers: { Authorization: "Bearer helm_live_secret", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  };
}

describe("POST /mcp JSON-RPC route (docs/13)", () => {
  it("requires API-key auth (401 without a key)", async () => {
    const app = mcpApp(record());
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("performs the initialize handshake", async () => {
    const app = mcpApp(record());
    const res = await app.request(
      "/mcp",
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "c", version: "0" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("helm-memory");
  });

  it("lists tools and round-trips a tool call over JSON-RPC", async () => {
    const app = mcpApp(record());
    const list = (await (await app.request("/mcp", rpc("tools/list"))).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools).toHaveLength(7);

    const add = (await (
      await app.request(
        "/mcp",
        rpc("tools/call", {
          name: "memory_add",
          arguments: { type: "fact", text: "remembered via mcp" },
        }),
      )
    ).json()) as { result: { content: Array<{ text: string }> } };
    const added = JSON.parse(add.result.content[0]?.text ?? "{}") as { added: string[] };
    expect(added.added).toHaveLength(1);

    const search = (await (
      await app.request(
        "/mcp",
        rpc("tools/call", {
          name: "memory_search",
          arguments: { type: "fact", query: "remembered" },
        }),
      )
    ).json()) as { result: { content: Array<{ text: string }> } };
    const facts = JSON.parse(search.result.content[0]?.text ?? "{}") as { facts: unknown[] };
    expect(facts.facts).toHaveLength(1);
  });

  it("passes the runtime background runner to memory_recall", async () => {
    const runInBackground = vi.fn((_task: () => Promise<unknown>) => true);
    const app = mcpApp(record(), runInBackground);
    await app.request(
      "/mcp",
      rpc("tools/call", {
        name: "memory_add",
        arguments: { type: "fact", text: "tracked route recall" },
      }),
    );

    const response = await app.request(
      "/mcp",
      rpc("tools/call", {
        name: "memory_recall",
        arguments: { query: "tracked route" },
      }),
    );

    expect(response.status).toBe(200);
    expect(runInBackground).toHaveBeenCalledOnce();
  });

  it("returns 202 with no body for a notification", async () => {
    const app = mcpApp(record());
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer helm_live_secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("returns a JSON-RPC method-not-found error for an unknown method", async () => {
    const app = mcpApp(record());
    const res = await app.request("/mcp", rpc("does/not/exist"));
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });
});
