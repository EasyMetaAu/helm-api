import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import { resolveLane } from "./lane-resolver.js";
import { applyCaps, evaluatePolicies, type PolicyContext } from "./policy-engine.js";

// DECISION-TABLE MATRIX — the complexity-CONDITIONED steering rules (Phase 1).
//
// Pure / network-free (CLAUDE.md principle 1/4): we feed a PolicyContext through
// the SAME two-stage pipeline routeRequest uses — evaluatePolicies → resolveLane
// (+ applyCaps) — against the REAL shipped config (config/policies.yaml +
// config/lanes.yaml). Each row asserts the matched policy id and the final
// selected lane (and decided_by where the *mechanism* matters).
//
// WHY these rows and NOT others — the resolver already gives us, FOR FREE
// (lane-resolver.ts): task_type→same-named lane (coding/json/vision/tool_use),
// and the complexity fallback simple→economy / medium→balanced / complex→
// premium. So Phase 1 only adds rules that change behavior BEYOND that default:
//
//   coding + simple  → economy   (llm-router MBPP fix: trivial code ≠ premium;
//                                 NOTE without this rule the `coding` TASK LANE
//                                 would catch it — task_lane wins over the
//                                 economy complexity fallback — so this rule is
//                                 a genuine override, not a duplicate.)
//   math   + simple  → balanced  (math is never economy)
//   math   + complex → premium   (overrides nothing the resolver does for math:
//                                 no `math` lane exists, complex→premium is the
//                                 fallback default — see the "default-equiv"
//                                 note below; kept because §5.1 names it and the
//                                 llm-router table is the source of truth.)
//   chat   + simple  → economy   (knowledge_qa simple → cheapest; same default-
//                                 equiv note — chat has no lane, simple→economy)
//   chat   + complex → premium   (GPQA/HLE-level knowledge → premium; default-
//                                 equiv, complex→premium)
//
// We deliberately DO NOT add web/vision/tool_use policies: the task-lane default
// already routes vision→vision and tool_use→tool_use, and web has no lane so it
// rides the complexity fallback. Adding rules there would SHADOW the resolver's
// task-lane step (a policy use_lane is consulted BEFORE the task lane) — pure
// regression risk for zero behavior gain. We also DO NOT add a `default`
// catch-all: it would match every request first and shadow the task-lane logic.
//
// math+complex / chat+simple / chat+complex are "default-equivalent" today
// (their lane equals what the resolver would pick anyway). They are still
// asserted here so the MATRIX documents the §5.1 contract and so a future lane
// reshuffle (e.g. adding a `math` lane) cannot silently change them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");
const config = loadConfig({ configDir, env: {} });
if (config.lanes === undefined) throw new Error("config/lanes.yaml must load");
const lanes = config.lanes;
const policies = config.policies;

type Complexity = PolicyContext["complexity"];

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    task_type: "chat",
    complexity: "medium",
    needs_json: false,
    needs_tools: false,
    needs_vision: false,
    project_id: null,
    ...over,
  };
}

// Run the REAL policy engine + resolver against the shipped config, exactly as
// routeRequest does (evaluatePolicies → resolveLane → applyCaps).
function decide(c: PolicyContext): {
  matched_policy_id: string | null;
  selected_lane: string;
  decided_by: string;
} {
  const outcome = evaluatePolicies(c, policies);
  const laneDecision = resolveLane({
    classification: {
      task_type: c.task_type,
      complexity: c.complexity ?? "medium",
      decided_by: "rules",
      constraints: {
        needs_json: c.needs_json,
        needs_tools: c.needs_tools,
        needs_vision: c.needs_vision,
      },
    },
    policy: {
      matched_policy_id: outcome.matched_policy_id,
      use_lane: outcome.use_lane,
      reason: outcome.reason,
    },
    lanes,
  });
  const cappedLane = applyCaps(laneDecision.selected_lane, outcome);
  if (cappedLane === null) {
    throw new Error("policy matrix row unexpectedly denied every lane");
  }
  return {
    matched_policy_id: outcome.matched_policy_id,
    selected_lane: cappedLane,
    decided_by: laneDecision.decided_by,
  };
}

interface Row {
  name: string;
  task_type: string;
  complexity: Complexity;
  matched_policy_id: string | null;
  selected_lane: string;
  decided_by: string;
}

const ROWS: Row[] = [
  // — coding —
  {
    name: "coding+simple → economy (MBPP fix, overrides coding task lane)",
    task_type: "coding",
    complexity: "simple",
    matched_policy_id: "coding_simple_to_economy",
    selected_lane: "economy",
    decided_by: "policy",
  },
  {
    name: "coding+medium → coding task lane (no policy)",
    task_type: "coding",
    complexity: "medium",
    matched_policy_id: null,
    selected_lane: "coding",
    decided_by: "task_lane",
  },
  {
    name: "coding+complex → coding lane via existing policy",
    task_type: "coding",
    complexity: "complex",
    matched_policy_id: "coding_complex_to_coding_lane",
    selected_lane: "coding",
    decided_by: "policy",
  },

  // — math (no math lane exists) —
  {
    name: "math+simple → balanced (math is never economy)",
    task_type: "math",
    complexity: "simple",
    matched_policy_id: "math_simple_to_balanced",
    selected_lane: "balanced",
    decided_by: "policy",
  },
  {
    name: "math+medium → balanced (complexity fallback, no policy)",
    task_type: "math",
    complexity: "medium",
    matched_policy_id: null,
    selected_lane: "balanced",
    decided_by: "complexity_fallback",
  },
  {
    name: "math+complex → premium",
    task_type: "math",
    complexity: "complex",
    matched_policy_id: "math_complex_to_premium",
    selected_lane: "premium",
    decided_by: "policy",
  },

  // — chat (no chat lane exists) —
  {
    name: "chat+simple → economy",
    task_type: "chat",
    complexity: "simple",
    matched_policy_id: "chat_simple_to_economy",
    selected_lane: "economy",
    decided_by: "policy",
  },
  {
    name: "chat+medium → balanced (complexity fallback, no policy)",
    task_type: "chat",
    complexity: "medium",
    matched_policy_id: null,
    selected_lane: "balanced",
    decided_by: "complexity_fallback",
  },
  {
    name: "chat+complex → premium",
    task_type: "chat",
    complexity: "complex",
    matched_policy_id: "chat_complex_to_premium",
    selected_lane: "premium",
    decided_by: "policy",
  },

  // — security (Phase 2; eval-v2 cybersecurity domain). NO `security` lane
  //   exists and Helm has NO raise-only floor, so we do NOT blanket-pin (a flat
  //   use_lane would over-pin benign security Q&A to premium). Only complex
  //   security is pinned premium; simple/medium fall through to the normal
  //   complexity fallback (economy / balanced). —
  {
    name: "security+complex → premium (only complex is pinned)",
    task_type: "security",
    complexity: "complex",
    matched_policy_id: "security_complex_to_premium",
    selected_lane: "premium",
    decided_by: "policy",
  },
  {
    name: "security+simple → economy (no policy, complexity fallback, NOT over-pinned)",
    task_type: "security",
    complexity: "simple",
    matched_policy_id: null,
    selected_lane: "economy",
    decided_by: "complexity_fallback",
  },
  {
    name: "security+medium → balanced (no policy, complexity fallback)",
    task_type: "security",
    complexity: "medium",
    matched_policy_id: null,
    selected_lane: "balanced",
    decided_by: "complexity_fallback",
  },

  // — guard: vision/tool_use/web are NOT given policies; they ride the resolver
  //   defaults so a stray Phase-1 policy that shadows them turns these RED. —
  {
    name: "vision+simple → vision task lane (no policy, NOT shadowed)",
    task_type: "vision",
    complexity: "simple",
    matched_policy_id: null,
    selected_lane: "vision",
    decided_by: "task_lane",
  },
  {
    name: "tool_use+complex → tool_use task lane (no policy, NOT shadowed)",
    task_type: "tool_use",
    complexity: "complex",
    matched_policy_id: null,
    selected_lane: "tool_use",
    decided_by: "task_lane",
  },
  {
    name: "web+simple → economy (no web lane, complexity fallback, no policy)",
    task_type: "web",
    complexity: "simple",
    matched_policy_id: null,
    selected_lane: "economy",
    decided_by: "complexity_fallback",
  },
];

describe("Phase 1 complexity-conditioned policy MATRIX (real config)", () => {
  for (const r of ROWS) {
    it(`${r.name}`, () => {
      const got = decide(ctx({ task_type: r.task_type, complexity: r.complexity }));
      expect(got).toEqual({
        matched_policy_id: r.matched_policy_id,
        selected_lane: r.selected_lane,
        decided_by: r.decided_by,
      });
    });
  }

  it("needs_json json policy stays first-match for json case", () => {
    const got = decide(ctx({ task_type: "chat", complexity: "simple", needs_json: true }));
    expect(got).toEqual({
      matched_policy_id: "json_constrained_to_json_lane",
      selected_lane: "json",
      decided_by: "policy",
    });
  });
});
