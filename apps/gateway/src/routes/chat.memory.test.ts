import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionResult,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { hashKey, projectScopedThreadId } from "@helm/core";
import type { InternalRequest, MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

// gateway.chat.memory — PROVE the observe-phase wiring on /v1/chat/completions:
//  (STEP 1) the four memory request headers must map onto the InternalRequest
//  metadata (thread_id/resource_id/project_id/memory_mode), absent → off/null.
//  (STEP 4) observeInbound persists the inbound messages BEFORE routing and
//  observeOutbound persists the assistant turn AFTER a successful response, both
//  fail-open and both byte-transparent to the client (CLAUDE.md principles 1/3/8).

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
    request_content_mode: null,
    max_reasoning_effort: null,
    ...over,
  };
}

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

function nonStreamOutcome(body: unknown): ExecuteOutcome {
  return {
    attempts: [
      {
        alias: "default_good_model",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 10,
        cost_usd: null,
        error_detail: null,
      },
    ],
    final: { status: "ok", alias: "default_good_model", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

// A recording fake MemoryStore — same shape observe.test.ts uses. Captures every
// ensureThread / appendMessage so tests assert exactly what observe persisted.
function makeFakeStore() {
  const threads: MemoryThreadInput[] = [];
  const messages: MemoryMessageInput[] = [];
  const store = {
    ensureThread: vi.fn(async (input: MemoryThreadInput) => {
      threads.push(input);
    }),
    appendMessage: vi.fn(async (input: MemoryMessageInput) => {
      messages.push(input);
      return `msg-${messages.length}`;
    }),
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "unused"),
    listObservations: vi.fn(async () => []),
    getReflection: vi.fn(async () => null),
    upsertReflection: vi.fn(async () => "unused"),
    updateJobStatus: vi.fn(async () => {}),
  };
  return { store, threads, messages };
}

function observeDeps(store: ReturnType<typeof makeFakeStore>["store"]): ObserveDeps {
  return {
    memoryStore: store as unknown as ObserveDeps["memoryStore"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    log: vi.fn(),
  };
}

// Build a route stub capturing the InternalRequest + returning a canned result.
// `body` is the OpenAI non-stream body; `stream` an optional SSE source.
function captureRouteDeps(opts: {
  body?: unknown;
  stream?: AsyncIterable<string> | null;
  memory?: { observe: ObserveDeps };
}): { deps: ChatRouteDeps; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const deps: ChatRouteDeps = {
    route: async (req: InternalRequest, _opts: RouteOptions): Promise<ExecutionResult> => {
      seen.push(req);
      const out = nonStreamOutcome(opts.body ?? { ok: true });
      return {
        decision: {
          lane: { selected_lane: "balanced" },
          final: { status: "ok", model_alias: "default_good_model", provider_model: "gpt-x" },
          classifier: { decided_by: "rules", eval_cache_hit: null, fallback_reason: null },
        },
        final: { status: "ok" },
        body: opts.stream ? null : (out.body ?? { ok: true }),
        stream: opts.stream ?? null,
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

function buildApp(d: ChatRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

const BODY = { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false };
const MEM_HEADERS = {
  "x-memory-mode": "observe",
  "x-thread-id": "thread-1",
  "x-resource-id": "resource-1",
  "x-project-id": "project-1",
};

// ── STEP 1 — header → InternalRequest.metadata ───────────────────────────────
describe("gateway.chat.memory — request headers map onto metadata", () => {
  it("carries the four memory fields from headers onto the InternalRequest metadata", async () => {
    const { deps, seen } = captureRouteDeps({});
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(seen[0]?.metadata).toMatchObject({
      thread_id: "thread-1",
      resource_id: "resource-1",
      project_id: "project-1",
      memory_mode: "observe",
    });
  });

  it("defaults to off + null thread/resource, project falls back to the key id (isolate by key) when no memory headers are present", async () => {
    const { deps, seen } = captureRouteDeps({});
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(seen[0]?.metadata).toMatchObject({
      thread_id: null,
      resource_id: null,
      // No explicit memory_project_id on the key => effective project is the key's
      // own id (k1): memory is isolated per API key (effectiveMemoryProjectId).
      project_id: "k1",
      memory_mode: "off",
    });
  });
});

// ── STEP 4 — observe persistence ─────────────────────────────────────────────
describe("gateway.chat.memory — observe persists request/response", () => {
  it("persists the inbound messages (ensureThread + appendMessage) under x-memory-mode: observe", async () => {
    const { store, threads, messages } = makeFakeStore();
    const { deps } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "yo" } }] },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(threads).toEqual([
      {
        id: projectScopedThreadId("acct", "project-1", "thread-1"),
        ownerId: "acct",
        projectId: "project-1",
        resourceId: "resource-1",
      },
    ]);
    // inbound user message persisted.
    expect(messages.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
  });

  it("does not persist inbound system messages as long-term user memory", async () => {
    const { store, messages } = makeFakeStore();
    const { deps } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify({
        ...BODY,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    });

    expect(messages.some((m) => m.content === "be terse")).toBe(false);
    expect(messages.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
  });

  it("does ZERO store calls when threadId is null even with mode observe", async () => {
    const { store } = makeFakeStore();
    const { deps } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "observe" }, // no x-thread-id
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it("off-mode is a pure no-op AND the messages handed to route are unchanged", async () => {
    const { store } = makeFakeStore();
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH, // no memory headers → off
      body: JSON.stringify(BODY),
    });

    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(seen[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("fail-open: appendMessage rejecting does not 5xx; route still ran", async () => {
    const { store } = makeFakeStore();
    store.appendMessage.mockRejectedValue(new Error("db down"));
    const { deps, seen } = captureRouteDeps({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("non-stream outbound: the assistant message is appended after a 200", async () => {
    const { store, messages } = makeFakeStore();
    const { deps } = captureRouteDeps({
      body: {
        choices: [{ index: 0, message: { role: "assistant", content: "hello back" } }],
      },
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(messages.some((m) => m.role === "assistant" && m.content === "hello back")).toBe(true);
  });

  it("streaming: client SSE bytes are unchanged AND the assistant text is captured", async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    async function* upstream(): AsyncIterable<string> {
      for (const f of frames) yield f;
    }
    const { store, messages } = makeFakeStore();
    const { deps } = captureRouteDeps({
      stream: upstream(),
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify({ ...BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // Forwarded bytes are exactly the upstream frames (byte-transparent).
    expect(text).toBe(frames.join(""));
    // The accumulated assistant text was persisted after the stream finished.
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });

  it("streaming: captures assistant text even when SSE frames are split across transport chunks", async () => {
    // The provider client yields ARBITRARY transport chunks (openai.ts reader.read()),
    // not whole SSE events. These deliberately split a single `data: {...}` frame
    // across the chunk boundary; a per-chunk parser would JSON.parse-fail and drop
    // the split content. The buffered accumulator must still reconstruct it fully.
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":" wor',
      'ld"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    async function* upstream(): AsyncIterable<string> {
      for (const c of chunks) yield c;
    }
    const { store, messages } = makeFakeStore();
    const { deps } = captureRouteDeps({
      stream: upstream(),
      memory: { observe: observeDeps(store) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify({ ...BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    // Forwarded bytes are byte-identical to the upstream chunks (principle 8).
    expect(await res.text()).toBe(chunks.join(""));
    // Despite the split frames, the FULL assistant text was reconstructed.
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello world")).toBe(true);
  });
});
