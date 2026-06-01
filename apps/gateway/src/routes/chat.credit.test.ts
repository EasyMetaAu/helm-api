import type { ApiKeyRecord, ExecuteOutcome, RouteDeps } from "@helm/core";
import { hashKey, routeRequest } from "@helm/core";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

// Issue #37 Step 10 — the OpenAI /v1/chat route debits the account credit ledger
// AFTER serving, inside the SAME fail-open envelope as telemetry. The debit uses
// the settled cost_breakdown.total_usd (never recomputed) and a debit FAILURE must
// never turn a served 200 into a 5xx.

function keyRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct_default",
    role: "user",
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    ...over,
  };
}

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

const LANES = {
  balanced: { primary: "default_good_model", fallback: [], constraints: {} },
} as unknown as RouteDeps["lanes"];
const POLICIES = { policies: [] } as unknown as RouteDeps["policies"];

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
        cost_usd: 0.0042,
        error_detail: null,
      },
    ],
    final: { status: "ok", alias: "default_good_model", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

function buildApp(over: Partial<ChatRouteDeps>) {
  const execute = vi.fn(async () =>
    nonStreamOutcome({ id: "cmpl-1", choices: [{ message: { content: "hi" } }] }),
  );
  const d: ChatRouteDeps = {
    route: (req: InternalRequest, opts, _signal: AbortSignal) =>
      routeRequest(
        req,
        {
          classify: async () => okClassification(),
          policies: POLICIES,
          lanes: LANES,
          execute,
          now: () => new Date("2026-05-31T00:00:00Z"),
          log: () => {},
        } as unknown as RouteDeps,
        opts,
      ),
    telemetry: {
      insert: vi.fn().mockResolvedValue({ id: "1" }),
    } as unknown as ChatRouteDeps["telemetry"],
    redact: (x: unknown) => x,
    now: () => 1000,
    ...over,
  };
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

const BODY = JSON.stringify({
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
});

describe("POST /v1/chat/completions — credit debit (Issue #37)", () => {
  it("debits the served account with the settled total_usd + key_id", async () => {
    const creditDebit = vi.fn<NonNullable<ChatRouteDeps["creditDebit"]>>(async () => {});
    const app = buildApp({ creditDebit });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(creditDebit).toHaveBeenCalledOnce();
    const call = creditDebit.mock.calls[0];
    if (call === undefined) throw new Error("creditDebit not called");
    const [decision, accountId, apiKeyId] = call;
    expect(accountId).toBe("acct_default");
    expect(apiKeyId).toBe("k1"); // key_id only (principle 7)
    expect(decision.cost_breakdown.total_usd).toBeCloseTo(0.0042);
  });

  it("a debit failure does NOT turn a served 200 into a 5xx (fail-open)", async () => {
    const creditDebit = vi.fn(async () => {
      throw new Error("credit store down");
    });
    const app = buildApp({ creditDebit });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(creditDebit).toHaveBeenCalledOnce();
  });

  it("no creditDebit dep wired → request still served (billing optional)", async () => {
    const app = buildApp({});
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: BODY,
    });
    expect(res.status).toBe(200);
  });
});
