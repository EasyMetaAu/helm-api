import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  routeRequest,
} from "../routing/route-request.js";
import { scoreRequest } from "./engine.js";
import type { Complexity } from "./tiers.js";

// CASCADE GATE coverage — the regression guard the original suite LACKED.
//
// golden-routing.test.ts feeds the router a Classification with decided_by HARD-CODED
// to "rules" (it calls scoreRequest directly, bypassing the confidence gate). So it
// proved "given a rules decision the lanes resolve right" but NEVER that the cascade
// actually REACHES decided_by=rules for a real prompt. That blind spot let a
// calibration regression ship where Layer-1 confidence never cleared the threshold:
// with eval OFF (the default) EVERY request degraded to fallback → balanced and the
// whole lane system was inert (classifier.lane-calibration, 2026-06-01).
//
// This test reproduces the REAL production gate (eval OFF): scoreRequest →
// `confidence >= rules.confidence_threshold` ? rules : fallback → routeRequest with
// the SHIPPED config. It asserts representative prompts (a) clear the gate by RULES
// (not fallback) and (b) route to their intended, DISTINCT lanes — so a future config
// edit that re-breaks the gate fails here loudly. Pure / network-free (eval never
// runs); momentum NOT injected (deterministic, isolated per prompt).

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(resolve(__dirname, "../../../.."), "config");
const config = loadConfig({ configDir, env: {} });
const rulesCfg = config.classifier.rules;
if (config.lanes === undefined) throw new Error("config/lanes.yaml must load");
const lanes = config.lanes;

function mapComplexity(c: Complexity): Classification["complexity"] {
  switch (c) {
    case "standard":
      return "medium";
    case "reasoning":
    case "complex":
      return "complex";
    default:
      return "simple";
  }
}

function approxTokens(req: InternalRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
  }
  return Math.ceil(chars / 4);
}

function req(content: string, over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "gate",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content }],
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
  } as InternalRequest;
}

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
      },
    ],
    final: { status: "ok", alias: head, providerModel: head },
    body: { ok: true },
    stream: null,
  } as ExecuteOutcome;
}

// Run the REAL Layer-1 confidence gate (eval OFF) + the REAL router.
async function decide(request: InternalRequest) {
  const scored = scoreRequest(request, { cfg: rulesCfg, approxTokens: approxTokens(request) });
  const decided_by: Classification["decided_by"] =
    scored.confidence >= rulesCfg.confidence_threshold ? "rules" : "fallback";
  const cls: Classification = {
    task_type: scored.task_type,
    complexity: mapComplexity(scored.complexity),
    confidence: scored.confidence,
    decided_by,
    constraints: {
      needs_json: scored.constraints.needs_json,
      needs_tools: scored.constraints.needs_tools,
      needs_vision: scored.constraints.needs_vision,
    },
    explanation: [],
  };
  const result = await routeRequest(request, {
    classify: async () => cls,
    policies: config.policies,
    lanes,
    execute: async (plan) => okExecute(plan),
    now: () => new Date(0),
    log: () => {},
  });
  return { decided_by, lane: result.decision.lane.selected_lane, confidence: scored.confidence };
}

// Representative prompts spanning every lane. The point is NOT to re-assert every
// golden lane (golden does that) but to prove the GATE clears by RULES — i.e. the
// cascade is not silently dumping everything to balanced.
const CASES: Array<{ name: string; request: InternalRequest; lane: string }> = [
  { name: "exact confirmation yes", request: req("yes"), lane: "economy" },
  { name: "exact confirmation no", request: req("no"), lane: "economy" },
  { name: "exact confirmation sure", request: req("sure"), lane: "economy" },
  { name: "exact confirmation got it", request: req("got it"), lane: "economy" },
  { name: "greeting", request: req("hi"), lane: "economy" },
  { name: "lookup", request: req("what is a monad"), lane: "economy" },
  { name: "translate", request: req("translate this to french"), lane: "economy" },
  { name: "trivial code", request: req("write a function to reverse a string"), lane: "economy" },
  {
    name: "complex coding",
    request: req("refactor this module and debug the failing function in the compile step"),
    lane: "coding",
  },
  {
    name: "multistep coding",
    request: req("first set up the repo, then write the function, and then finally compile it"),
    lane: "coding",
  },
  {
    name: "deep reasoning",
    request: req("prove the probability bound, derive it step by step from the theorem"),
    lane: "premium",
  },
  {
    name: "planning",
    request: req(
      "design the architecture for this system, weigh the trade-off and reason about the strategy step by step",
    ),
    lane: "premium",
  },
  {
    name: "analysis",
    request: req(
      "analyze and compare these approaches, evaluate the implications and find the root cause",
    ),
    lane: "premium",
  },
  {
    name: "expanded security without coding crutch",
    request: req("audit this service for sql injection and command injection vulnerabilities"),
    lane: "premium",
  },
  {
    name: "expanded analysis",
    request: req("assess the pros and cons of these two approaches and weigh the trade-offs"),
    lane: "premium",
  },
  {
    name: "expanded planning",
    request: req("outline a project roadmap with milestones and break down the deliverables"),
    lane: "balanced",
  },
  {
    name: "no output analysis is not simple",
    request: req("analyze why there is no output and diagnose the failure root cause"),
    lane: "premium",
  },
  {
    name: "no stack trace debug is not simple",
    request: req(
      "debug why there is no stack trace in this failing compile step and refactor the failing function",
    ),
    lane: "coding",
  },
  {
    name: "no auth check audit is not simple",
    request: req(
      "audit why there is no auth check in this access control system and privilege escalation risk",
    ),
    lane: "premium",
  },
  { name: "short no output is diagnostic", request: req("no output"), lane: "premium" },
  { name: "short no stack trace is coding", request: req("no stack trace"), lane: "coding" },
  { name: "short no auth check is security", request: req("no auth check"), lane: "premium" },
  {
    name: "short no command injection is security",
    request: req("no command injection"),
    lane: "premium",
  },
  {
    name: "data medium",
    request: req("aggregate this csv into a dataframe and run a sql pivot"),
    lane: "balanced",
  },
  {
    name: "json constrained",
    request: req("respond with structured output", { response_format: { type: "json_object" } }),
    lane: "json",
  },
  {
    name: "vision",
    request: req("describe this screenshot", { attachments: [{ type: "image" }] }),
    lane: "vision",
  },
];

describe("classification cascade GATE (eval off, shipped config)", () => {
  for (const c of CASES) {
    it(`'${c.name}' clears the gate by RULES and routes to ${c.lane}`, async () => {
      const d = await decide(c.request);
      expect(d.decided_by).toBe("rules");
      expect(d.confidence).toBeGreaterThanOrEqual(rulesCfg.confidence_threshold);
      expect(d.lane).toBe(c.lane);
    });
  }

  it("differentiates: the representative set spans MANY lanes (not all balanced)", async () => {
    const lanesSeen = new Set<string>();
    for (const c of CASES) lanesSeen.add((await decide(c.request)).lane);
    // The pre-fix bug collapsed everything to a single lane. Demand real spread.
    expect(lanesSeen.size).toBeGreaterThanOrEqual(4);
    expect(lanesSeen.has("economy")).toBe(true);
    expect(lanesSeen.has("premium")).toBe(true);
    expect(lanesSeen.has("coding")).toBe(true);
  });
});
