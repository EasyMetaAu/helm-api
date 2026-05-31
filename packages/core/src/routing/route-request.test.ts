import { type InternalRequest, makeHelmError } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { LanesConfig } from "../lanes/schema.js";
import type { PoliciesConfig } from "./policy-schema.js";
import {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  type RouteDeps,
  routeRequest,
} from "./route-request.js";

// ── fixtures ────────────────────────────────────────────────────────────────

function req(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "write a function" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
    ...over,
  };
}

const LANES: LanesConfig = {
  economy: { primary: "cheap_model", fallback: ["balanced"], constraints: {} },
  balanced: { primary: "default_good_model", fallback: ["premium"], constraints: {} },
  premium: { primary: "best_reasoning_model", fallback: ["balanced"], constraints: {} },
  coding: { primary: "coder_a", fallback: ["coder_b", "premium"], constraints: {} },
} as unknown as LanesConfig;

const POLICIES: PoliciesConfig = {
  policies: [{ id: "coding-policy", match: { task_type: "coding" }, use_lane: "coding" }],
};

function classification(over: Partial<Classification> = {}): Classification {
  return {
    task_type: "coding",
    complexity: "complex",
    confidence: 0.9,
    decided_by: "rules",
    constraints: {},
    explanation: [],
    ...over,
  };
}

// A passing execute: succeeds on the head candidate.
function okExecute(): ExecuteOutcome {
  return {
    attempts: [
      {
        alias: "coder_a",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 12,
        cost_usd: null,
      },
    ],
    final: { status: "ok", alias: "coder_a", providerModel: "coder-a-model" },
    body: { id: "cmpl-1", choices: [] },
    stream: null,
  };
}

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    classify: vi.fn(async () => classification()),
    policies: POLICIES,
    lanes: LANES,
    execute: vi.fn(async () => okExecute()),
    now: () => new Date("2026-05-31T00:00:00Z"),
    log: vi.fn(),
    ...over,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("routeRequest — orchestration", () => {
  it("routes by lane end-to-end (non-streaming) and logs a complete decision record", async () => {
    const d = deps();
    const result = await routeRequest(req(), d);

    expect(d.classify).toHaveBeenCalledOnce();

    // execute received the coding plan with the expanded chain.
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding");
    expect(plan.explicit_model).toBeNull();
    expect(plan.candidate_chain[0]).toBe("coder_a");
    expect(plan.candidate_chain).toContain("coder_b");

    // Returned result carries the body produced by execute.
    expect(result.body).toEqual({ id: "cmpl-1", choices: [] });
    expect(result.final.status).toBe("ok");

    // A full decision record was logged: all four segments present + final.
    expect(d.log).toHaveBeenCalledOnce();
    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.request_id).toBe("req-1");
    expect(rec.classifier.task_type).toBe("coding");
    expect(rec.classifier.decided_by).toBe("rules");
    expect(rec.policy.matched_policy_id).toBe("coding-policy");
    expect(rec.lane.selected_lane).toBe("coding");
    expect(rec.lane.candidate_chain[0]).toBe("coder_a");
    expect(rec.provider_attempts).toHaveLength(1);
    expect(rec.final.status).toBe("ok");
    expect(rec.final.model_alias).toBe("coder_a");
  });

  it("passes the stream handle through unbuffered for stream:true", async () => {
    const order: string[] = [];
    async function* upstream(): AsyncGenerator<string> {
      order.push("a");
      yield "data: a\n\n";
      order.push("b");
      yield "data: b\n\n";
      order.push("done");
      yield "data: [DONE]\n\n";
    }
    const handle = upstream();
    const d = deps({
      execute: vi.fn(async () => ({
        ...okExecute(),
        body: null,
        stream: handle,
      })),
    });

    const result = await routeRequest(req({ stream: true }), d);
    // The exact same iterator instance is handed back — not drained/rebuffered.
    expect(result.stream).toBe(handle);
    // Nothing was consumed by routeRequest itself.
    expect(order).toEqual([]);

    const seen: string[] = [];
    for await (const chunk of result.stream as AsyncIterable<string>) seen.push(chunk);
    expect(seen).toEqual(["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"]);
  });

  it("explicit passthrough bypasses classify/policy/resolver when allow_custom_model is true", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "gpt-4o" }), d, {
      allowCustomModel: true,
    });

    expect(d.classify).not.toHaveBeenCalled();

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.explicit_model).toBe("gpt-4o");
    expect(plan.candidate_chain).toEqual(["gpt-4o"]);
    expect(plan.selected_lane).toBe("gpt-4o");

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.policy.matched_policy_id).toBeNull();
    expect(rec.lane.selected_lane).toBe("gpt-4o");
    expect(result.final.status).toBe("ok");
  });

  it("does NOT passthrough model='auto' even with allow_custom_model — routes normally (llm-router #391)", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "auto" }), d, {
      allowCustomModel: true,
    });

    // `auto` is the "let the router decide" sentinel: classify must run and a real
    // lane chain must be expanded — never a [`auto`] passthrough candidate.
    expect(d.classify).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.explicit_model).toBeNull();
    expect(plan.selected_lane).not.toBe("auto");
    expect(plan.candidate_chain).not.toEqual(["auto"]);
    expect(plan.candidate_chain[0]).toBe("coder_a");
    expect(result.final.status).toBe("ok");
  });

  it("does NOT passthrough when allow_custom_model is false — routes normally", async () => {
    const d = deps();
    await routeRequest(req({ requested_model: "gpt-4o" }), d, { allowCustomModel: false });

    expect(d.classify).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.explicit_model).toBeNull();
    expect(plan.selected_lane).toBe("coding");
  });

  it("fail-open: a classify throw degrades to balanced with decided_by=default", async () => {
    const d = deps({
      classify: vi.fn(async () => {
        throw new Error("classifier exploded");
      }),
    });
    const result = await routeRequest(req(), d);

    // Not a 5xx — execution still ran.
    expect(d.execute).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced");

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.classifier.decided_by).toBe("default");
    expect(rec.lane.selected_lane).toBe("balanced");
    expect(result.final.status).toBe("ok");
  });

  it("all providers failed → structured error result (not a thrown exception)", async () => {
    const failing: ExecuteOutcome = {
      attempts: [
        {
          alias: "coder_a",
          skipped: false,
          skip_reason: null,
          status: "error",
          error_class: "upstream_error",
          latency_ms: 5,
          cost_usd: null,
        },
        {
          alias: "coder_b",
          skipped: true,
          skip_reason: "circuit_open",
          status: "error",
          error_class: null,
          latency_ms: 0,
          cost_usd: null,
        },
      ],
      final: {
        status: "error",
        error: makeHelmError({
          error_class: "all_providers_failed",
          message: "all providers failed",
          trace_id: "req-1",
        }),
      },
      body: null,
      stream: null,
    };
    const d = deps({ execute: vi.fn(async () => failing) });

    const result = await routeRequest(req(), d);
    expect(result.final.status).toBe("error");
    expect(result.error?.error_class).toBe("all_providers_failed");

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.provider_attempts).toHaveLength(2);
    expect(rec.provider_attempts[1].skip_reason).toBe("circuit_open");
    expect(rec.final.status).toBe("error");
    expect(rec.final.error_reason).toBe("all_providers_failed");
  });

  it("expands fallback chains that reference other lanes, deduped and cycle-safe", async () => {
    // coding.fallback -> [coder_b, premium]; premium.fallback -> [balanced];
    // balanced.fallback -> [premium] (would cycle). Expansion must terminate.
    const d = deps();
    await routeRequest(req(), d);
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    // First element is the lane primary; chain has no duplicates.
    expect(plan.candidate_chain[0]).toBe("coder_a");
    expect(new Set(plan.candidate_chain).size).toBe(plan.candidate_chain.length);
    // premium's primary appears via the lane reference expansion.
    expect(plan.candidate_chain).toContain("best_reasoning_model");
  });

  it("populates the rich telemetry fields (latency total, fallback_count, cost split, key_prefix)", async () => {
    const d = deps({
      classify: vi.fn(async () => classification({ eval_usd: 0.00003 })),
      execute: vi.fn(
        async (): Promise<ExecuteOutcome> => ({
          attempts: [
            {
              alias: "coder_a",
              skipped: false,
              skip_reason: null,
              status: "error",
              error_class: "upstream_error",
              latency_ms: 300,
              cost_usd: null,
            },
            {
              alias: "coder_b",
              skipped: false,
              skip_reason: null,
              status: "ok",
              error_class: null,
              latency_ms: 950,
              cost_usd: 0.004,
            },
          ],
          final: { status: "ok", alias: "coder_b", providerModel: "coder-b-model" },
          body: { id: "x", choices: [] },
          stream: null,
        }),
      ),
    });
    const result = await routeRequest(req(), d, { keyPrefix: "helm_live_ab12" });
    const rec = result.decision;
    expect(rec.latency_total_ms).toBe(1250);
    expect(rec.fallback_count).toBe(1); // two served attempts -> one execution swap
    expect(rec.cost_breakdown.eval_usd).toBeCloseTo(0.00003);
    expect(rec.cost_breakdown.completion_usd).toBeCloseTo(0.004);
    expect(rec.cost_breakdown.total_usd).toBeCloseTo(0.00403);
    expect(rec.key_prefix).toBe("helm_live_ab12");
  });
});
