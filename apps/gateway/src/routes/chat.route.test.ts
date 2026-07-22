import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionPlan,
  ExecutionResult,
  RouteDeps,
  TelemetryStore,
  UpsertSessionRevisionInput,
} from "@helm/core";
import { hashKey, routeRequest, UpstreamError } from "@helm/core";
import { type InternalRequest, makeHelmError } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { createWriteQueue } from "../runtime/write-queue.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

// ── auth fixtures ─────────────────────────────────────────────────────────────

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
  for (const pattern of ["/v1/*", "/chat/*", "/engines/*", "/openai/deployments/*"]) {
    app.use(pattern, authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  }
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
        error_detail: null,
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

// A key carrying budget caps so auth populates identity.caps.budget and the gate runs.
const BUDGET_RECORD: Partial<ApiKeyRecord> = {
  budget_requests: 100,
  budget_window_seconds: 60,
  over_budget_behavior: "reject",
};

describe("POST /v1/chat/completions — usage budgets + OAuth usage + eval overrides", () => {
  it("rejects an over-budget request with 429 before routing (behavior=reject)", async () => {
    const budgetGate = {
      check: vi.fn(async () => ({
        overBudget: true,
        limitedBy: "req" as const,
        behavior: "reject" as const,
        degradeLane: null,
      })),
    };
    const { deps: d, harness } = deps({ budgetGate });
    const app = buildApp(d, { record: BUDGET_RECORD });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(budgetGate.check).toHaveBeenCalledOnce();
    expect(harness.execute).not.toHaveBeenCalled(); // never routed
  });

  it("degrades an over-budget request to the degrade lane and still serves (behavior=degrade)", async () => {
    const budgetGate = {
      check: vi.fn(async () => ({
        overBudget: true,
        limitedBy: "req" as const,
        behavior: "degrade" as const,
        degradeLane: "economy",
      })),
    };
    const { deps: d, harness } = deps({ budgetGate });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d, {
      record: { ...BUDGET_RECORD, over_budget_behavior: "degrade", degrade_lane: "economy" },
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    // The degrade lane caps THIS request's lane to economy.
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("records per-account OAuth usage and settles the budget on a served request", async () => {
    const recordOAuthUsage = vi.fn();
    const settleBudget = vi.fn(async () => {});
    const { deps: d, harness } = deps({ recordOAuthUsage, settleBudget });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d, { record: BUDGET_RECORD });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
    expect(settleBudget).toHaveBeenCalledOnce();
  });

  it("a settleBudget failure is swallowed (logged, never 5xx's a served request)", async () => {
    const settleBudget = vi.fn(async () => {
      throw new Error("store down");
    });
    const { deps: d, harness } = deps({ settleBudget });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d, { record: BUDGET_RECORD });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200); // settle error is fail-open
    expect(settleBudget).toHaveBeenCalledOnce();
  });

  it("preserves the provider response model by default", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(
      nonStreamOutcome({
        id: "c",
        model: "provider-model",
        choices: [{ message: { content: "ok" } }],
      }),
    );
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "client-alias" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("provider-model");
  });

  it("can restamp the OpenAI Chat response model to the requested alias", async () => {
    const { deps: d, harness } = deps({ responseModelPolicy: "requested_alias" });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({
        id: "c",
        model: "provider-model",
        choices: [{ message: { content: "ok" } }],
      }),
    );
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "client-alias" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("client-alias");
    expect(res.headers.get("x-helm-provider-model")).toBe("gpt-x");
  });

  it("can expose both requested and provider model identities in headers", async () => {
    const { deps: d, harness } = deps({ responseModelPolicy: "both" });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({
        id: "c",
        model: "provider-model",
        choices: [{ message: { content: "ok" } }],
      }),
    );
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "client-alias" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("provider-model");
    expect(res.headers.get("x-helm-requested-model")).toBe("client-alias");
    expect(res.headers.get("x-helm-provider-model")).toBe("gpt-x");
  });

  it("can restamp streamed OpenAI Chat chunk models to the requested alias", async () => {
    const chunks = [
      'data: {"id":"c","object":"chat.completion.chunk","model":"provider-model","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { deps: d, harness } = deps({ responseModelPolicy: "requested_alias" });
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: sse(chunks),
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...STREAM_BODY, model: "client-alias" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"model":"client-alias"');
    expect(text).not.toContain('"model":"provider-model"');
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("honors the e2e x-helm-eval / x-helm-rules-threshold overrides when evalHeaderOverride is on", async () => {
    const { deps: d, harness } = deps({ evalHeaderOverride: true });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-helm-eval": "on", "x-helm-rules-threshold": "0.9" },
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    // The override is threaded into route() as the 4th arg.
    expect(harness.classify).toHaveBeenCalledOnce();
  });
});

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

  it("downgrades client-requested Fast mode when the API key disallows it", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, service_tier: "priority" }),
    });

    expect(res.status).toBe(200);
    const internal = harness.execute.mock.calls[0]?.[1] as InternalRequest;
    expect(internal.service_tier).toBe("default");
  });

  it("preserves client-requested Fast mode when the API key allows it", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d, { record: { allow_fast_mode: true } });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, service_tier: "priority" }),
    });

    expect(res.status).toBe(200);
    const internal = harness.execute.mock.calls[0]?.[1] as InternalRequest;
    expect(internal.service_tier).toBe("priority");
  });

  it("accepts the LiteLLM-compatible /chat/completions alias", async () => {
    const upstream = { id: "cmpl-1", choices: [{ message: { content: "hello" } }] };
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome(upstream));
    const app = buildApp(d);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it("uses the /engines/{model}/chat/completions path model as the effective request model", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d, { record: { allow_custom_model: true } });

    const res = await app.request("/engines/openai/gpt-4.1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "ignored-body-model" }),
    });

    expect(res.status).toBe(200);
    expect(harness.classify).not.toHaveBeenCalled();
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.candidate_chain).toEqual(["openai/gpt-4.1"]);
  });

  it("uses the Azure /openai/deployments/{model}/chat/completions path model", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d, { record: { allow_custom_model: true } });

    const res = await app.request("/openai/deployments/azure-gpt-4o/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, model: "ignored-body-model" }),
    });

    expect(res.status).toBe(200);
    expect(harness.classify).not.toHaveBeenCalled();
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.candidate_chain).toEqual(["azure-gpt-4o"]);
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

  it("emits an SSE heartbeat comment during an inter-chunk idle gap without corrupting frames", async () => {
    // A healthy-but-slow stream: a real idle gap between chunks. With a short cadence
    // the route must interleave `:\n\n` keep-alive comments and still forward the data
    // frames byte-intact (principle 8). The comment is wire-only — never a data event.
    async function* slow(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      await new Promise((r) => setTimeout(r, 60)); // idle gap > heartbeat cadence
      yield 'data: {"b":2}\n\n';
      yield "data: [DONE]\n\n";
    }
    const { deps: d, harness } = deps({ sseHeartbeatMs: () => 15 });
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: slow(),
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(":\n\n"); // at least one keep-alive comment landed
    expect(text).toContain('data: {"a":1}'); // data frames intact + uncorrupted
    expect(text).toContain('data: {"b":2}');
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
    // The beat is an SSE comment, NOT a data event — no extra `data:` frame appears.
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines.length).toBe(3); // a, b, [DONE]
  });

  it("preserves the timeout class in the terminal error frame when the stream stalls mid-flight", async () => {
    // The provider idle guard throws UpstreamError("timeout") AFTER the first
    // chunk; the route must surface that as a `timeout` frame, not a generic
    // upstream_error (Codex P3 — the classification must survive to the client).
    async function* sseThenTimeout(first: string): AsyncGenerator<string> {
      yield first;
      throw new UpstreamError("timeout", "upstream stream produced no data for 1500ms");
    }
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: sseThenTimeout('data: {"a":1}\n\n'),
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"a":1}'); // first chunk forwarded before the stall
    const errLine = text.split("\n").find((l) => l.startsWith("data: ") && l.includes('"error"'));
    expect(errLine).toBeDefined();
    const parsed = JSON.parse((errLine as string).slice("data: ".length)) as {
      error: { error_class: string };
    };
    expect(parsed.error.error_class).toBe("timeout");
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

  it("preserves LiteLLM/OpenAI request params into the execution request", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);

    const body = {
      ...NONSTREAM_BODY,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["END"],
      max_completion_tokens: 123,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "high",
      user: "user-123",
      service_tier: "auto",
      prompt_cache_key: "thread-123",
      prompt_cache_retention: "24h",
      metadata: { conversation_id: "conv-1", prompt_version: "v7" },
      web_search_options: { search_context_size: "low" },
    };

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const internal = harness.execute.mock.calls[0]?.[1] as InternalRequest;
    expect(internal.temperature).toBe(0.2);
    expect(internal.top_p).toBe(0.9);
    expect(internal.stop).toEqual(["END"]);
    expect(internal.max_completion_tokens).toBe(123);
    expect(internal.tool_choice).toBe("auto");
    expect(internal.parallel_tool_calls).toBe(false);
    expect(internal.reasoning_effort).toBe("high");
    expect(internal.user).toBe("user-123");
    expect(internal.service_tier).toBe("auto");
    expect(internal.prompt_cache_key).toBe("thread-123");
    expect(internal.prompt_cache_retention).toBe("24h");
    expect(internal.metadata.conversation_id).toBe("conv-1");
    expect(internal.provider_raw?.metadata).toEqual({
      conversation_id: "conv-1",
      prompt_version: "v7",
    });
    expect(internal.web_search_options).toEqual({ search_context_size: "low" });
  });

  it("normalizes OpenAI Chat multimodal content before the execution pipeline", async () => {
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image_url", image_url: "https://example.test/cat.png" },
              {
                type: "file",
                file: { file_data: "data:application/pdf;base64,JVBERi0=" },
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const internal = harness.execute.mock.calls[0]?.[1] as InternalRequest;
    const content = internal.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<Record<string, unknown>>;
    expect(parts[1]).toMatchObject({
      type: "image",
      url: "https://example.test/cat.png",
    });
    expect(parts[2]).toMatchObject({
      type: "document",
      data: "JVBERi0=",
      mediaType: "application/pdf",
      filename: "document.pdf",
    });
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

  it("persists an explicit x-thread-id as a scoped session revision", async () => {
    const upsertSessionRevision = vi.fn(async (_input: UpsertSessionRevisionInput) => {});
    const telemetry = {
      insert: vi.fn(async () => ({ id: "1" })),
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      upsertSessionRevision,
    } as unknown as TelemetryStore;
    const { deps: d, harness } = deps({
      telemetry,
      captureSessions: () => true,
    });
    harness.execute.mockResolvedValue(nonStreamOutcome({ ok: true }));
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-thread-id": "thread-123" },
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(res.status).toBe(200);
    expect(upsertSessionRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct",
        apiKeyId: "k1",
        source: "x-thread-id",
        externalSessionId: "thread-123",
        responseJson: JSON.stringify({ ok: true }),
      }),
    );
    const stored = (telemetry.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      decision: { session: unknown };
    };
    expect(stored.decision.session).toEqual(
      expect.objectContaining({
        ref: upsertSessionRevision.mock.calls[0]?.[0].sessionRef,
        source: "x-thread-id",
      }),
    );
    expect(stored.decision.session).not.toHaveProperty("label");
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

  it("threads per-key lane whitelist: an economy-only key routes a would-be-balanced request down to economy", async () => {
    // No policies + default classification resolve to `balanced`; the key's
    // allowed_lanes:['economy'] whitelist (the OUTER bound) must clamp the selected
    // lane to economy end-to-end, so the executor's chain starts with economy's primary.
    const { deps: d, harness } = deps();
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome({ ok: true }),
      final: { status: "ok", alias: "cheap_model", providerModel: "cheap" },
    });
    const app = buildApp(d, { record: { allowed_lanes: ["economy"] } });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });

    expect(res.status).toBe(200);
    const plan = harness.execute.mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
    expect(plan.candidate_chain[0]).toBe("cheap_model");
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

// ── full-payload capture + streamed-cost backfill (capture_payloads + #6) ─────

describe("POST /v1/chat/completions — payload capture + streamed cost", () => {
  // Telemetry double that records both the decision insert and the payload insert.
  function captureTelemetry() {
    const inserted: unknown[] = [];
    const payloads: Array<{
      requestId: string;
      requestJson: string;
      responseJson: string | null;
      upstreamRequestJson: string | null;
    }> = [];
    const telemetry = {
      insert: vi.fn(async (i: { decision: unknown }) => {
        inserted.push(i.decision);
        return { id: "1" };
      }),
      insertPayload: vi.fn(
        async (p: {
          requestId: string;
          requestJson: string;
          responseJson: string | null;
          upstreamRequestJson?: string | null;
        }) => {
          payloads.push({
            requestId: p.requestId,
            requestJson: p.requestJson,
            responseJson: p.responseJson,
            upstreamRequestJson: p.upstreamRequestJson ?? null,
          });
        },
      ),
      prunePayloads: vi.fn(async () => {}),
    } as unknown as TelemetryStore;
    return { telemetry, inserted, payloads };
  }

  it("captures the verbatim request + assembled stream and backfills cost (#6)", async () => {
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => true,
      // price 100 prompt + 50 completion tokens deterministically.
      costOf: (_alias, u) => (u.prompt_tokens ?? 0) * 1e-6 + (u.completion_tokens ?? 0) * 2e-6,
    });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n',
      "data: [DONE]\n\n",
    ];
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
    await res.text(); // drain so the stream's finally block runs

    // payload captured: request stored, response = the raw assembled SSE.
    expect(cap.payloads).toHaveLength(1);
    expect(cap.payloads[0]?.responseJson).toContain("usage");
    // cost backfilled onto the persisted decision (was null at peek time).
    const decision = cap.inserted[0] as {
      cost_breakdown: { completion_usd: number | null };
      provider_attempts: Array<{ alias: string; cost_usd: number | null }>;
    };
    expect(decision.cost_breakdown.completion_usd).toBeCloseTo(100 * 1e-6 + 50 * 2e-6);
    const okAttempt = decision.provider_attempts.find((a) => a.alias === "default_good_model");
    expect(okAttempt?.cost_usd).toBeCloseTo(100 * 1e-6 + 50 * 2e-6);
  });

  it("captures the forwarded upstream request (post inject + translation) alongside the inbound body", async () => {
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => true,
    });
    // The EXACT serialized wire body the executor captured at the provider boundary —
    // model patched + memory turn appended. Differs from the inbound body (NONSTREAM_BODY).
    const upstreamRequest = JSON.stringify({
      model: "gpt-x",
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "<system-reminder># Persistent memory</system-reminder>" },
      ],
    });
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome({ id: "cmpl-1", choices: [], usage: { completion_tokens: 1 } }),
      upstreamRequest,
    });
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(cap.payloads).toHaveLength(1);
    // Inbound body captured verbatim (no memory turn) …
    expect(cap.payloads[0]?.requestJson).not.toContain("Persistent memory");
    // … and the forwarded upstream body captured verbatim (the wire bytes) WITH memory.
    expect(cap.payloads[0]?.upstreamRequestJson).toBe(upstreamRequest);
  });

  it("backfills streamed cost even when capture_payloads is OFF (#6 ungated)", async () => {
    // Regression: cost telemetry must not depend on full-body capture. With
    // capture off, NO payload is stored, but the trailing usage chunk is still
    // parsed and the completion cost is backfilled onto the persisted decision.
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => false,
      costOf: (_alias, u) => (u.prompt_tokens ?? 0) * 1e-6 + (u.completion_tokens ?? 0) * 2e-6,
    });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n',
      "data: [DONE]\n\n",
    ];
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
    await res.text(); // drain so the stream's finally block runs

    expect(cap.payloads).toHaveLength(0); // capture off → nothing stored
    const decision = cap.inserted[0] as { cost_breakdown: { completion_usd: number | null } };
    expect(decision.cost_breakdown.completion_usd).toBeCloseTo(100 * 1e-6 + 50 * 2e-6);
  });

  it("prefers an upstream-billed cost in the stream usage chunk over the estimate", async () => {
    // The relay billed back a cost in usage.cost_usd; resolveCostUsd (via the real
    // server costOf) must OVERRIDE the token-estimate. Here costOf is the real
    // resolveCostUsd-backed shape: it returns the billed cost when present.
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => false,
      // Mirror the composition-root costOf: billed cost wins, else token estimate.
      costOf: (_alias, u) =>
        typeof u.cost_usd === "number"
          ? u.cost_usd
          : (u.prompt_tokens ?? 0) * 1e-6 + (u.completion_tokens ?? 0) * 2e-6,
    });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"cost_usd":0.42}}\n\n',
      "data: [DONE]\n\n",
    ];
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
    await res.text();
    const decision = cap.inserted[0] as { cost_breakdown: { completion_usd: number | null } };
    expect(decision.cost_breakdown.completion_usd).toBe(0.42); // billed, not 0.0002
  });

  it("does NOT capture when capture_payloads is off", async () => {
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => false,
    });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "x", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...NONSTREAM_BODY, reasoning_effort: "high" }),
    });
    expect(cap.payloads).toHaveLength(0);
    expect(cap.telemetry.insert).toHaveBeenCalled(); // decision still persisted
    expect((cap.inserted[0] as { reasoning_effort?: string }).reasoning_effort).toBe("high");
  });

  it("captures the non-stream response body verbatim when enabled", async () => {
    const cap = captureTelemetry();
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      capturePayloads: () => true,
    });
    const upstream = { id: "cmpl-9", choices: [{ message: { content: "hello" } }] };
    harness.execute.mockResolvedValue(nonStreamOutcome(upstream));
    const app = buildApp(d);
    const rawRequest = '{\n  "model":"auto",\n  "messages":[{"role":"user","content":"hi"}]\n}';
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: rawRequest,
    });
    expect(cap.payloads).toHaveLength(1);
    expect(cap.payloads[0]?.requestJson).toBe(rawRequest);
    expect(cap.payloads[0]?.responseJson).toBe(JSON.stringify(upstream));
  });
});

// ── deferred write queue (perf): writes leave the response's critical path ─────
describe("POST /v1/chat/completions — deferred write queue", () => {
  function captureTelemetry() {
    const inserted: unknown[] = [];
    const payloads: Array<{ requestId: string; responseJson: string | null }> = [];
    const telemetry = {
      insert: vi.fn(async (i: { decision: unknown }) => {
        inserted.push(i.decision);
        return { id: "1" };
      }),
      insertPayload: vi.fn(async (p: { requestId: string; responseJson: string | null }) => {
        payloads.push({ requestId: p.requestId, responseJson: p.responseJson });
      }),
      prunePayloads: vi.fn(async () => {}),
    } as unknown as TelemetryStore;
    return { telemetry, inserted, payloads };
  }

  it("defers telemetry + payload off the response, then writes them on flush", async () => {
    const cap = captureTelemetry();
    const q = createWriteQueue({
      telemetry: cap.telemetry,
      log: () => {},
      flushIntervalMs: 10_000,
    });
    const { deps: d, harness } = deps({
      telemetry: cap.telemetry,
      writes: q,
      capturePayloads: () => true,
      costOf: () => 0,
    });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    // The response has already returned — nothing has hit the store yet.
    expect(cap.inserted).toHaveLength(0);
    expect(cap.payloads).toHaveLength(0);

    await q.flush();
    expect(cap.inserted).toHaveLength(1);
    expect(cap.payloads).toHaveLength(1);
  });

  it("a failing deferred write never affects the served response (fail-open)", async () => {
    const cap = captureTelemetry();
    (cap.telemetry.insert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const q = createWriteQueue({
      telemetry: cap.telemetry,
      log: () => {},
      flushIntervalMs: 10_000,
    });
    const { deps: d, harness } = deps({ telemetry: cap.telemetry, writes: q });
    harness.execute.mockResolvedValue(
      nonStreamOutcome({ id: "c", choices: [{ message: { content: "ok" } }] }),
    );
    const app = buildApp(d);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(NONSTREAM_BODY),
    });
    expect(res.status).toBe(200);
    await expect(q.flush()).resolves.toBeUndefined();
  });
});

describe("POST /v1/chat/completions — restamp model flush + malformed JSON branch", () => {
  it("restamp flush() outputs the tail when a stream ends mid-frame (no trailing \\n\\n)", async () => {
    // The model restamper buffers chunks split by \n\n. A chunk without a trailing \n\n
    // lands in `pending`; `flush()` outputs it (lines 191-193, 808-813).
    const tailChunk =
      'data: {"id":"c","model":"provider-model","object":"chat.completion.chunk","choices":[]}\n';
    // No trailing \n\n → this stays in `pending` until flush()
    const { deps: d, harness } = deps({ responseModelPolicy: "requested_alias" });
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: sse([tailChunk]),
    });
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...STREAM_BODY, model: "client-alias" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The flush should have output the tail with the model rewritten
    expect(text).toContain('"model":"client-alias"');
  });

  it("restamp skips malformed JSON in a data line (catch branch, lines 157-158)", async () => {
    // A chunk whose data field is not valid JSON → JSON.parse throws → return line verbatim
    const chunks = ["data: {not valid json}\n\n", "data: [DONE]\n\n"];
    const { deps: d, harness } = deps({ responseModelPolicy: "requested_alias" });
    harness.execute.mockResolvedValue({
      ...nonStreamOutcome(null),
      body: null,
      stream: sse(chunks),
    });
    const app = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...STREAM_BODY, model: "client-alias" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Malformed JSON line is passed through verbatim (not crashing the stream)
    expect(text).toContain("{not valid json}");
  });
});

export type { ExecutionResult };
