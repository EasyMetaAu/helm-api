import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  routeRequest,
} from "../routing/route-request.js";
import { loadConfig } from "./loader.js";

// Integration: the SHIPPED config/lanes.yaml + config/policies.yaml, once loaded
// by the (fail-closed) loader, must drive the framework-agnostic router to the
// task lanes operators expect (config.load-rules TDD #2/#3). This wires the real
// YAML -> validated config -> routeRequest, with a stub executor that records the
// selected lane. No web framework, no network (principle 1/4).

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");

function req(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hi" }],
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

function classification(over: Partial<Classification> = {}): Classification {
  return {
    task_type: "general",
    complexity: "medium",
    confidence: 0.9,
    decided_by: "rules",
    constraints: {},
    explanation: [],
    ...over,
  };
}

// Stub execute that always lands on the head candidate and reports the lane back
// via the resolved plan (we read the plan through the DecisionRecord instead).
function okExecute(plan: ExecutionPlan): ExecuteOutcome {
  const head = plan.candidate_chain[0] ?? "none";
  return {
    attempts: [
      {
        alias: head,
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1,
        cost_usd: 0,
        error_detail: null,
      },
    ],
    final: { status: "ok", alias: head, providerModel: head },
    body: { ok: true },
    stream: null,
  };
}

async function selectedLane(cls: Classification, request: InternalRequest): Promise<string> {
  const config = loadConfig({ configDir, env: {} });
  if (config.lanes === undefined) throw new Error("config.lanes must be loaded from lanes.yaml");
  const result = await routeRequest(request, {
    classify: async () => cls,
    policies: config.policies,
    lanes: config.lanes,
    execute: async (plan) => okExecute(plan),
    now: () => new Date(0),
    log: () => {},
  });
  return result.decision.lane.selected_lane;
}

describe("shipped config rules drive routing", () => {
  it("loads lanes.yaml with the coding/json/vision/tool_use task lanes", () => {
    const config = loadConfig({ configDir, env: {} });
    expect(config.lanes?.coding?.fallback).toEqual(["premium", "balanced"]);
    expect(config.lanes?.json?.constraints.require_json).toBe(true);
    expect(config.lanes?.vision).toBeDefined();
    expect(config.lanes?.tool_use).toBeDefined();
  });

  it("routes a coding + complex request to the coding lane (policy first-match)", async () => {
    const lane = await selectedLane(
      classification({ task_type: "coding", complexity: "complex" }),
      req({ messages: [{ role: "user", content: "refactor this module" }] }),
    );
    expect(lane).toBe("coding");
  });

  it("routes a JSON-constrained request to the json lane (needs_json policy)", async () => {
    const lane = await selectedLane(
      classification({ task_type: "general", constraints: { needs_json: true } }),
      req(),
    );
    expect(lane).toBe("json");
  });

  it("routes the Codex gpt-5.6 alias directly to the subscription Sol lane", async () => {
    const config = loadConfig({ configDir, env: {} });
    if (config.lanes === undefined) throw new Error("config.lanes must be loaded from lanes.yaml");

    const result = await routeRequest(
      req({ protocol: "openai_responses", requested_model: "gpt-5.6" }),
      {
        classify: async () => classification(),
        policies: config.policies,
        lanes: config.lanes,
        modelAliases: config.model_aliases,
        execute: async (plan) => okExecute(plan),
        now: () => new Date(0),
        log: () => {},
      },
      { allowCustomModel: true },
    );

    expect(result.decision.lane.selected_lane).toBe("gpt-5.6-sol");
    expect(result.decision.lane.candidate_chain[0]).toBe("openai-codex/gpt-5.6-sol");
    expect(result.decision.lane.candidate_chain).not.toContain("openai/gpt-5.6");
    expect(result.decision.requested_model).toBe("gpt-5.6");
  });
});
