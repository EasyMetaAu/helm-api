import { type ApiKeyRecord, createJevDecisionsInvoker, hashKey } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { type DecisionsRouteDeps, registerDecisionsRoute } from "./decisions.js";

const body = {
  model: "~typesafe/jev-latest",
  state: "PRIVATE_SYNTHETIC_MARKER",
  questions: { q: { type: "noul", instructions: "Match?" } },
};
const upstream = {
  model: "typesafe/jev-1.13-20260917",
  answers: { q: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.000001 },
};
function setup(keyChanges: Partial<ApiKeyRecord> = {}, changes: Partial<DecisionsRouteDeps> = {}) {
  const key: ApiKeyRecord = {
    key_id: "key",
    hash: hashKey("test-key"),
    prefix: "helm_test",
    account_id: "account",
    role: "user",
    name: null,
    disabled: false,
    allowed_lanes: null,
    allow_custom_model: true,
    blocked_models: null,
    allow_fast_mode: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: 10,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "inject",
    memory_project_id: null,
    memory_thread_source: "header",
    request_content_mode: "payload",
    max_reasoning_effort: null,
    ...keyChanges,
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(upstream));
  const audit = vi.fn().mockResolvedValue({ id: "audit" });
  const settle = vi.fn().mockResolvedValue(true);
  const release = vi.fn();
  const rateCheck = vi
    .fn()
    .mockResolvedValue({ allowed: true, limit: 0, remaining: 0, resetSeconds: 0 });
  const log = vi.fn();
  const deps: DecisionsRouteDeps = {
    keyStore: { getByHash: async (hash) => (hash === key.hash ? key : null) },
    invoke: createJevDecisionsInvoker({ apiKey: () => "UPSTREAM_SECRET", fetch: fetcher }),
    rateLimiter: { check: rateCheck },
    concurrencyGate: { acquire: async () => ({ ok: true, release }) },
    budgetGate: {
      check: async () => ({
        overBudget: false,
        limitedBy: null,
        behavior: "degrade",
        degradeLane: null,
      }),
    },
    reserveRequest: settle,
    audit,
    ...changes,
  };
  const app = createApp({ logger: { log } });
  registerDecisionsRoute(app, deps);
  const send = (
    data: unknown = body,
    headers: Record<string, string> = { Authorization: "Bearer test-key" },
  ) =>
    app.request("/v1/decisions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof data === "string" ? data : JSON.stringify(data),
    });
  return { app, send, fetcher, audit, settle, release, rateCheck, log };
}

describe("POST /v1/decisions", () => {
  it("requires a valid enabled key", async () => {
    for (const changes of [{}, { disabled: true }]) {
      const t = setup(changes);
      expect((await t.send(body, changes.disabled ? undefined : {})).status).toBe(401);
      expect(t.fetcher).not.toHaveBeenCalled();
    }
  });
  it("returns version, usage and trace while retaining metadata only even for payload keys", async () => {
    const t = setup();
    const res = await t.send(body, {
      Authorization: "Bearer test-key",
      "x-trace-id": "trace-test",
      "x-session-id": "PRIVATE_SESSION",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ...upstream,
      trace_id: "trace-test",
      requested_model: body.model,
      content_retention: "none",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(t.audit).toHaveBeenCalledOnce();
    const audit = t.audit.mock.calls[0]?.[0];
    expect(audit.decision).toMatchObject({
      request_content_mode: "none",
      requested_model: body.model,
      final: { provider_model: upstream.model },
      cost_breakdown: { total_usd: upstream.usage.cost },
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(JSON.stringify([t.audit.mock.calls, t.log.mock.calls])).not.toMatch(
      /PRIVATE_|UPSTREAM_SECRET|test-key|answers|Match\?/,
    );
    expect(t.settle).toHaveBeenCalledOnce();
    expect(t.release).toHaveBeenCalledOnce();
    expect(t.rateCheck.mock.calls[0]?.[0].estimatedTokens).toBeGreaterThan(0);
  });
  it.each([
    { allow_custom_model: false },
    { blocked_models: ["typesafe/*"] },
    { blocked_models: ["typesafe/jev-1.13-20260917"] },
  ])("enforces model permissions: %j", async (caps) => {
    const t = setup(caps);
    expect((await t.send()).status).toBe(403);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { budget_tokens: 1 },
    { budget_spend_usd: 1 },
  ])("fails closed for unknown metering with caps %j", async (caps) => {
    const t = setup(caps);
    expect((await t.send()).status).toBe(422);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("rejects over-budget degrade without changing models", async () => {
    const t = setup(
      {},
      {
        budgetGate: {
          check: async () => ({
            overBudget: true,
            limitedBy: "req",
            behavior: "degrade",
            degradeLane: "economy",
          }),
        },
      },
    );
    expect((await t.send()).status).toBe(429);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("fails closed on budget store failure", async () => {
    const t = setup(
      {},
      {
        reserveRequest: async () => {
          throw new Error("PRIVATE_STORE_ERROR");
        },
      },
    );
    expect((await t.send()).status).toBe(503);
    expect(t.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("PRIVATE_STORE_ERROR");
  });
  it("enforces rate limit before provider and releases concurrency", async () => {
    const t = setup();
    t.rateCheck.mockResolvedValue({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetSeconds: 1,
      retryAfterSeconds: 2,
      limitedBy: "rpm",
    });
    expect((await t.send()).status).toBe(429);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "{",
    { ...body, provider: "evil" },
    { ...body, state: "x".repeat(32_000) },
  ])("rejects malformed or oversized input", async (data) => {
    const t = setup();
    expect([400, 413]).toContain((await t.send(data)).status);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    429, 401, 500,
  ])("redacts upstream %s errors and audits failures without content", async (status) => {
    const t = setup();
    t.fetcher.mockImplementation(async () => new Response("PRIVATE_UPSTREAM_ERROR", { status }));
    const res = await t.send();
    expect(res.status).toBe(status === 429 ? 429 : 502);
    expect(await res.text()).not.toContain("PRIVATE");
    expect(t.audit.mock.calls[0]?.[0].decision).toMatchObject({
      request_content_mode: "none",
      final: { status: "error" },
      cost_breakdown: { total_usd: null },
    });
    expect(JSON.stringify([t.audit.mock.calls, t.log.mock.calls])).not.toMatch(
      /PRIVATE_|UPSTREAM_SECRET/,
    );
    expect(t.fetcher).toHaveBeenCalledOnce();
  });
  it("aborts slow upstream requests and records unknown cost", async () => {
    const t = setup({}, { timeoutMs: 15 });
    t.fetcher.mockImplementation(
      async (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), {
            once: true,
          });
        }),
    );
    const res = await t.send();
    expect(res.status).toBe(504);
    expect(t.audit.mock.calls[0]?.[0].decision.cost_breakdown.total_usd).toBeNull();
    expect(t.release).toHaveBeenCalledOnce();
  });
  it("rejects a lost request-budget reservation before dispatch", async () => {
    const t = setup({}, { reserveRequest: async () => false });
    expect((await t.send()).status).toBe(429);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("counts actual oversized bytes despite a forged content length", async () => {
    const t = setup();
    expect(
      (
        await t.send(
          { ...body, state: "x".repeat(40_000) },
          { Authorization: "Bearer test-key", "content-length": "1" },
        )
      ).status,
    ).toBe(413);
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("cancels a stalled upload on client disconnect without provider work", async () => {
    const t = setup();
    const controller = new AbortController();
    const cancel = vi.fn();
    const req = new Request("http://localhost/v1/decisions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      body: new ReadableStream({ cancel }),
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const pending = t.app.request(req);
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      expect((await pending).status).toBe(499);
    } finally {
      clearTimeout(timer);
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(t.fetcher).not.toHaveBeenCalled();
  });
});
