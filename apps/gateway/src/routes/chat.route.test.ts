import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionPlan,
  ExecutionResult,
  RouteDeps,
  TelemetryStore,
} from "@helm/core";
import { hashKey, routeRequest } from "@helm/core";
import { type InternalRequest, makeHelmError } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

// ── auth fixtures ─────────────────────────────────────────────────────────────

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
    ...over,
  };
}

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

// ── route deps: a real routeRequest bound to mocked classify/execute ──────────

const LANES = {
  economy: { primary: "cheap_model", fallback: ["balanced"], constraints: {} },
  balanced: { primary: "default_good_model", fallback: ["premium"], constraints: {} },
  premium: { primary: "best_reasoning_model", fallback: ["balanced"], constraints: {} },
} as unknown as RouteDeps["lanes"];

const POLICIES = { policies: [] } as unknown as RouteDeps["policies"];

interface RouteHarness {
  classify: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function routeDeps(harness: RouteHarness): RouteDeps {
  return {
    classify: harness.classify,
    policies: POLICIES,
    lanes: LANES,
    execute: harness.execute,
    now: () => new Date("2026-05-31T00:00:00Z"),
    log: harness.log,
  };
}

function okClassification() {
  return {
    task_type: "general",
    complexity: "medium" as const,
    confidence: 0.7,
    decided_by: "rules" as const,
    constraints: {},
    explanation: [],
  };
}

function deps(
  over: Partial<ChatRouteDeps> = {},
  harness?: Partial<RouteHarness>,
): {
  deps: ChatRouteDeps;
  harness: RouteHarness;
} {
  const h: RouteHarness = {
    classify: vi.fn(async () => okClassification()),
    execute: vi.fn(),
    log: vi.fn(),
    ...harness,
  };
  const d: ChatRouteDeps = {
    route: (req: InternalRequest, opts, _signal: AbortSignal) =>
      routeRequest(req, routeDeps(h), opts),
    telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as unknown as TelemetryStore,
    redact: (x: unknown) => x,
    now: () => 1000,
    ...over,
  };
  return { deps: d, harness: h };
}

function buildApp(
  d: ChatRouteDeps,
  opts: { record?: Partial<ApiKeyRecord>; authed?: boolean } = {},
) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi
    .fn()
    .mockResolvedValue(opts.authed === false ? null : keyRecord(opts.record ?? {}));
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

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
      },
    ],
    final: { status: "ok", alias: "default_good_model", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

async function* sse(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

const NONSTREAM_BODY = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};
const STREAM_BODY = { ...NONSTREAM_BODY, stream: true };

describe("POST /v1/chat/completions (routing pipeline)", () => {
  it("routes a non-stream request through the pipeline and returns the OpenAI body", async () => {
    const upstream = { id: "cmpl-1", choices: [{ message: { content: "hello" } }] };
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome(upstream));
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
    // Proof it went through the pipeline (not a constant passthrough).
    expect(harness.classify).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledOnce();
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced");
    expect(harness.log).toHaveBeenCalledOnce();
  });

  it("keeps SSE end-to-end for stream:true and ends with [DONE]", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: sse(chunks),
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    for (const ch of chunks) expect(text).toContain(ch.trim());
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("does NOT bypass the pipeline (Phase 0 passthrough is gone)", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    // The route MUST consult the classifier + executor — never a constant reply.
    expect(harness.classify).toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalled();
  });

  it("takes the explicit-model passthrough when the key allows custom models", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome({ ok: true }),
      final: { status: "ok", alias: "gpt-4o", providerModel: "gpt-4o" },
    });
    const app = buildApp(d, { record: { allow_custom_model: true } });

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "gpt-4o" }),
    });

    // Passthrough: classifier is skipped, chain is exactly the explicit model.
    expect(harness.classify).not.toHaveBeenCalled();
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.candidate_chain).toEqual(["gpt-4o"]);
  });

  it("maps all_providers_failed to a structured 502 error", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue({
      attempts: [],
      final: {
        status: "error",
        error: makeHelmError({
          error_class: "all_providers_failed",
          message: "all failed",
          trace_id: "t",
        }),
      },
      body: null,
      stream: null,
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });

  it("persists a redacted telemetry record and never leaks the plaintext key", async () => {
    const redact = vi.fn((x: unknown) => x);
    const { deps: d, harness } = deps({ redact });
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(redact).toHaveBeenCalled();
    expect(d.telemetry.insert).toHaveBeenCalledOnce();
    const arg = (d.telemetry.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg.apiKeyId).toBe("k1");
    expect(JSON.stringify(arg)).not.toContain("helm_live_secret");
  });

  it("rejects unauthenticated requests without routing", async () => {
    const { deps: d, harness } = deps();
    const app = buildApp(d, { authed: false });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(401);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  // ── Input validation (docs/07: invalid_request → 400, fail-closed BEFORE routing).
  //    A malformed body or an obviously-invalid request must never reach the
  //    classifier/executor — it is a client error (400), not an upstream 5xx, and
  //    must not burn a provider fallback chain (cost + latency).
  it("rejects a malformed JSON body with 400 invalid_request and never routes", async () => {
    const { deps: d, harness } = deps();
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.type).toBe("invalid_request_error");
    expect(harness.classify).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("rejects an empty messages array with 400 before burning the fallback chain", async () => {
    const { deps: d, harness } = deps();
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "auto", messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("rejects a missing messages field with 400", async () => {
    const { deps: d, harness } = deps();
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "auto" }),
    });
    expect(res.status).toBe(400);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("a stream client disconnect does not break the response (no provider fault)", async () => {
    // The execute() layer already records abort; the route must not 5xx mid-stream.
    const { deps: d, harness } = deps();
    async function* aborting(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: aborting(),
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"a":1');
    // Telemetry still persisted once for the request.
    expect(d.telemetry.insert).toHaveBeenCalled();
  });
});

export type { ExecutionResult };
