import type { ExecuteOutcome, ExecutionResult, ObserveDeps, RouteOptions } from "@helm/core";
import type { InternalRequest, MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  type MessagesIdentity,
  type MessagesRouteDeps,
  registerMessagesRoute,
} from "./messages.js";
import { createMessagesPipeline, type RouteFn } from "./messages-pipeline.js";

// gateway.messages.memory — PROVE the observe-phase wiring on /v1/messages (and,
// by the shared pipeline, /v1/responses):
//  (STEP 2) the four memory headers must be stamped onto the IR metadata by the
//  route and read back by the pipeline onto the InternalRequest metadata.
//  (STEP 5) the pipeline runs observeInbound before routing and observeOutbound
//  after, fail-open and byte-transparent (CLAUDE.md principles 1/3/8).

const AUTH = { "x-api-key": "helm_live_secret", "Content-Type": "application/json" };
const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };
const MEM_HEADERS = {
  "x-memory-mode": "observe",
  "x-thread-id": "thread-1",
  "x-resource-id": "resource-1",
  "x-project-id": "project-1",
};

// A recording fake MemoryStore (same shape observe.test.ts uses).
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

function nonStreamOutcome(body: unknown): ExecuteOutcome {
  return {
    attempts: [],
    final: { status: "ok", alias: "x", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

// A route stub capturing the InternalRequest + returning a canned result.
function captureRoute(opts: {
  body?: unknown;
  stream?: AsyncIterable<string> | null;
  rejectAppend?: boolean;
}): { route: RouteFn; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const route: RouteFn = async (req: InternalRequest, _opts: RouteOptions) => {
    seen.push(req);
    return {
      decision: { lane: { selected_lane: "balanced" } },
      final: { status: "ok" },
      body: opts.stream ? null : (nonStreamOutcome(opts.body ?? { ok: true }).body ?? { ok: true }),
      stream: opts.stream ?? null,
      error: null,
    } as unknown as ExecutionResult;
  };
  return { route, seen };
}

// Build the route deps around a REAL pipeline (with the memory dep injected) and
// a pass-through Anthropic transformer that carries `messages`/`metadata` so the
// metadata round-trip + observe persistence are exercised end to end.
function buildApp(opts: { route: RouteFn; memory?: { observe: ObserveDeps }; stream?: boolean }) {
  const pipeline = createMessagesPipeline(opts.route, "anthropic_messages", opts.memory);
  const deps: MessagesRouteDeps = {
    auth: { resolve: async () => IDENTITY },
    transformers: {
      anthropic: {
        // Pass-through: keep messages + metadata so the route can stamp memory
        // fields onto ir.metadata and the pipeline can read them back.
        transformRequestOut: (native: unknown) => {
          const n = native as Record<string, unknown>;
          return {
            model: n.model,
            messages: n.messages,
            stream: opts.stream === true,
            metadata: {},
          };
        },
        transformResponseOut: (ir: unknown) => ({ type: "message", __ir: ir }),
        transformStreamOut: (ev: { type: string }) => ({
          event: ev.type,
          data: JSON.stringify(ev),
        }),
        transformErrorOut: (err: { message: string }) => ({
          status: 502,
          body: { type: "error", error: { message: err.message } },
        }),
      },
    },
    pipeline,
  };
  const app = createApp({ logger: { log: () => {} } });
  registerMessagesRoute(app, deps);
  return app;
}

const BODY = { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] };

// ── STEP 2 — header → IR metadata → InternalRequest metadata ─────────────────
describe("gateway.messages.memory — headers round-trip onto InternalRequest metadata", () => {
  it("stamps the four memory fields and the pipeline reads them onto the InternalRequest", async () => {
    const { route, seen } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "yo" } }] },
    });
    const app = buildApp({ route });

    const res = await app.request("/v1/messages", {
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

  it("defaults to off + null ids when no memory headers are present", async () => {
    const { route, seen } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "yo" } }] },
    });
    const app = buildApp({ route });

    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(seen[0]?.metadata).toMatchObject({
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    });
  });
});

// ── STEP 5 — observe persistence through the pipeline ────────────────────────
describe("gateway.messages.memory — observe persists request/response", () => {
  it("persists inbound (ensureThread + appendMessage) under x-memory-mode: observe", async () => {
    const { store, threads, messages } = makeFakeStore();
    const { route } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "yo" } }] },
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(threads).toEqual([{ id: "thread-1", projectId: "project-1", resourceId: "resource-1" }]);
    expect(messages.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
  });

  it("does ZERO store calls when threadId is null even with mode observe", async () => {
    const { store } = makeFakeStore();
    const { route } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "observe" }, // no x-thread-id
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it("off-mode is a pure no-op AND messages handed to route are unchanged", async () => {
    const { store } = makeFakeStore();
    const { route, seen } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(seen[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("fail-open: appendMessage rejecting does not 5xx; route still ran", async () => {
    const { store } = makeFakeStore();
    store.appendMessage.mockRejectedValue(new Error("db down"));
    const { route, seen } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] },
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("non-stream outbound: the assistant message is appended after a 200", async () => {
    const { store, messages } = makeFakeStore();
    const { route } = captureRoute({
      body: { choices: [{ index: 0, message: { role: "assistant", content: "hello back" } }] },
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(BODY),
    });

    expect(messages.some((m) => m.role === "assistant" && m.content === "hello back")).toBe(true);
  });

  it("streaming: client Anthropic bytes still flow AND the assistant text is captured", async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    async function* upstream(): AsyncIterable<string> {
      for (const f of frames) yield f;
    }
    const { store, messages } = makeFakeStore();
    const { route } = captureRoute({ stream: upstream() });
    const app = buildApp({ route, memory: { observe: observeDeps(store) }, stream: true });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify({ ...BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    // Drain the Anthropic SSE stream (its exact framing is the transformer's
    // concern; here we only need the stream to complete so observeOutbound runs).
    await res.text();
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });
});
