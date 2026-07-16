import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionResult,
  InjectDeps,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import {
  createSqliteDb,
  hashKey,
  projectScopedThreadId,
  runObserverJob,
  SqliteMemoryStore,
} from "@helm/core";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, type InjectWiring, registerChatRoutes } from "./chat.js";

// gateway.chat.inject (docs/08 Phase 2, #217 Phase 4 TRAILING-REMINDER model) — PROVE
// the inject-phase wiring on /v1/chat/completions: on x-memory-mode=inject the assembled
// memory block is APPENDED as ONE trailing <system-reminder> user turn AFTER the VERBATIM
// live conversation (additive, no full-replace, no system-prefix edit, no D7 gate) — so
// the client's cached prefix is untouched; non-inject modes never touch the messages; a
// thrown inject is fail-open; tool-call turns ride through untouched.

function keyRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: null,
    allowed_lanes: null,
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

describe("gateway.chat.inject — assembled reminder reaches route()", () => {
  it("APPENDS reflection + observations as a trailing <system-reminder> turn, conversation verbatim (#217 Phase 4)", async () => {
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
    // TRAILING-REMINDER model: the client's system prompt and live turn ride through
    // VERBATIM (cached prefix untouched); memory is ONE trailing <system-reminder> user
    // turn carrying reflection + observation. "earlier turn" was loaded only for
    // window-dedup, never re-injected.
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("PROJECT REFLECTION");
    expect(msgs[2]?.content).toContain("OBS-1");
    expect(msgs[2]?.content.startsWith("<system-reminder>")).toBe(true);
    expect(msgs[2]?.content.endsWith("</system-reminder>")).toBe(true);
  });

  it("preserves developer instructions under x-memory-mode=inject instead of silently dropping them", async () => {
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

    const original = [
      { role: "developer", content: "Always answer in JSON." },
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify({ model: "auto", messages: original, stream: false }),
    });

    expect(res.status).toBe(200);
    // TRAILING-REMINDER model: EVERY original turn (developer + system + user) rides
    // verbatim, in order; the memory block is appended as ONE trailing <system-reminder>
    // user turn — developer instructions preserved, the live conversation untouched.
    const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
    expect(msgs.slice(0, 3)).toEqual(original);
    expect(msgs[3]?.role).toBe("user");
    expect(msgs[3]?.content).toContain("PROJECT REFLECTION");
    expect(msgs[3]?.content.startsWith("<system-reminder>")).toBe(true);
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

    const threadA = projectScopedThreadId("acct-a", "p1", "t1");
    const threadB = projectScopedThreadId("acct-b", "p1", "t1");
    await runObserverJob(
      { jobId: "worker-a", accountId: "acct-a", threadId: threadA },
      {
        memoryStore: store,
        summarize: async ({ messages }) => ({
          observationText: `A saw ${messages.map((m) => m.content).join("|")}`,
        }),
        costSink: vi.fn(),
        resolvePricing: () => ({
          modelKey: null,
          inputPerMtok: null,
          outputPerMtok: null,
          cacheReadPerMtok: null,
          cacheWritePerMtok: null,
          maxContextTokens: null,
        }),
        now: () => new Date("2099-01-02T00:00:00.000Z"),
        log: vi.fn(),
      },
    );
    await runObserverJob(
      { jobId: "worker-b", accountId: "acct-b", threadId: threadB },
      {
        memoryStore: store,
        summarize: async ({ messages }) => ({
          observationText: `B saw ${messages.map((m) => m.content).join("|")}`,
        }),
        costSink: vi.fn(),
        resolvePricing: () => ({
          modelKey: null,
          inputPerMtok: null,
          outputPerMtok: null,
          cacheReadPerMtok: null,
          cacheWritePerMtok: null,
          maxContextTokens: null,
        }),
        now: () => new Date("2099-01-02T00:00:00.000Z"),
        log: vi.fn(),
      },
    );

    const aMsgs = await store.listMessages({ accountId: "acct-a", threadId: threadA });
    const bMsgs = await store.listMessages({ accountId: "acct-b", threadId: threadB });
    expect(aMsgs.map((m) => m.content)).toContain("secret A");
    expect(aMsgs.map((m) => m.content)).not.toContain("secret B");
    expect(bMsgs.map((m) => m.content)).toContain("secret B");
    expect(bMsgs.map((m) => m.content)).not.toContain("secret A");

    const aObs = await store.listObservations({ accountId: "acct-a", threadId: threadA });
    const bObs = await store.listObservations({ accountId: "acct-b", threadId: threadB });
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

  it("isolates the same client thread by effective key project and preserves explicit project sharing", async () => {
    const db = createSqliteDb(":memory:");
    const store = new SqliteMemoryStore(
      db,
      (() => {
        let i = 0;
        return () => `scope-id-${++i}`;
      })(),
    );
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps, [
      keyRecord({
        key_id: "key-a",
        hash: hashKey("helm_live_key_a"),
        account_id: "acct-shared",
        memory_mode: "inject",
      }),
      keyRecord({
        key_id: "key-b",
        hash: hashKey("helm_live_key_b"),
        account_id: "acct-shared",
        memory_mode: "inject",
      }),
      keyRecord({
        key_id: "key-c",
        hash: hashKey("helm_live_key_c"),
        account_id: "acct-shared",
        memory_mode: "inject",
        memory_project_id: "team-project",
      }),
      keyRecord({
        key_id: "key-d",
        hash: hashKey("helm_live_key_d"),
        account_id: "acct-shared",
        memory_mode: "inject",
        memory_project_id: "team-project",
      }),
    ]);
    const headersFor = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-memory-mode": "inject",
      "x-thread-id": "same-client-thread",
    });
    const send = async (token: string, content: string) => {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: headersFor(token),
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] }),
      });
      expect(res.status).toBe(200);
    };

    await send("helm_live_key_a", "KEY_A_SECRET");
    await send("helm_live_key_b", "KEY_B_SECRET");
    await send("helm_live_key_c", "SHARED_FROM_C");
    await send("helm_live_key_d", "SHARED_FROM_D");

    const threadA = projectScopedThreadId("acct-shared", "key-a", "same-client-thread");
    const threadB = projectScopedThreadId("acct-shared", "key-b", "same-client-thread");
    const sharedThread = projectScopedThreadId("acct-shared", "team-project", "same-client-thread");
    expect(threadA).not.toBe(threadB);

    const messagesA = await store.listMessages({ accountId: "acct-shared", threadId: threadA });
    const messagesB = await store.listMessages({ accountId: "acct-shared", threadId: threadB });
    const sharedMessages = await store.listMessages({
      accountId: "acct-shared",
      threadId: sharedThread,
    });
    expect(messagesA.map((message) => message.content)).toContain("KEY_A_SECRET");
    expect(messagesA.map((message) => message.content)).not.toContain("KEY_B_SECRET");
    expect(messagesB.map((message) => message.content)).toContain("KEY_B_SECRET");
    expect(messagesB.map((message) => message.content)).not.toContain("KEY_A_SECRET");
    expect(sharedMessages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["SHARED_FROM_C", "SHARED_FROM_D"]),
    );

    await store.appendObservation({
      threadId: threadA,
      sourceMessageRange: [messagesA[0]?.id ?? "a", messagesA[0]?.id ?? "a"],
      observationText: "ONLY_KEY_A_MEMORY",
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await store.appendObservation({
      threadId: threadB,
      sourceMessageRange: [messagesB[0]?.id ?? "b", messagesB[0]?.id ?? "b"],
      observationText: "ONLY_KEY_B_MEMORY",
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await store.appendObservation({
      threadId: sharedThread,
      sourceMessageRange: [sharedMessages[0]?.id ?? "s", sharedMessages[0]?.id ?? "s"],
      observationText: "TEAM_SHARED_MEMORY",
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    await send("helm_live_key_a", "next A");
    const injectedA = JSON.stringify(seen.at(-1)?.messages);
    expect(injectedA).toContain("ONLY_KEY_A_MEMORY");
    expect(injectedA).not.toContain("ONLY_KEY_B_MEMORY");
    await send("helm_live_key_b", "next B");
    const injectedB = JSON.stringify(seen.at(-1)?.messages);
    expect(injectedB).toContain("ONLY_KEY_B_MEMORY");
    expect(injectedB).not.toContain("ONLY_KEY_A_MEMORY");
    await send("helm_live_key_c", "next C");
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain("TEAM_SHARED_MEMORY");
    await send("helm_live_key_d", "next D");
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain("TEAM_SHARED_MEMORY");

    db.$sqlite.close();
  });

  it("stamps inject metadata onto the decision record for telemetry (P3)", async () => {
    const { store } = makeFakeStore({
      reflection: { project: "PROJECT REFLECTION" },
      observations: ["OBS-1"],
      recent: [],
    });
    const { deps } = captureRouteDeps({
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
    const insert = deps.telemetry.insert as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledTimes(1);
    const arg = insert.mock.calls[0]?.[0] as {
      decision: { memory?: { memory_hydrated: boolean } };
    };
    expect(arg.decision.memory).toMatchObject({
      memory_hydrated: true,
      observation_count: 1,
      memory_writeback_status: "queued",
    });
  });

  it("keeps a tool-call request VERBATIM (tool calls preserved, write-back still enqueued)", async () => {
    const { store } = makeFakeStore({ reflection: { project: "R" }, observations: ["O"] });
    const enqueueObserverJob = vi.fn(async () => "job-tool");
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store, { enqueueObserverJob }) },
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
    // The tool_calls + tool role survived — the TRAILING-REMINDER model is purely additive
    // (memory rides a trailing <system-reminder> turn; the live tool turns are kept
    // verbatim). This is exactly why the legacy D7 plain-text gate is gone: there is no
    // replacement to skip.
    expect(msgs.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0)).toBe(true);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    // The observer WRITE-BACK still fired — tool-heavy threads keep compressing.
    expect(enqueueObserverJob).toHaveBeenCalledTimes(1);
  });
});

// Issue #97 — ZERO-CLIENT-CHANGE memory: the key's stored defaults turn memory on
// and the fallback chain derives the thread from signals the client already sends
// (here: OpenAI prompt_cache_key, what OpenClaw/Codex emit per conversation).
// No x-memory-* headers anywhere in these requests.
describe("gateway.chat.inject — per-key defaults + signal fallback (issue #97)", () => {
  const MEMORY_KEY = keyRecord({
    memory_mode: "inject",
    memory_project_id: "proj-key",
    memory_thread_source: "auto",
  });

  it("hydrates with ZERO memory headers: key defaults + prompt_cache_key as thread", async () => {
    const { store } = makeFakeStore({
      reflection: { project: "PROJECT REFLECTION" },
      observations: ["OBS-1"],
      recent: [],
    });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps, [MEMORY_KEY]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH, // ← no x-memory-* headers at all
      body: JSON.stringify({ ...BODY, prompt_cache_key: "conv-abc" }),
    });

    expect(res.status).toBe(200);
    const msgs = seen[0]?.messages as Array<{ role: string; content: string }>;
    // The key default project's reflection was hydrated into the trailing <system-reminder>
    // user turn (TRAILING-REMINDER model) — appended after the conversation, not merged
    // into a system message.
    expect(
      msgs.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("PROJECT REFLECTION") &&
          m.content.startsWith("<system-reminder>"),
      ),
    ).toBe(true);
    // Observability: the decision records WHICH chain link produced the thread.
    const insert = deps.telemetry.insert as ReturnType<typeof vi.fn>;
    const arg = insert.mock.calls[0]?.[0] as {
      decision: { memory?: { memory_hydrated: boolean; thread_source: string | null } };
    };
    expect(arg.decision.memory?.memory_hydrated).toBe(true);
    expect(arg.decision.memory?.thread_source).toBe("prompt_cache_key");
    // The derived thread is account + effective-project scoped like any explicit one.
    expect(store.ensureThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: projectScopedThreadId("acct", "proj-key", "conv-abc") }),
    );
  });

  it("an explicit x-memory-mode: off header still disables memory for a default-inject key", async () => {
    const { store } = makeFakeStore({ reflection: { project: "R" } });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps, [MEMORY_KEY]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "off" },
      body: JSON.stringify({ ...BODY, prompt_cache_key: "conv-abc" }),
    });

    expect(res.status).toBe(200);
    expect(seen[0]?.messages).toEqual(BODY.messages);
    expect(store.ensureThread).not.toHaveBeenCalled();
  });

  it("an unconfigured key with no headers behaves exactly as before (zero regression)", async () => {
    const { store } = makeFakeStore({ reflection: { project: "R" } });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps); // default keyRecord(): memory off

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...BODY, prompt_cache_key: "conv-abc" }),
    });

    expect(res.status).toBe(200);
    expect(seen[0]?.messages).toEqual(BODY.messages);
    expect(store.ensureThread).not.toHaveBeenCalled();
  });

  it("covers threadId=null branch (x-memory-mode=inject, no thread header → scope.threadId is null)", async () => {
    // Without x-thread-id header, memoryScope.threadId is null →
    // the ternary at line 652-654 takes the {} arm (covers line 654).
    const { store } = makeFakeStore({ reflection: { project: "R" } });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
    });
    const app = buildApp(deps, [keyRecord({ memory_mode: "inject" as never })]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      // No x-thread-id → threadId is null
      headers: { ...AUTH, "x-memory-mode": "inject", "x-project-id": "p1" },
      body: JSON.stringify({ ...BODY }),
    });

    expect(res.status).toBe(200);
    // messages are injected (memory mode is on) even without a threadId
    expect(seen[0]?.messages).toBeDefined();
  });

  it("covers maxFactsInjected branch by passing it in wiring (line 662-663)", async () => {
    // injectWiring with maxFactsInjected set → the ternary at line 662 takes the true arm.
    const { store } = makeFakeStore({ reflection: { project: "R" } });
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: {
        observe: observeDeps(store),
        inject: { ...injectWiring(store), maxFactsInjected: 5 },
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...INJECT_HEADERS },
      body: JSON.stringify({ ...BODY }),
    });

    expect(res.status).toBe(200);
    expect(seen[0]?.messages).toBeDefined();
  });
});
