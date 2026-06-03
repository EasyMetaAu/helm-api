import type { ExecutionResult, ObserveDeps, RouteOptions } from "@helm/core";
import type { InternalRequest, MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createMessagesPipeline, type RouteFn } from "./messages-pipeline.js";
import { type ResponsesRouteDeps, registerResponsesRoute } from "./responses.js";

// gateway.responses.memory — PROVE the observe-phase wiring reaches /v1/responses.
// The Responses route shares the core pipeline with /v1/messages, but it must ALSO
// stamp the four memory headers onto ir.metadata before pipeline.run. Without that
// stamping the observe deps were wired (server.ts) yet never received a scope, so
// `x-memory-mode: observe` persisted nothing on this surface (CLAUDE.md principle 8
// observability gap / docs/08 Phase 1 dead on /v1/responses).

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };
const MEM_HEADERS = {
  "x-memory-mode": "observe",
  "x-thread-id": "thread-1",
  "x-resource-id": "resource-1",
  "x-project-id": "project-1",
};

// A recording fake MemoryStore (same shape observe.test.ts / messages.memory use).
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

function captureRoute(body: unknown): { route: RouteFn; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const route: RouteFn = async (req: InternalRequest, _opts: RouteOptions) => {
    seen.push(req);
    return {
      decision: { lane: { selected_lane: "balanced" } },
      final: { status: "ok" },
      body: body ?? { ok: true },
      stream: null,
      error: null,
    } as unknown as ExecutionResult;
  };
  return { route, seen };
}

// A route that returns an OpenAI SSE stream (one assistant text delta + stop). The
// pipeline parses it and feeds the Responses state machine; the streamed assistant
// text is what observeOutbound must persist in the `finally` of streamIR.
function streamingRoute(text: string): { route: RouteFn; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const route: RouteFn = async (req: InternalRequest, _opts: RouteOptions) => {
    seen.push(req);
    return {
      decision: { lane: { selected_lane: "balanced" } },
      final: { status: "ok" },
      body: null,
      stream: (async function* () {
        for (const f of frames) yield f;
      })(),
      error: null,
    } as unknown as ExecutionResult;
  };
  return { route, seen };
}

// Real pipeline (with the memory dep injected) behind the Responses route, plus a
// pass-through transformer that keeps `messages`/`metadata` so the route can stamp
// the memory scope and the pipeline can read it back — observe runs end to end.
function buildApp(opts: { route: RouteFn; memory?: { observe: ObserveDeps }; stream?: boolean }) {
  const pipeline = createMessagesPipeline(opts.route, "openai_responses", opts.memory);
  const deps: ResponsesRouteDeps = {
    auth: { resolve: async () => ({ keyId: "k1", accountId: "acct" }) },
    transformer: {
      transformRequestOut: (native: unknown) => {
        const n = native as Record<string, unknown>;
        return {
          model: typeof n.model === "string" ? n.model : "auto",
          messages: [{ role: "user", content: "hi" }],
          stream: opts.stream === true,
          metadata: {},
        };
      },
      transformResponseOut: (ir: unknown) => ({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [],
        __ir: ir,
      }),
      transformStreamOut: (event) => ({
        event: (event as { type: string }).type,
        data: JSON.stringify(event),
      }),
    },
    pipeline,
  };
  const app = createApp({ logger: { log: () => {} } });
  registerResponsesRoute(app, deps);
  return app;
}

const REQ = { model: "auto", input: "Say hello" };

describe("gateway.responses.memory — observe reaches /v1/responses", () => {
  it("persists the inbound + assistant turns under x-memory-mode: observe + x-thread-id", async () => {
    const { store, threads, messages } = makeFakeStore();
    const { route } = captureRoute({
      id: "ir-resp",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
    });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    // The memory scope reached observe via ir.metadata (the route stamping fix).
    expect(store.ensureThread).toHaveBeenCalled();
    expect(threads[0]?.id).toBe("thread-1");
    // Inbound user message + outbound assistant message both persisted to the thread.
    expect(messages.some((m) => m.threadId === "thread-1" && m.role === "user")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "hello")).toBe(true);
  });

  it("STREAMING: persists the streamed assistant turn via observeOutbound in finally", async () => {
    const { store, threads, messages } = makeFakeStore();
    const { route } = streamingRoute("hello world");
    const app = buildApp({ route, memory: { observe: observeDeps(store) }, stream: true });

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, ...MEM_HEADERS },
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Drain the stream so the streamIR `finally` (observeOutbound) actually runs.
    const text = await res.text();
    expect(text).toContain("response.completed");
    // The streamed assistant text was accumulated and persisted (the FIRST time the
    // Responses surface exercises the streaming observe path).
    expect(threads[0]?.id).toBe("thread-1");
    expect(messages.some((m) => m.threadId === "thread-1" && m.role === "user")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "hello world")).toBe(true);
  });

  it("off-mode (no memory headers) is a pure no-op: zero store touches", async () => {
    const { store } = makeFakeStore();
    const { route } = captureRoute({ id: "ir-resp", choices: [] });
    const app = buildApp({ route, memory: { observe: observeDeps(store) } });

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
  });
});
