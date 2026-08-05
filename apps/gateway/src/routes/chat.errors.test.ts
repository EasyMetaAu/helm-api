import type {
  ApiKeyRecord,
  ExecutionResult,
  InjectDeps,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { hashKey } from "@helm/core";
import type { InternalRequest, MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { makeHelmError } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { createWriteQueue } from "../runtime/write-queue.js";
import { type ChatRouteDeps, type InjectWiring, registerChatRoutes } from "./chat.js";

// Supplemental error/edge coverage for POST /v1/chat/completions. Uses a fully
// STUBBED `route` (the ChatRouteDeps.route seam) so the DecisionRecord +
// ExecutionResult can be shaped precisely to drive the route's translate-back
// branches the heavyweight routeRequest harness leaves open: the classification
// debug headers (eval_cache_hit / fallback_reason / final-model), the
// all-providers-failed-with-null-error synthesis, the null-body error throw, an
// inline telemetry-insert failure (fail-open log), and the memory observeOutbound
// tool-role + malformed-SSE-frame helper branches. All pure HTTP glue (principle 1).

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
const BODY = { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false };
const STREAM_BODY = { ...BODY, stream: true };

// A DecisionRecord stand-in. `classifier` + `final` are overridable so a test can
// drive the classification-header branches. cost_breakdown is read by the settle/
// backfill helpers (null is the "not measured" sentinel).
function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: { selected_lane: "balanced" },
    final: { status: "ok", model_alias: "default_good_model", provider_model: "gpt-x" },
    classifier: { decided_by: "rules", eval_cache_hit: null, fallback_reason: null },
    cost_breakdown: { total_usd: null, completion_usd: null },
    ...over,
  };
}

interface RouteOver {
  body?: unknown;
  /** When true, the result body is explicitly null (a degraded core) — distinct
   *  from "body omitted" which defaults to a benign success body. */
  nullBody?: boolean;
  stream?: AsyncIterable<string> | null;
  finalStatus?: "ok" | "error";
  error?: unknown;
  decisionOver?: Record<string, unknown>;
  memory?: ChatRouteDeps["memory"];
  telemetryInsert?: ReturnType<typeof vi.fn>;
}

function stubRouteDeps(
  over: RouteOver & {
    evalHeaderOverride?: boolean;
    writes?: ChatRouteDeps["writes"];
    capturePayloads?: ChatRouteDeps["capturePayloads"];
  } = {},
): {
  deps: ChatRouteDeps;
  seen: InternalRequest[];
  classifyOverrides: Array<{ evalEnabled?: boolean; rulesThreshold?: number } | undefined>;
} {
  const seen: InternalRequest[] = [];
  const classifyOverrides: Array<{ evalEnabled?: boolean; rulesThreshold?: number } | undefined> =
    [];
  const insert = over.telemetryInsert ?? vi.fn().mockResolvedValue({ id: "1" });
  const resolvedBody = over.stream || over.nullBody ? null : (over.body ?? { ok: true });
  const deps: ChatRouteDeps = {
    route: async (
      req: InternalRequest,
      _opts: RouteOptions,
      _signal: AbortSignal,
      overrides?: { evalEnabled?: boolean; rulesThreshold?: number },
    ): Promise<ExecutionResult> => {
      seen.push(req);
      classifyOverrides.push(overrides);
      return {
        decision: decision(over.decisionOver),
        final: { status: over.finalStatus ?? "ok" },
        body: resolvedBody,
        stream: over.stream ?? null,
        error: over.error ?? null,
      } as unknown as ExecutionResult;
    },
    telemetry: { insert } as unknown as TelemetryStore,
    redact: (x: unknown) => x,
    now: () => 1000,
    ...(over.memory ? { memory: over.memory } : {}),
    ...(over.evalHeaderOverride ? { evalHeaderOverride: true } : {}),
    ...(over.writes ? { writes: over.writes } : {}),
    ...(over.capturePayloads ? { capturePayloads: over.capturePayloads } : {}),
  };
  return { deps, seen, classifyOverrides };
}

function buildApp(d: ChatRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

// Recording fake MemoryStore (mirrors chat.memory.test.ts) so observeOutbound has
// somewhere to persist the reconstructed assistant/tool turn.
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

async function* sse(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

describe("chat route — classification debug headers", () => {
  it("emits x-helm-final-model / x-helm-provider-model on a successful response", async () => {
    const { deps } = stubRouteDeps({ body: { choices: [{ message: { content: "ok" } }] } });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-helm-lane")).toBe("balanced");
    expect(res.headers.get("x-helm-final-model")).toBe("default_good_model");
    expect(res.headers.get("x-helm-provider-model")).toBe("gpt-x");
    expect(res.headers.get("x-helm-decided-by")).toBe("rules");
  });

  it("emits x-helm-eval-cache-hit and x-helm-fallback-reason when the cascade set them", async () => {
    const { deps } = stubRouteDeps({
      body: { choices: [{ message: { content: "ok" } }] },
      decisionOver: {
        classifier: {
          decided_by: "eval",
          eval_cache_hit: true,
          fallback_reason: "eval_disabled",
        },
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-helm-decided-by")).toBe("eval");
    expect(res.headers.get("x-helm-eval-cache-hit")).toBe("true");
    expect(res.headers.get("x-helm-fallback-reason")).toBe("eval_disabled");
  });
});

describe("chat route — error result surfacing", () => {
  it("maps a structured error result (final.status=error) to its HelmError envelope", async () => {
    const { deps } = stubRouteDeps({
      finalStatus: "error",
      nullBody: true,
      error: makeHelmError({
        error_class: "all_providers_failed",
        message: "every provider failed",
        trace_id: "t-1",
      }),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("all_providers_failed");
    expect(body.error.message).toContain("every provider failed");
  });

  it("synthesizes an all_providers_failed error when the result has a null body and no error", async () => {
    // final.status === "error" with result.error null exercises the `?? makeHelmError`
    // synthesis fallback (a degraded core that returned neither body nor error).
    const { deps } = stubRouteDeps({ finalStatus: "error", nullBody: true, error: null });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });

  it("synthesizes an error when final.status is ok but the body is null", async () => {
    // The `|| result.body === null` arm: a degraded ok result with no body must
    // still surface a structured error rather than a 200 with an empty body.
    const { deps } = stubRouteDeps({ finalStatus: "ok", nullBody: true, error: null });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });
});

describe("chat route — telemetry fail-open", () => {
  it("still returns 200 when the inline telemetry insert rejects (fail-open log)", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("db down"));
    const { deps } = stubRouteDeps({
      body: { choices: [{ message: { content: "ok" } }] },
      telemetryInsert: insert,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    // A telemetry failure must never turn a served request into a 5xx (principle 3).
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
  });
});

describe("chat route — memory observeOutbound helper branches", () => {
  it("persists a tool-role message from the non-stream OpenAI body (outboundFromOpenAIBody)", async () => {
    const { store, messages } = makeFakeStore();
    const { deps } = stubRouteDeps({
      memory: { observe: observeDeps(store) },
      // A choices array with BOTH an assistant turn (with tool_calls) and a tool
      // result message exercises the tool-role push branch.
      body: {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
              ],
            },
          },
          { index: 1, message: { role: "tool", content: "tool output", tool_call_id: "call_1" } },
        ],
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        ...AUTH,
        "x-memory-mode": "observe",
        "x-thread-id": "thread-1",
        "x-resource-id": "resource-1",
        "x-project-id": "project-1",
      },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    // The tool result rode through observeOutbound's tool-role branch.
    expect(messages.some((m) => m.role === "tool" && m.content === "tool output")).toBe(true);
  });

  it("reconstructs assistant text across split SSE frames incl. a malformed frame and a trailing partial", async () => {
    const { store, messages } = makeFakeStore();
    // Frames: a clean delta, a MALFORMED data frame (JSON.parse throws → swallowed),
    // then a final delta WITHOUT a trailing \n\n so the flush path runs.
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      "data: {not json}\n\n",
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
    ];
    const { deps } = stubRouteDeps({
      memory: { observe: observeDeps(store) },
      stream: sse(chunks),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "observe", "x-thread-id": "thread-1" },
      body: JSON.stringify(STREAM_BODY),
    });

    expect(res.status).toBe(200);
    await res.text();
    // The malformed frame was skipped; the clean deltas (incl. the un-terminated
    // trailing one flushed at stream end) reconstruct "Hello".
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });
});

describe("chat route — e2e eval header overrides", () => {
  it("resolves evalEnabled=undefined and rulesThreshold=undefined when the headers are absent", async () => {
    const { deps, classifyOverrides } = stubRouteDeps({
      evalHeaderOverride: true,
      body: { choices: [{ message: { content: "ok" } }] },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    // evalHeaderOverride is ON but no headers → both knobs resolve to undefined.
    expect(classifyOverrides[0]).toEqual({ evalEnabled: undefined, rulesThreshold: undefined });
  });

  it("turns eval OFF and ignores a non-numeric rules threshold (NaN → undefined)", async () => {
    const { deps, classifyOverrides } = stubRouteDeps({
      evalHeaderOverride: true,
      body: { choices: [{ message: { content: "ok" } }] },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-helm-eval": "off", "x-helm-rules-threshold": "not-a-number" },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    // "off" → false; a non-finite threshold → undefined (the config default holds).
    expect(classifyOverrides[0]).toEqual({ evalEnabled: false, rulesThreshold: undefined });
  });

  it("parses a numeric rules threshold and a truthy eval flag", async () => {
    const { deps, classifyOverrides } = stubRouteDeps({
      evalHeaderOverride: true,
      body: { choices: [{ message: { content: "ok" } }] },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-helm-eval": "1", "x-helm-rules-threshold": "0.75" },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(classifyOverrides[0]).toEqual({ evalEnabled: true, rulesThreshold: 0.75 });
  });
});

describe("chat route — deferred observe writes (write queue)", () => {
  it("enqueues observeInbound/outbound onto the write queue instead of awaiting inline", async () => {
    const { store, messages } = makeFakeStore();
    const q = createWriteQueue({
      telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as unknown as TelemetryStore,
      log: () => {},
      flushIntervalMs: 10_000,
    });
    const { deps } = stubRouteDeps({
      writes: q,
      memory: { observe: observeDeps(store) },
      body: { choices: [{ index: 0, message: { role: "assistant", content: "queued reply" } }] },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-memory-mode": "observe", "x-thread-id": "thread-q" },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);

    await q.flush();
    // The deferred (enqueued) observe path ran: the FIFO tasks persisted the
    // inbound user turn and the outbound assistant turn via the write queue.
    expect(messages.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "queued reply")).toBe(true);
  });
});

function injectWiring(store: ReturnType<typeof makeFakeStore>["store"]): InjectWiring {
  const deps: InjectDeps = {
    memoryStore: store as unknown as InjectDeps["memoryStore"],
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    enqueueObserverJob: async () => "job-x",
    costSink: vi.fn(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: vi.fn(),
  };
  return { deps, tokenBudget: 4000 };
}

describe("chat route — inject scope spread (project + resource + thread ids)", () => {
  it("builds the inject scope with all three memory ids when every header is present", async () => {
    // listMessages returns one stored turn so the assembler has something to fold
    // into the trailing reminder — this drives the projectId/resourceId/threadId
    // spread arms of the inject scope object (all three non-null).
    const { store } = makeFakeStore();
    store.listMessages = vi.fn(async () => [
      {
        id: "m1",
        role: "user",
        content: "earlier turn",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        tokenEstimate: 3,
      },
    ]) as never;
    const { deps } = stubRouteDeps({
      memory: { observe: observeDeps(store), inject: injectWiring(store) },
      body: { choices: [{ index: 0, message: { role: "assistant", content: "reply" } }] },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        ...AUTH,
        "x-memory-mode": "inject",
        "x-thread-id": "thread-1",
        "x-resource-id": "resource-1",
        "x-project-id": "project-1",
      },
      body: JSON.stringify(BODY),
    });

    // Inject is fully fail-open and additive — the request still succeeds (200) and
    // the route exercised the three-id inject scope spread without throwing.
    expect(res.status).toBe(200);
  });
});
