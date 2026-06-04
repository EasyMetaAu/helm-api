import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionResult,
  InjectDeps,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { createSqliteDb, hashKey, runObserverJob, SqliteMemoryStore } from "@helm/core";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, type InjectWiring, registerChatRoutes } from "./chat.js";

// gateway.chat.inject (docs/08 Phase 2) — PROVE the inject-phase wiring on
// /v1/chat/completions: on x-memory-mode=inject the assembled docs/08 prefix
// reaches route() in order; non-inject modes never touch the messages; a thrown
// inject is fail-open; a tool-call request is NOT replaced (tool calls preserved).

function keyRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    max_lane: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    ...over,
  };
}

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

function nonStreamOutcome(body: unknown): ExecuteOutcome {
  return {
    attempts: [],
    final: { status: "ok", alias: "m", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

// A fake MemoryStore that serves seeded reflections + observations + recent msgs.
function makeFakeStore(opts: {
  reflection?: { project?: string; resource?: string };
  observations?: string[];
  recent?: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const enqueued: Array<{ type: string }> = [];
  const store = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "m"),
    listMessages: vi.fn(async () =>
      (opts.recent ?? []).map((m, i) => ({
        id: `r${i}`,
        threadId: "t1",
        role: m.role,
        content: m.content,
        tokenEstimate: 2,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    ),
    appendObservation: vi.fn(async () => "o"),
    listObservations: vi.fn(async () =>
      (opts.observations ?? []).map((text, i) => ({
        id: `o${i}`,
        threadId: "t1",
        sourceMessageRange: ["a", "b"] as [string, string],
        observationText: text,
        observedAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    ),
    getReflection: vi.fn(async (scope: { projectId?: string; resourceId?: string }) => {
      if (scope.projectId !== undefined && opts.reflection?.project !== undefined) {
        return mkReflection(opts.reflection.project, { projectId: scope.projectId });
      }
      if (scope.resourceId !== undefined && opts.reflection?.resource !== undefined) {
        return mkReflection(opts.reflection.resource, { resourceId: scope.resourceId });
      }
      return null;
    }),
    upsertReflection: vi.fn(async () => "r"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async (input: { type: string }) => {
      enqueued.push(input);
      return `job-${enqueued.length}`;
    }),
    claimPendingJobs: vi.fn(async () => []),
  };
  return { store, enqueued };
}

function mkReflection(text: string, scope: { projectId?: string; resourceId?: string }) {
  return {
    id: "ref",
    projectId: scope.projectId ?? null,
    resourceId: scope.resourceId ?? null,
    threadId: null,
    reflectionText: text,
    version: 2,
    tokenEstimate: 5,
    updatedAt: new Date(2026, 0, 1),
  };
}

function observeDeps(store: unknown): ObserveDeps {
  return {
    memoryStore: store as ObserveDeps["memoryStore"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    log: vi.fn(),
  };
}

function injectWiring(store: unknown, over: Partial<InjectDeps> = {}): InjectWiring {
  const deps: InjectDeps = {
    memoryStore: store as InjectDeps["memoryStore"],
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    enqueueObserverJob: async () => "job-x",
    costSink: vi.fn(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: vi.fn(),
    ...over,
  };
  return { deps, tokenBudget: 4000 };
}

function captureRouteDeps(opts: { body?: unknown; memory?: ChatRouteDeps["memory"] }): {
  deps: ChatRouteDeps;
  seen: InternalRequest[];
} {
  const seen: InternalRequest[] = [];
  const deps: ChatRouteDeps = {
    route: async (req: InternalRequest, _o: RouteOptions): Promise<ExecutionResult> => {
      // Capture a deep snapshot so later mutation can't change what we asserted.
      seen.push(JSON.parse(JSON.stringify(req)) as InternalRequest);
      const out = nonStreamOutcome(opts.body ?? { ok: true });
      return {
        decision: {
          lane: { selected_lane: "balanced" },
          final: { status: "ok", model_alias: "m", provider_model: "gpt-x" },
          classifier: { decided_by: "rules", eval_cache_hit: null, fallback_reason: null },
        },
        final: { status: "ok" },
        body: out.body ?? { ok: true },
        stream: null,
        error: null,
      } as unknown as ExecutionResult;
    },
    telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as unknown as TelemetryStore,
    redact: (x: unknown) => x,
    now: () => 1000,
    ...(opts.memory ? { memory: opts.memory } : {}),
  };
  return { deps, seen };
}

function buildApp(d: ChatRouteDeps, records: ApiKeyRecord[] = [keyRecord()]) {
  const app = createApp({ logger: { log: () => {} } });
  const byHash = new Map(records.map((record) => [record.hash, record]));
  const getByHash = vi.fn(async (hash: string) => byHash.get(hash) ?? null);
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

const INJECT_HEADERS = {
  "x-memory-mode": "inject",
  "x-thread-id": "t1",
  "x-project-id": "p1",
};
const BODY = { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false };

describe("gateway.chat.inject — assembled prefix reaches route()", () => {
  it("injects reflection + observations + recent raw in docs/08 order ahead of the current turn", async () => {
    const { store } = makeFakeStore({
      reflection: { project: "PROJECT REFLECTION" },
      observations: ["OBS-1"],
      recent: [{ role: "user", content: "earlier turn" }],
    });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
    expect(msgs).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "PROJECT REFLECTION" },
      { role: "user", content: "OBS-1" },
      { role: "user", content: "earlier turn" },
      { role: "user", content: "hi" },
    ]);
  });

  it("hydrates before observing this turn so current input is not duplicated as recent_raw", async () => {
    const { store } = makeFakeStore({ recent: [] });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    const listOrder = store.listMessages.mock.invocationCallOrder[0];
    const appendOrder = store.appendMessage.mock.invocationCallOrder[0];
    expect(listOrder).toBeDefined();
    expect(appendOrder).toBeDefined();
    expect(listOrder as number).toBeLessThan(appendOrder as number);
    const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
    expect(msgs.filter((m) => m.content === "hi")).toHaveLength(1);
  });

  it("does NOT touch messages when mode is observe (not inject)", async () => {
    const { store } = makeFakeStore({ reflection: { project: "R" }, observations: ["O"] });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "observe", "x-thread-id": "t1" },
      body: JSON.stringify(BODY),
    });

    expect(seen[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("fail-open: store load failure preserves the ORIGINAL multi-turn messages (200, no 5xx)", async () => {
    const { store } = makeFakeStore({});
    store.listObservations.mockRejectedValue(new Error("db down"));
    store.listMessages.mockRejectedValue(new Error("db down"));
    store.getReflection.mockRejectedValue(new Error("db down"));
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "hi" },
        ],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "hi" },
    ]);
  });

  it("keeps two accounts isolated for the same logical thread across observe, inject, and observer worker", async () => {
    const db = createSqliteDb(":memory:");
    const store = new SqliteMemoryStore(
      db,
      (() => {
        let i = 0;
        return () => `id-${++i}`;
      })(),
    );
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps, [
      keyRecord({ hash: hashKey("helm_live_a"), account_id: "acct-a" }),
      keyRecord({ hash: hashKey("helm_live_b"), account_id: "acct-b" }),
    ]);

    for (const [token, contents] of [
      ["helm_live_a", ["secret A", "followup A"]],
      ["helm_live_b", ["secret B", "followup B"]],
    ] as const) {
      for (const content of contents) {
        const res = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...INJECT_HEADERS,
          },
          body: JSON.stringify({
            model: "auto",
            messages: [{ role: "user", content }],
            stream: false,
          }),
        });
        expect(res.status).toBe(200);
      }
    }

    await runObserverJob(
      { jobId: "worker-a", accountId: "acct-a", threadId: "acct-a:t1" },
      {
        memoryStore: store,
        summarize: async ({ messages }) => ({
          observationText: `A saw ${messages.map((m) => m.content).join("|")}`,
        }),
        costSink: vi.fn(),
        now: () => new Date("2026-01-02T00:00:00.000Z"),
        log: vi.fn(),
      },
    );
    await runObserverJob(
      { jobId: "worker-b", accountId: "acct-b", threadId: "acct-b:t1" },
      {
        memoryStore: store,
        summarize: async ({ messages }) => ({
          observationText: `B saw ${messages.map((m) => m.content).join("|")}`,
        }),
        costSink: vi.fn(),
        now: () => new Date("2026-01-02T00:00:00.000Z"),
        log: vi.fn(),
      },
    );

    const aMsgs = await store.listMessages({ accountId: "acct-a", threadId: "acct-a:t1" });
    const bMsgs = await store.listMessages({ accountId: "acct-b", threadId: "acct-b:t1" });
    expect(aMsgs.map((m) => m.content)).toContain("secret A");
    expect(aMsgs.map((m) => m.content)).not.toContain("secret B");
    expect(bMsgs.map((m) => m.content)).toContain("secret B");
    expect(bMsgs.map((m) => m.content)).not.toContain("secret A");

    const aObs = await store.listObservations({ accountId: "acct-a", threadId: "acct-a:t1" });
    const bObs = await store.listObservations({ accountId: "acct-b", threadId: "acct-b:t1" });
    expect(aObs.map((o) => o.observationText).join("\n")).toContain("secret A");
    expect(aObs.map((o) => o.observationText).join("\n")).not.toContain("secret B");
    expect(bObs.map((o) => o.observationText).join("\n")).toContain("secret B");
    expect(bObs.map((o) => o.observationText).join("\n")).not.toContain("secret A");

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer helm_live_a",
        "Content-Type": "application/json",
        ...INJECT_HEADERS,
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "next A" }],
        stream: false,
      }),
    });
    const last = seen.at(-1)?.messages as Array<{ content: string }>;
    const injectedText = last.map((m) => m.content).join("\n");
    expect(injectedText).toContain("secret A");
    expect(injectedText).not.toContain("secret B");
    db.$sqlite.close();
  });

  it("skips replacement for a tool-call request (tool calls preserved)", async () => {
    const { store } = makeFakeStore({ reflection: { project: "R" }, observations: ["O"] });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps);

    const toolBody = {
      model: "auto",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "c1" },
      ],
      stream: false,
    };

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify(toolBody),
    });

    expect(res.status).toBe(200);
    const msgs = seen[0]?.messages as Array<{ role: string; tool_calls?: unknown[] }>;
    // The tool_calls survived — inject did NOT replace the messages.
    expect(msgs.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0)).toBe(true);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
  });
});
