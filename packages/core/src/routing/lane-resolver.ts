import type { LanesConfig } from "../lanes/schema.js";

// Lane Resolver — collapses the classifier + policy outcome into exactly ONE
// lane name, defaulting to `balanced`. Pure, deterministic, zero-network
// (CLAUDE.md principle 4); `balanced` is the terminal of the *classification*
// fallback (principle 5) and is guaranteed to exist by `lanes.schema`. It does
// NOT expand primary->fallback chains, trip circuit breakers, or call providers
// — that EXECUTION fallback belongs to `executor.fallback`, a separate
// mechanism with separate log fields (principle 5). See
// docs/04-routing-and-lanes.md and docs/02-architecture.md.
//
// Explicit client-specified models are a pass-through handled UPSTREAM by
// `routing.pipeline` (when the key's `allow_custom_model` permits), so they
// never reach this function — hence no `explicit` input here.

// Classifier output (docs/02 decision record `classifier` segment). Defined
// locally as the minimal shape the resolver consumes; aligns with
// classifier.engine's richer result.
export interface Classification {
  task_type: string; // e.g. "coding" | "vision" | "general"
  complexity: "simple" | "medium" | "complex";
  decided_by: "rules" | "eval" | "default";
  constraints: {
    needs_json?: boolean;
    needs_tools?: boolean;
    needs_vision?: boolean;
  };
}

// Policy Engine output (caps already applied). Mirrors the subset of
// `routing.policy-engine`'s `PolicyOutcome` the resolver needs.
export interface PolicyOutcome {
  matched_policy_id: string | null;
  use_lane: string | null; // lane the policy wants (post-caps); null if no/cap-only match
  reason: string;
}

export interface ResolveLaneInput {
  classification: Classification;
  policy: PolicyOutcome;
  lanes: LanesConfig;
}

export interface LaneDecision {
  selected_lane: string; // ALWAYS a key that exists in `lanes`
  decided_by: "policy" | "task_lane" | "complexity_fallback";
  reason: string; // human-readable, fed to telemetry (docs/02 `lane` segment)
}

// Complexity -> default-lane fallback (docs/04). Terminal `balanced` is the
// medium target and the universal fail-open sink.
const COMPLEXITY_FALLBACK: Record<Classification["complexity"], string> = {
  simple: "economy",
  medium: "balanced",
  complex: "premium",
};

const BALANCED = "balanced";

function has(lanes: LanesConfig, name: string): boolean {
  return Object.hasOwn(lanes, name);
}

// Priority (explicit pass-through already diverted upstream):
//   1. policy.use_lane (if it names an existing lane)              -> policy
//   2. task lane matching classification.task_type (if it exists)  -> task_lane
//   3. complexity fallback lane (if it exists)                     -> complexity_fallback
//   4. otherwise / classifier self-fallback / missing lane         -> balanced
// Any selected name that is absent from `lanes` is skipped (fail-open,
// principle 3); the terminal `balanced` is guaranteed present by lanes.schema.
export function resolveLane(input: ResolveLaneInput): LaneDecision {
  const { classification, policy, lanes } = input;

  // The classifier already fell back to its own default — do not re-derive a
  // lane from task/complexity; go straight to the classification terminal.
  if (classification.decided_by === "default") {
    return {
      selected_lane: BALANCED,
      decided_by: "complexity_fallback",
      reason: "classifier fell back (decided_by=default) -> balanced",
    };
  }

  // 1. server-side policy intent.
  if (policy.use_lane !== null) {
    if (has(lanes, policy.use_lane)) {
      return {
        selected_lane: policy.use_lane,
        decided_by: "policy",
        reason: `policy selected lane '${policy.use_lane}' (${policy.reason})`,
      };
    }
    // Policy named a lane that does not exist: do not crash, fall through.
  }

  // 2. task-specific lane named after the detected task type.
  if (has(lanes, classification.task_type)) {
    return {
      selected_lane: classification.task_type,
      decided_by: "task_lane",
      reason: `task lane '${classification.task_type}' matched task_type`,
    };
  }

  // 3. complexity fallback lane.
  const byComplexity = COMPLEXITY_FALLBACK[classification.complexity];
  if (has(lanes, byComplexity)) {
    return {
      selected_lane: byComplexity,
      decided_by: "complexity_fallback",
      reason: `complexity '${classification.complexity}' -> lane '${byComplexity}'`,
    };
  }

  // 4. fail-open terminal.
  return {
    selected_lane: BALANCED,
    decided_by: "complexity_fallback",
    reason: `unresolved (no policy/task/complexity lane) -> balanced`,
  };
}
