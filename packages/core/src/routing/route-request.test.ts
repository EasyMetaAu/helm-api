import { type InternalRequest, makeHelmError, type RoutingSignal } from "@helm/shared";
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

function routingSignal(over: Partial<RoutingSignal> = {}): RoutingSignal {
  return {
    taskType: "general",
    lane: "balanced",
    windowStart: 1,
    windowEnd: 2,
    samples: 100,
    successRate: 0.95,
    fallbackRate: 0.02,
    classifierFallbackRate: 0,
    errorRate: 0.03,
    p50LatencyMs: 100,
    p95LatencyMs: 200,
    avgCostUsd: 0.001,
    updatedAt: 2,
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
        error_detail: null,
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

  it("forwards the executor's upstreamRequest onto the ExecutionResult (ok branch)", async () => {
    // The EXACT serialized wire body the provider captured (a string), forwarded verbatim.
    const upstreamRequest = JSON.stringify({
      model: "coder-a-model",
      messages: [{ role: "user", content: "hi" }],
    });
    const d = deps({ execute: vi.fn(async () => ({ ...okExecute(), upstreamRequest })) });
    const result = await routeRequest(req(), d);
    expect(result.final.status).toBe("ok");
    expect(result.upstreamRequest).toBe(upstreamRequest);
  });

  it("ignores a spoofed x-project-id (memory scope) for routing — a project_id policy does NOT match", async () => {
    // A client sets x-project-id to a value a server-side project_id policy targets.
    // The memory header rides metadata.project_id, but routing must NOT trust it
    // (docs/08: memory must not rewrite routing) — policyContext.project_id is
    // sourced trusted (null), so the policy cannot fire. Pre-fix this pinned premium.
    const d = deps({
      policies: {
        policies: [{ id: "proj-spoof", match: { project_id: "proj_secret" }, use_lane: "premium" }],
      },
    });
    const result = await routeRequest(
      req({
        metadata: {
          conversation_id: null,
          thread_id: "th_1",
          resource_id: null,
          project_id: "proj_secret",
          memory_mode: "observe",
        },
      }),
      d,
    );

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.policy.matched_policy_id).toBeNull();
    expect(rec.lane.selected_lane).not.toBe("premium");
    expect(result.final.status).toBe("ok");
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
          error_detail: null,
        },
        {
          alias: "coder_b",
          skipped: true,
          skip_reason: "circuit_open",
          status: "error",
          error_class: null,
          latency_ms: 0,
          cost_usd: null,
          error_detail: null,
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

  it("keyCaps clamp a premium policy/lane result down to the key's whitelist (OUTER bound, wins over use_lane pin)", async () => {
    // A policy pins `premium`, but the key's whitelist permits only `economy`.
    // Key caps are the non-negotiable outer bound and must win.
    const d = deps({
      classify: vi.fn(async () => classification({ task_type: "chat" })),
      policies: { policies: [{ id: "pin-premium", match: {}, use_lane: "premium" }] },
    });
    await routeRequest(req(), d, { keyCaps: { allowedLanes: ["economy"] } });

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("keyCaps allowedLanes narrows the resolved lane to the permitted set", async () => {
    const d = deps({
      classify: vi.fn(async () => classification({ task_type: "chat" })),
      policies: { policies: [{ id: "pin-premium", match: {}, use_lane: "premium" }] },
    });
    await routeRequest(req(), d, {
      keyCaps: { allowedLanes: ["economy", "balanced"] },
    });

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    // premium not allowed -> highest allowed <= premium = balanced.
    expect(plan.selected_lane).toBe("balanced");
  });

  it("keyCaps.degradeLane forces an over-budget request onto the degrade lane", async () => {
    // A policy pins `premium`; the key is over budget so the gateway sets
    // degradeLane=economy for this request — it is FORCED onto economy.
    const d = deps({
      classify: vi.fn(async () => classification({ task_type: "chat" })),
      policies: { policies: [{ id: "pin-premium", match: {}, use_lane: "premium" }] },
    });
    await routeRequest(req(), d, { keyCaps: { allowedLanes: null, degradeLane: "economy" } });

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("keyCaps.degradeLane forces even an UNRANKED task lane (a ceiling would no-op)", async () => {
    // Degrade target is the unranked `coding` lane: a rank-based ceiling would do
    // nothing, but a forced selection routes the request onto it.
    const d = deps({
      classify: vi.fn(async () => classification({ task_type: "chat" })),
      policies: { policies: [{ id: "pin-premium", match: {}, use_lane: "premium" }] },
    });
    await routeRequest(req(), d, { keyCaps: { allowedLanes: null, degradeLane: "coding" } });
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding");
  });

  it("keyCaps.degradeLane overrides explicit-model passthrough (no expensive-model bypass)", async () => {
    // An allow_custom_model key naming an explicit model is normally passed through
    // verbatim; over budget (degradeLane set) the passthrough is suppressed and the
    // request is forced onto the degrade lane instead.
    const d = deps();
    const result = await routeRequest(req({ requested_model: "gpt-4o" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: null, degradeLane: "economy" },
    });
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.explicit_model).toBeNull(); // NOT a [gpt-4o] passthrough chain
    expect(plan.selected_lane).toBe("economy");
    expect(result.decision.lane.selected_lane).toBe("economy");
  });

  it("keyCaps.degradeLane null is a no-op (within budget => requested lane preserved)", async () => {
    const d = deps({
      classify: vi.fn(async () => classification({ task_type: "chat" })),
      policies: { policies: [{ id: "pin-premium", match: {}, use_lane: "premium" }] },
    });
    await routeRequest(req(), d, { keyCaps: { allowedLanes: null, degradeLane: null } });
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
  });

  it("keyCaps undefined is a no-op (existing callers unaffected)", async () => {
    const d = deps();
    await routeRequest(req(), d);
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding");
  });

  it("signal feedback promotes a degraded ranked lane to a healthier stronger lane", async () => {
    const getSignal = vi.fn(async (taskType: string, lane: string) => {
      if (taskType !== "general") return null;
      if (lane === "balanced") {
        return routingSignal({
          taskType,
          lane,
          successRate: 0.45,
          fallbackRate: 0.7,
          errorRate: 0.55,
        });
      }
      if (lane === "premium") {
        return routingSignal({
          taskType,
          lane,
          successRate: 0.94,
          fallbackRate: 0.03,
          errorRate: 0.02,
        });
      }
      return null;
    });
    const d = deps({
      classify: vi.fn(async () =>
        classification({ task_type: "general", complexity: "medium", constraints: {} }),
      ),
      policies: { policies: [] },
      signalFeedback: {
        enabled: true,
        minSamples: 20,
        getSignal,
      },
    });

    const result = await routeRequest(req(), d);

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
    expect(plan.candidate_chain[0]).toBe("best_reasoning_model");
    expect(result.decision.lane.selected_lane).toBe("premium");
    expect(result.decision.classifier.explanation).toContainEqual(
      expect.objectContaining({
        kind: "routing_signal_feedback",
        from_lane: "balanced",
        to_lane: "premium",
      }),
    );
    expect(getSignal).toHaveBeenCalledWith("general", "balanced");
    expect(getSignal).toHaveBeenCalledWith("general", "premium");
  });

  it("signal feedback stays fail-open when the signal store read fails", async () => {
    const d = deps({
      classify: vi.fn(async () =>
        classification({ task_type: "general", complexity: "medium", constraints: {} }),
      ),
      policies: { policies: [] },
      signalFeedback: {
        enabled: true,
        getSignal: vi.fn(async () => {
          throw new Error("signal store unavailable");
        }),
      },
    });

    const result = await routeRequest(req(), d);

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced");
    expect(result.final.status).toBe("ok");
  });

  it("signal feedback respects key allowedLanes and does not promote outside the key cap", async () => {
    const d = deps({
      classify: vi.fn(async () =>
        classification({ task_type: "general", complexity: "medium", constraints: {} }),
      ),
      policies: { policies: [] },
      signalFeedback: {
        enabled: true,
        minSamples: 20,
        getSignal: vi.fn(async (_taskType, lane) =>
          lane === "balanced"
            ? routingSignal({ lane, successRate: 0.4, fallbackRate: 0.8, errorRate: 0.6 })
            : routingSignal({ lane, successRate: 0.99, fallbackRate: 0, errorRate: 0 }),
        ),
      },
    });

    await routeRequest(req(), d, { keyCaps: { allowedLanes: ["economy", "balanced"] } });

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced");
  });

  it("signal feedback does not override policy pins, explicit passthrough, or over-budget degradation", async () => {
    const getSignal = vi.fn(async (_taskType: string, lane: string) =>
      routingSignal({ lane, successRate: lane === "premium" ? 0.99 : 0.2, errorRate: 0.8 }),
    );
    const signalFeedback = { enabled: true, getSignal };

    const pinned = deps({
      classify: vi.fn(async () =>
        classification({ task_type: "general", complexity: "medium", constraints: {} }),
      ),
      policies: { policies: [{ id: "pin-balanced", match: {}, use_lane: "balanced" }] },
      signalFeedback,
    });
    await routeRequest(req(), pinned);
    let plan = (pinned.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced");

    const explicit = deps({ signalFeedback });
    await routeRequest(req({ requested_model: "gpt-4o" }), explicit, { allowCustomModel: true });
    plan = (explicit.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.explicit_model).toBe("gpt-4o");

    const degraded = deps({
      classify: vi.fn(async () =>
        classification({ task_type: "general", complexity: "medium", constraints: {} }),
      ),
      policies: { policies: [] },
      signalFeedback,
    });
    await routeRequest(req(), degraded, {
      keyCaps: { allowedLanes: null, degradeLane: "economy" },
    });
    plan = (degraded.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
    expect(getSignal).not.toHaveBeenCalled();
  });

  it("explicit LANE passthrough expands the lane's chain (full fallback semantics)", async () => {
    // model = a lane name + allow_custom_model: skip classify/policy, but run the
    // lane's expanded chain — NOT a [premium] literal candidate.
    const d = deps();
    const result = await routeRequest(req({ requested_model: "premium" }), d, {
      allowCustomModel: true,
    });

    expect(d.classify).not.toHaveBeenCalled();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
    expect(plan.explicit_model).toBeNull(); // a lane is not a single explicit model
    // premium.primary, then balanced (lane ref) expanded; cycle back to premium cut.
    expect(plan.candidate_chain).toEqual(["best_reasoning_model", "default_good_model"]);

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.lane.selected_lane).toBe("premium");
    expect(rec.classifier.task_type).toBe("passthrough");
    expect(result.final.status).toBe("ok");
  });

  it("explicit lane is rejected with invalid_request when NOT in the key's allowedLanes (no silent downgrade)", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "premium" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: ["economy"] },
    });

    expect(d.execute).not.toHaveBeenCalled();
    expect(result.final.status).toBe("error");
    expect(result.error?.error_class).toBe("invalid_request");
    expect(result.error?.message).toContain("premium");

    // The rejection is still observable: a decision record is logged.
    expect(d.log).toHaveBeenCalledOnce();
    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.final.status).toBe("error");
    expect(rec.final.error_reason).toBe("invalid_request");
    expect(rec.lane.selected_lane).toBe("premium");
    expect(rec.lane.candidate_chain).toEqual([]);
    expect(rec.provider_attempts).toHaveLength(0);
  });

  it("explicit lane inside the key's allowedLanes is served", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "economy" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: ["economy", "balanced"] },
    });

    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
    expect(plan.candidate_chain[0]).toBe("cheap_model");
    expect(result.final.status).toBe("ok");
  });

  it("an EMPTY allowedLanes array is inactive for explicit lanes (mirrors applyCaps)", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "premium" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: [] },
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
  });

  it("explicit lane works even when isKnownModel does not know it (lanes shadow model aliases)", async () => {
    const d = deps({ isKnownModel: () => false });
    const result = await routeRequest(req({ requested_model: "economy" }), d, {
      allowCustomModel: true,
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("explicit UNKNOWN model is rejected with invalid_request (strict — no Phase-0 silent fallback)", async () => {
    const d = deps({ isKnownModel: (alias) => alias === "deepseek/deepseek-v4-pro" });
    const result = await routeRequest(req({ requested_model: "gpt-4o" }), d, {
      allowCustomModel: true,
    });

    expect(d.execute).not.toHaveBeenCalled();
    expect(result.final.status).toBe("error");
    expect(result.error?.error_class).toBe("invalid_request");
    expect(result.error?.message).toContain("gpt-4o");

    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.final.error_reason).toBe("invalid_request");
    expect(rec.lane.candidate_chain).toEqual([]);
  });

  it("explicit KNOWN model passes through; isKnownModel ABSENT keeps legacy passthrough (back-compat)", async () => {
    const known = deps({ isKnownModel: (alias) => alias === "deepseek/deepseek-v4-pro" });
    const okKnown = await routeRequest(
      req({ requested_model: "deepseek/deepseek-v4-pro" }),
      known,
      {
        allowCustomModel: true,
      },
    );
    expect(okKnown.final.status).toBe("ok");
    const plan = (known.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.candidate_chain).toEqual(["deepseek/deepseek-v4-pro"]);

    // No isKnownModel wired (headless core / older callers): no validation.
    const legacy = deps();
    const okLegacy = await routeRequest(req({ requested_model: "anything" }), legacy, {
      allowCustomModel: true,
    });
    expect(okLegacy.final.status).toBe("ok");
  });

  it("keyCaps.degradeLane suppresses explicit LANE passthrough too (no over-budget bypass)", async () => {
    const d = deps();
    const result = await routeRequest(req({ requested_model: "premium" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: null, degradeLane: "economy" },
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("a lane name WITHOUT allow_custom_model stays ignored — classified routing as before", async () => {
    const d = deps();
    await routeRequest(req({ requested_model: "premium" }), d, { allowCustomModel: false });
    expect(d.classify).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding");
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
              error_detail: null,
            },
            {
              alias: "coder_b",
              skipped: false,
              skip_reason: null,
              status: "ok",
              error_class: null,
              latency_ms: 950,
              cost_usd: 0.004,
              error_detail: null,
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

// Virtual model-alias map (docs/04): a vendor model id (e.g. Claude Code's
// "claude-opus-4-8") is rewritten onto a lane / "auto" BEFORE the passthrough
// gate, so a fixed-model client routes without a 400 even on a default key.
describe("routeRequest — virtual model aliases", () => {
  it("a DEFAULT key (no allow_custom_model) IGNORES a matching alias and routes via auto", async () => {
    // Honoring a pinned vendor id is a CUSTOM-MODEL capability. A key without
    // allow_custom_model routes EVERYTHING through classification — the alias map is
    // not consulted, the model field is ignored (no 400), the classifier runs.
    const d = deps({ modelAliases: { "claude-opus-4-8": "premium" } });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: false,
    });

    expect(d.classify).toHaveBeenCalledOnce(); // classified, NOT alias-mapped
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding"); // from the default classification + policy
    expect(plan.explicit_model).toBeNull();
    expect(result.final.status).toBe("ok");

    // Telemetry still records the original vendor id, but it was routed by classification.
    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.requested_model).toBe("claude-opus-4-8");
    expect(rec.policy.reason).not.toContain("alias");
  });

  it("maps a vendor model id onto a lane for an allow_custom_model key", async () => {
    const d = deps({ modelAliases: { "claude-opus-4-8": "premium" } });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: true,
    });

    // Resolved as a lane passthrough — classifier never runs.
    expect(d.classify).not.toHaveBeenCalled();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
    expect(plan.explicit_model).toBeNull();
    expect(plan.candidate_chain).toEqual(["best_reasoning_model", "default_good_model"]);
    expect(result.final.status).toBe("ok");

    // The decision records the ORIGINAL vendor id, and the reason names the alias.
    const rec = (d.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.requested_model).toBe("claude-opus-4-8");
    expect(rec.lane.selected_lane).toBe("premium");
    expect(rec.policy.reason).toContain("alias");
  });

  it("resolves the alias BEFORE the unknown-model 400 on an allow_custom_model key", async () => {
    // The exact bug: claude-opus-4-8 is not a known model, so without the alias an
    // allow_custom_model key 400s. The alias rewrite must win first.
    const d = deps({
      isKnownModel: () => false,
      modelAliases: { "claude-opus-4-8": "premium" },
    });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: true,
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
  });

  it("matches a glob alias (Claude Code appends a date suffix)", async () => {
    const d = deps({ modelAliases: { "claude-opus-*": "premium" } });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8-20260115" }), d, {
      allowCustomModel: true,
    });
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("premium");
    expect(result.final.status).toBe("ok");
  });

  it("an alias mapped to `auto` runs the classifier (does not short-circuit)", async () => {
    const d = deps({ modelAliases: { "claude-*": "auto" } });
    await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: false,
    });
    expect(d.classify).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding"); // from the default classification + policy
  });

  it("an alias-mapped lane is CLAMPED (not rejected) by the key's allowedLanes", async () => {
    // Unlike an EXPLICIT lane ask (which loud-rejects a forbidden lane), an alias
    // is a compatibility convenience: it silently clamps to the permitted set so a
    // fixed-model client keeps working instead of 400ing.
    const d = deps({ modelAliases: { "claude-opus-4-8": "premium" } });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: ["economy"] },
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });

  it("an alias-mapped lane is bounded by a POLICY cap — no cap bypass (review P1)", async () => {
    // A global restrict policy (empty match, allowed_lanes whitelist) clamps
    // everything to balanced. Even an allow_custom_model key must NOT use the
    // operator alias to escape that cap.
    const globalCap: PoliciesConfig = {
      policies: [{ id: "global-cap", match: {}, allowed_lanes: ["economy", "balanced"] }],
    };
    const capped = deps({ modelAliases: { "claude-opus-4-8": "premium" }, policies: globalCap });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), capped, {
      allowCustomModel: true,
    });
    expect(result.final.status).toBe("ok");
    const plan = (capped.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("balanced"); // premium clamped down by the global cap
    const rec = (capped.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rec.policy.reason).toContain("capped");

    // Control: with NO cap policy, the alias keeps premium.
    const free = deps({
      modelAliases: { "claude-opus-4-8": "premium" },
      policies: { policies: [] },
    });
    await routeRequest(req({ requested_model: "claude-opus-4-8" }), free, {
      allowCustomModel: true,
    });
    const plan2 = (free.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan2.selected_lane).toBe("premium");
  });

  it("a non-matching model with a map present falls through to classified routing", async () => {
    const d = deps({ modelAliases: { "claude-*": "premium" } });
    await routeRequest(req({ requested_model: "gpt-4o" }), d, { allowCustomModel: false });
    expect(d.classify).toHaveBeenCalledOnce();
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("coding");
  });

  it("keyCaps.degradeLane suppresses an alias-mapped lane too (no over-budget bypass)", async () => {
    const d = deps({ modelAliases: { "claude-opus-4-8": "premium" } });
    const result = await routeRequest(req({ requested_model: "claude-opus-4-8" }), d, {
      allowCustomModel: true,
      keyCaps: { allowedLanes: null, degradeLane: "economy" },
    });
    expect(result.final.status).toBe("ok");
    const plan = (d.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExecutionPlan;
    expect(plan.selected_lane).toBe("economy");
  });
});
