import type { ReasoningEffort } from "@helm/shared";
import type { PoliciesConfig, Policy, PolicyMatch } from "./policy-schema.js";

// Policy Engine — first-match evaluator + caps application. Pure, deterministic,
// zero-network (CLAUDE.md principle 4). It produces only the *intent* (which
// lane a policy wants + caps); the final lane choice (existence checks,
// classification/task fallback) belongs to `routing.lane-resolver`, which
// consumes `PolicyOutcome`. Explicit and inspectable — no hidden magic scoring
// (docs/04); telemetry records the single matched policy (docs/02).

// Matching context: classifier result + request shape. All fields present.
// Routing is matched on task/complexity/capability only — there is intentionally
// no org/user dimension (per-key caps live on the API key, not in policies).
export interface PolicyContext {
  task_type: string;
  // null for an unclassified request (the model-alias passthrough path) so it
  // matches no complexity-constrained policy.
  complexity: "simple" | "medium" | "complex" | null;
  needs_json: boolean;
  needs_tools: boolean;
  needs_vision: boolean;
  // Memory-scope field (client-controlled via x-project-id), NOT a trusted routing
  // attribute — always null here (see route-request policyContext) so a caller can
  // never spoof a project_id policy to change lane/cost.
  project_id: string | null;
}

// Single-match record for telemetry + downstream resolver. Maps directly onto
// the docs/02 decision record `policy` segment (`matched_policy_id`, `reason`).
export interface PolicyOutcome {
  matched_policy_id: string | null; // null = no policy matched
  use_lane: string | null; // matched policy's use_lane (may be null if caps-only)
  allowed_lanes: string[] | null;
  reasoning_effort: ReasoningEffort | null;
  reason: string; // human-readable, inspectable in the Debug UI
}

// Lane ranking from "cheap" to "strong", used for allowed_lanes comparison.
// Default three tiers; task-specific lanes (coding/vision…) are NOT ranked and
// are treated as incomparable (see applyCaps).
export const LANE_RANK: Record<string, number> = {
  economy: 0,
  balanced: 1,
  premium: 2,
};

// Cost rank an UNRANKABLE candidate (task / vendor-family lane) is treated as when
// clamped to an allowed_lanes whitelist — the default `balanced` tier, so it
// degrades toward balanced instead of escalating to the strongest allowed lane.
const UNRANKED_CANDIDATE_RANK = LANE_RANK.balanced ?? 1;

const EMPTY_OUTCOME: PolicyOutcome = {
  matched_policy_id: null,
  use_lane: null,
  allowed_lanes: null,
  reasoning_effort: null,
  reason: "no policy matched",
};

// The match fields, in declaration order, paired with the ctx accessor. Keeps
// matching and reason-building in one inspectable list.
const MATCH_FIELDS: ReadonlyArray<{
  readonly key: keyof PolicyMatch;
  readonly get: (ctx: PolicyContext) => string | boolean | null;
}> = [
  { key: "task_type", get: (c) => c.task_type },
  { key: "complexity", get: (c) => c.complexity },
  { key: "needs_json", get: (c) => c.needs_json },
  { key: "needs_tools", get: (c) => c.needs_tools },
  { key: "needs_vision", get: (c) => c.needs_vision },
  { key: "project_id", get: (c) => c.project_id },
];

// Returns the list of match fields satisfied by ctx, or null if the policy does
// NOT fully match. Every WRITTEN field must strict-equal the ctx value (AND);
// unwritten fields are unconstrained.
function matchedFields(match: PolicyMatch, ctx: PolicyContext): string[] | null {
  const hits: string[] = [];
  for (const { key, get } of MATCH_FIELDS) {
    const want = match[key];
    if (want === undefined) continue; // field not constrained
    if (want !== get(ctx)) return null; // strict equality fails => no match
    hits.push(key);
  }
  return hits;
}

function policyId(policy: Policy, index: number): string {
  return policy.id ?? `policy[${index}]`;
}

// first-match PIN + caps ACCUMULATION: in declaration order, the FIRST policy
// whose `match` is satisfied wins the lane PIN (matched_policy_id / use_lane /
// reason) and STOPS pinning. But the `allowed_lanes` whitelist is NOT abandoned
// at the first match — it accumulates (intersection: strictest whitelist wins)
// across EVERY matching policy, so a restrict-only policy placed after a use_lane
// policy still binds. No match => all-null outcome so the resolver falls back to
// task/complexity.
export function evaluatePolicies(ctx: PolicyContext, cfg: PoliciesConfig): PolicyOutcome {
  let pinned: {
    id: string;
    use_lane: string | null;
    reasoning_effort: ReasoningEffort | null;
    reason: string;
  } | null = null;
  let allowedLanes: string[] | null = null;

  for (let i = 0; i < cfg.policies.length; i++) {
    const policy = cfg.policies[i];
    if (policy === undefined) continue;
    const hits = matchedFields(policy.match, ctx);
    if (hits === null) continue;

    const id = policyId(policy, i);

    // PIN: first match wins the lane intent + telemetry id/reason.
    if (pinned === null) {
      const trigger = hits.length > 0 ? `match on [${hits.join(", ")}]` : "no match constraints";
      pinned = {
        id,
        use_lane: policy.use_lane ?? null,
        reasoning_effort: policy.reasoning_effort ?? null,
        reason: `policy '${id}' ${trigger}`,
      };
    }

    // ACCUMULATE caps from this match (regardless of whether it was the pin).
    if (policy.allowed_lanes != null) {
      allowedLanes = intersectAllowed(allowedLanes, policy.allowed_lanes);
    }
  }

  if (pinned === null) return { ...EMPTY_OUTCOME };
  return {
    matched_policy_id: pinned.id,
    use_lane: pinned.use_lane,
    allowed_lanes: allowedLanes,
    reasoning_effort: pinned.reasoning_effort,
    reason: pinned.reason,
  };
}

// Intersect two allowed_lanes whitelists, preserving the incumbent's order. The
// intersection is the strictest constraint (only lanes BOTH policies permit).
function intersectAllowed(current: string[] | null, next: string[]): string[] {
  if (current === null) return [...next];
  const allow = new Set(next);
  return current.filter((lane) => allow.has(lane));
}

function lowestRankedLane(lanes: string[]): string {
  let best = lanes[0] as string;
  let bestRank = LANE_RANK[best] ?? Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    const rank = LANE_RANK[lane] ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      best = lane;
      bestRank = rank;
    }
  }
  return best;
}

// Converge a candidate lane into the `allowed_lanes` whitelist: if the candidate
// is in the whitelist, keep it; else pick the highest-ranked allowed lane that is
// <= the candidate's rank, otherwise the lowest-ranked allowed lane (never upgrade
// past what the candidate wanted). An UNRANKABLE candidate (a task lane like
// `coding`/`json`, or a vendor-family lane like `claude-opus`) has no cost rank, so
// it is clamped as if it asked for the DEFAULT tier (`balanced`) — degrading toward
// balanced, never escalating to the most expensive allowed lane (e.g. `premium`).
export function applyCaps(lane: string, outcome: PolicyOutcome): string {
  let result = lane;

  if (outcome.allowed_lanes != null && outcome.allowed_lanes.length > 0) {
    const allowed = outcome.allowed_lanes;
    if (!allowed.includes(result)) {
      // Unrankable (task / vendor-family) candidate => treat as the `balanced`
      // tier so the clamp degrades toward balanced, not the strongest allowed.
      const candidateRank = LANE_RANK[result] ?? UNRANKED_CANDIDATE_RANK;
      // Highest-ranked allowed lane whose rank is <= candidate's rank.
      let pick: string | null = null;
      let pickRank = Number.NEGATIVE_INFINITY;
      for (const a of allowed) {
        const r = LANE_RANK[a] ?? Number.POSITIVE_INFINITY;
        if (r <= candidateRank && r > pickRank) {
          pick = a;
          pickRank = r;
        }
      }
      result = pick ?? lowestRankedLane(allowed);
    }
  }

  return result;
}
