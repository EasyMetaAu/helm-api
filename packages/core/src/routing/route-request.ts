import {
  type AttemptErrorDetail,
  type DecisionRecord,
  type HelmError,
  type InternalRequest,
  makeHelmError,
} from "@helm/shared";
import { expandLaneChain } from "../lanes/expand-chain.js";
import type { LanesConfig } from "../lanes/schema.js";
import { type Classification as ResolverClassification, resolveLane } from "./lane-resolver.js";
import { applyCaps, evaluatePolicies, type PolicyContext } from "./policy-engine.js";
import type { PoliciesConfig } from "./policy-schema.js";

// routeRequest — the SINGLE, framework-agnostic orchestrator for one request
// (CLAUDE.md principle 1: NO web framework import here — Hono/SSE adaptation
// lives only in apps/gateway). It wires the pipeline of docs/02:
//   explicit-passthrough? → classify → policy → lane-resolver(+caps) → chain
//   expansion → execute(capability filter + circuit breaker + fallback) →
//   DecisionRecord → log.
//
// Two invariants from the spec it is responsible for:
//   • fail-open (principle 3): when classify throws, degrade to `balanced`
//     (decided_by:"default") and keep routing — never surface a 5xx. Only the
//     execute() layer's "all providers failed" yields a structured error.
//   • streaming correctness (principle 8): for stream:true it passes the
//     executor's stream handle straight through, UNBUFFERED — routeRequest never
//     drains the iterator (SSE event order/boundaries stay byte-identical).
//
// The two fallbacks stay separate (principle 5): CLASSIFICATION fallback
// (classifier.decided_by → "default" → balanced) and EXECUTION fallback
// (provider_attempts within the chain) are distinct DecisionRecord fields,
// assembled here without conflation.

// Classifier output consumed by the orchestrator (superset of the resolver's
// minimal `Classification`). Mirrors @helm/shared ClassifierDecision plus the
// fields the resolver/policy engine read; the classifier adapter (classifier.
// engine + cascade) produces this, already fail-open internally.
export interface Classification {
  task_type: string;
  complexity: "simple" | "medium" | "complex";
  confidence: number;
  // `fallback` = Layer-3 cascade balanced sink (eval disabled / failed open);
  // `default` = the orchestrator's hard fail-open when classify itself throws.
  decided_by: "rules" | "eval" | "default" | "fallback";
  // Layer-2 eval observability (principle 5; never the execution fallback):
  //   eval_cache_hit — true on a Layer-2 cache hit; null when eval did not run.
  //   fallback_reason — set ONLY on decided_by==="fallback" (eval_disabled /
  //     eval_<reason>); null otherwise.
  //   eval_usd — Layer-2 small-model self-cost, known ONLY when eval actually
  //     ran (the eval client surfaces it). Null when eval did not run; kept
  //     SEPARATE from completion cost in cost_breakdown (docs/07; principle 5).
  eval_cache_hit?: boolean | null;
  fallback_reason?: string | null;
  eval_usd?: number | null;
  constraints: {
    needs_json?: boolean;
    needs_tools?: boolean;
    needs_vision?: boolean;
    [k: string]: unknown;
  };
  explanation: unknown[];
}

// The resolved execution plan handed to execute(). For explicit MODEL
// passthrough the chain is exactly [explicit_model]; for an explicit LANE
// (model field names a lane, docs/04) and for classified routing it is the
// selected lane's primary plus its (recursively expanded, deduped, cycle-safe)
// fallback aliases — explicit_model stays null in both lane cases.
export interface ExecutionPlan {
  selected_lane: string;
  candidate_chain: string[];
  explicit_model: string | null;
}

// One provider attempt row — field-for-field aligned with @helm/shared
// ProviderAttemptSchema and executor.fallback's AttemptRecord so it threads
// straight into the decision record.
export interface ProviderAttempt {
  alias: string;
  skipped: boolean;
  skip_reason: string | null;
  status: "ok" | "error";
  error_class: string | null;
  latency_ms: number;
  cost_usd: number | null;
  /** Upstream failure detail for THIS attempt (admin-debug-error-detail). Non-null
   *  only for a genuine upstream failure; null for ok/skipped rows. Redacted. */
  error_detail: AttemptErrorDetail | null;
}

// What execute() returns: the provider_attempts trail, the final landing, and
// (exactly one of) a non-stream body or a stream handle. The stream handle is
// an opaque AsyncIterable the orchestrator forwards untouched (principle 8).
export interface ExecuteOutcome {
  attempts: ProviderAttempt[];
  final:
    | { status: "ok"; alias: string; providerModel: string }
    | { status: "error"; error: HelmError };
  body: unknown | null;
  stream: AsyncIterable<string> | null;
}

// The orchestrator's return value: the executor outcome enriched with the
// assembled DecisionRecord and a flattened final/error for the HTTP adapter.
export interface ExecutionResult {
  decision: DecisionRecord;
  final: { status: "ok"; alias: string } | { status: "error" };
  body: unknown | null;
  stream: AsyncIterable<string> | null;
  error: HelmError | null;
}

export interface RouteDeps {
  /** classifier.engine adapter — internally fail-open (throwing here is still
   *  caught and degraded to balanced). */
  classify: (req: InternalRequest) => Promise<Classification>;
  policies: PoliciesConfig;
  lanes: LanesConfig;
  /** executor.fallback adapter — capability filter + circuit breaker + chain
   *  execution. Non-stream → body; stream → stream handle. */
  execute: (plan: ExecutionPlan, req: InternalRequest) => Promise<ExecuteOutcome>;
  now: () => Date;
  /** telemetry sink — record is ALREADY redacted upstream is the caller's job;
   *  this never logs plaintext key/payload (principle 7). */
  log: (record: DecisionRecord) => void;
  /** Is this string a model the deployment can actually serve? Used ONLY to
   *  validate an explicit-model passthrough (allow_custom_model): an unknown
   *  model is rejected with invalid_request instead of silently falling through
   *  to the default provider (docs/04 — strict, no silent fallback). The gateway
   *  wires it from registry + live OAuth curation + provider-prefix structure;
   *  absent (headless core / tests) → validation is skipped. Lane names are
   *  checked FIRST and never reach this. */
  isKnownModel?: (alias: string) => boolean;
}

export interface RouteOptions {
  /** From the API key's caps (auth). Gates explicit-model passthrough (docs/04). */
  allowCustomModel?: boolean;
  /** Display prefix of the resolved auth key (e.g. helm_live_ab12) for the Debug
   *  UI key column. PREFIX ONLY — never the plaintext key (principle 7). The
   *  gateway threads it from the auth identity; null/undefined when unknown. */
  keyPrefix?: string | null;
  /** Per-key lane caps from the API key's auth record (docs/04). The OUTER,
   *  non-negotiable bound: applied LAST (after policy caps) so it wins even over
   *  a policy use_lane pin. allowedLanes null = unconstrained; keyCaps itself
   *  undefined = no-op (existing callers unaffected). The gateway handlers thread
   *  it from the auth identity.
   *
   *  `degradeLane` is the DYNAMIC over-budget action (docs/06 "usage budgets"):
   *  null in the normal case, but set to the key's degrade lane (e.g. "economy")
   *  for THIS request when the key is over its usage budget. It FORCES the request
   *  onto that lane (a forced selection, not a rank ceiling) — so it works for any
   *  target lane (ranked OR a task lane) and cannot be bypassed by explicit-model
   *  passthrough (passthrough is suppressed while degrading). The forced lane is
   *  still clamped to `allowedLanes` (the harder security bound). */
  keyCaps?: { allowedLanes: string[] | null; degradeLane?: string | null };
}

// Fail-open classification default (principle 3 + 5): a degraded classifier
// result that pins `balanced` via the resolver's decided_by==="default" path.
function defaultClassification(): Classification {
  return {
    task_type: "general",
    complexity: "medium",
    confidence: 0,
    decided_by: "default",
    constraints: {},
    explanation: [],
  };
}

// Run classify with a hard fail-open boundary: any throw degrades to the default
// classification rather than bubbling into a 5xx.
async function classifySafe(
  req: InternalRequest,
  classify: RouteDeps["classify"],
): Promise<Classification> {
  try {
    return await classify(req);
  } catch {
    return defaultClassification();
  }
}

// Expand a selected lane into an ordered candidate chain (primary/fallback,
// recursive lane refs, deduped, cycle-safe). The implementation lives in
// lanes/expand-chain so routing and the public model listing share one
// definition (docs/04).
const expandChain = expandLaneChain;

// Build the PolicyContext the engine matches on, from the classification.
function policyContext(req: InternalRequest, cls: Classification): PolicyContext {
  return {
    task_type: cls.task_type,
    complexity: cls.complexity,
    needs_json: cls.constraints.needs_json === true,
    needs_tools: cls.constraints.needs_tools === true,
    needs_vision: cls.constraints.needs_vision === true,
    user_id: req.user_id,
    org_id: req.org_id,
    // project_id is a MEMORY-scope field (client-controlled via the x-project-id
    // header, docs/08), NOT a trusted routing attribute. Sourcing the client value
    // here would let any caller spoof a project_id policy to change lane/cost/caps
    // — memory must never rewrite routing (docs/08). user_id/org_id come from the
    // trusted auth identity; project-scoped routing needs an equivalent trusted
    // source (auth/account), which does not exist yet, so it is null.
    project_id: null,
  };
}

// Narrow the orchestrator classification to the resolver's minimal shape.
function forResolver(cls: Classification): ResolverClassification {
  return {
    task_type: cls.task_type,
    complexity: cls.complexity,
    decided_by: cls.decided_by,
    constraints: cls.constraints,
  };
}

interface PlanDecision {
  plan: ExecutionPlan;
  classifier: DecisionRecord["classifier"];
  policy: DecisionRecord["policy"];
  /** Layer-2 eval self-cost (USD), non-null ONLY when eval ran. Threaded into
   *  cost_breakdown.eval_usd, kept separate from completion cost (principle 5). */
  evalUsd: number | null;
}

// An explicit passthrough rejected BEFORE execution (unknown model / lane not in
// the key's allowed_lanes — docs/04 strict validation). Carries everything the
// orchestrator needs to log a complete error DecisionRecord without executing:
// `selectedLane` is the requested name (chain stays empty — nothing was planned).
interface PlanRejection {
  reject: HelmError;
  selectedLane: string;
}

function isRejection(p: PlanDecision | PlanRejection): p is PlanRejection {
  return "reject" in p;
}

// The classifier segment shared by ALL explicit-passthrough outcomes (model,
// lane, and their rejections). task_type:"passthrough" (NOT decided_by) is the
// disambiguator: explicit passthrough and the classifier-crash fail-open BOTH
// record decided_by:"default", so do not read decided_by to tell them apart —
// passthrough is uniquely identified by task_type/complexity:"passthrough"
// (crash fail-open uses task_type:"general", complexity:"medium").
function passthroughClassifier(): DecisionRecord["classifier"] {
  return {
    task_type: "passthrough",
    complexity: "passthrough",
    confidence: 1,
    decided_by: "default",
    eval_cache_hit: null,
    fallback_reason: null,
    constraints: {},
    explanation: [],
  };
}

// Compute the execution plan + the classifier/policy decision segments. Explicit
// passthrough short-circuits classify/policy/resolver entirely (docs/04: highest
// priority, gated by allow_custom_model).
async function plan(
  req: InternalRequest,
  deps: RouteDeps,
  opts: RouteOptions,
): Promise<PlanDecision | PlanRejection> {
  // 1) Explicit passthrough — bypass the whole routing brain. The model field
  //    may name a concrete MODEL (chain = [model]) or a LANE (chain = the lane's
  //    expanded fallback chain, docs/04 "explicit model/lane").
  //    `auto` is the canonical "let the router decide" sentinel and must NEVER be
  //    treated as an explicit model, even for an allow_custom_model key — otherwise
  //    it short-circuits classify/lane-resolve and gets sent upstream as the literal
  //    model "auto" (the llm-router #391 regression). Fall through to classify.
  //    A key that is OVER its usage budget and set to `degrade` (opts.keyCaps.
  //    degradeLane is populated for this request) must NOT be able to bypass the
  //    downgrade by naming an expensive explicit model OR lane — so suppress
  //    passthrough while degrading and fall through to the forced degrade lane
  //    below (docs/06).
  if (
    opts.allowCustomModel === true &&
    req.requested_model.length > 0 &&
    req.requested_model !== "auto" &&
    (opts.keyCaps?.degradeLane === undefined || opts.keyCaps.degradeLane === null)
  ) {
    const model = req.requested_model;

    // 1a) Explicit LANE — lanes shadow same-named model aliases. The lane runs
    //     with full fallback semantics (expandChain), but must sit inside the
    //     key's allowed_lanes whitelist: unlike classified routing (where
    //     applyCaps silently clamps), an EXPLICIT ask for a forbidden lane is a
    //     client error and is rejected loudly (no silent downgrade). An empty
    //     allowedLanes array is inactive, mirroring applyCaps' activation rule.
    if (Object.hasOwn(deps.lanes, model)) {
      const allowed = opts.keyCaps?.allowedLanes;
      if (allowed != null && allowed.length > 0 && !allowed.includes(model)) {
        return {
          reject: makeHelmError({
            error_class: "invalid_request",
            message: `lane "${model}" is not permitted for this key (allowed_lanes)`,
            trace_id: req.request_id,
          }),
          selectedLane: model,
        };
      }
      return {
        plan: {
          selected_lane: model,
          candidate_chain: expandChain(model, deps.lanes),
          explicit_model: null,
        },
        classifier: passthroughClassifier(),
        policy: { matched_policy_id: null, reason: "explicit lane passthrough" },
        evalUsd: null,
      };
    }

    // 1b) Explicit MODEL — strict validation when the deployment wired
    //     isKnownModel: an unknown name is a client error (invalid_request),
    //     NEVER a silent Phase-0 fall-through to the default provider.
    if (deps.isKnownModel !== undefined && !deps.isKnownModel(model)) {
      return {
        reject: makeHelmError({
          error_class: "invalid_request",
          message: `unknown model or lane "${model}"`,
          trace_id: req.request_id,
        }),
        selectedLane: model,
      };
    }
    return {
      plan: { selected_lane: model, candidate_chain: [model], explicit_model: model },
      classifier: passthroughClassifier(),
      policy: { matched_policy_id: null, reason: "explicit model passthrough" },
      evalUsd: null,
    };
  }

  // 2) Classify (fail-open) → policy → lane-resolver (+caps).
  const cls = await classifySafe(req, deps.classify);
  const outcome = evaluatePolicies(policyContext(req, cls), deps.policies);
  const laneDecision = resolveLane({
    classification: forResolver(cls),
    policy: {
      matched_policy_id: outcome.matched_policy_id,
      use_lane: outcome.use_lane,
      reason: outcome.reason,
    },
    lanes: deps.lanes,
  });
  // Policy caps first (the resolver's lane choice, narrowed by matched policies).
  const policyCappedLane = applyCaps(laneDecision.selected_lane, outcome);
  // Per-key lane caps LAST: the OUTER, non-negotiable bound from the API key's
  // auth record. Applied after policy caps so the key wins even over a policy
  // use_lane pin (principle 6: lanes are the user-facing abstraction; a key may
  // be confined to a subset). keyCaps undefined => no-op.
  //
  // Over-budget degrade (docs/06): when `degradeLane` is set for this request, FORCE
  // the request onto it (a forced selection, not a rank ceiling) so it works for any
  // target lane — ranked OR a task lane — which a `max_lane` ceiling would silently
  // ignore. The forced lane is then clamped to the key's `allowedLanes` whitelist
  // (the harder security bound) via applyCaps, exactly as the normal lane is.
  let cappedLane: string;
  if (opts.keyCaps === undefined) {
    cappedLane = policyCappedLane;
  } else {
    const base = opts.keyCaps.degradeLane ?? policyCappedLane;
    cappedLane = applyCaps(base, {
      matched_policy_id: null,
      use_lane: null,
      max_lane: null,
      allowed_lanes: opts.keyCaps.allowedLanes,
      reason: "key caps",
    });
  }
  const chain = expandChain(cappedLane, deps.lanes);

  return {
    plan: { selected_lane: cappedLane, candidate_chain: chain, explicit_model: null },
    classifier: {
      task_type: cls.task_type,
      complexity: cls.complexity,
      confidence: cls.confidence,
      decided_by: cls.decided_by,
      // Thread Layer-2 eval observability straight from the classify adapter
      // (cascade). null/undefined collapse to null so the record never carries
      // an ambiguous undefined (principle 5: classification fields only).
      eval_cache_hit: cls.eval_cache_hit ?? null,
      fallback_reason: cls.fallback_reason ?? null,
      constraints: cls.constraints as Record<string, unknown>,
      explanation: cls.explanation,
    },
    policy: { matched_policy_id: outcome.matched_policy_id, reason: outcome.reason },
    evalUsd: cls.eval_usd ?? null,
  };
}

export async function routeRequest(
  req: InternalRequest,
  deps: RouteDeps,
  opts: RouteOptions = {},
): Promise<ExecutionResult> {
  const planned = await plan(req, deps, opts);

  // Explicit passthrough rejected before execution (unknown model / lane not
  // permitted): no provider was attempted, but the rejection is still a routing
  // decision — log a complete error record (empty chain, no attempts, costs
  // unknown) so it shows up in the Debug UI like any other terminal error.
  if (isRejection(planned)) {
    const decision: DecisionRecord = {
      request_id: req.request_id,
      trace_id: req.request_id,
      requested_model: req.requested_model,
      key_prefix: opts.keyPrefix ?? null,
      classifier: passthroughClassifier(),
      policy: { matched_policy_id: null, reason: "explicit passthrough rejected" },
      lane: { selected_lane: planned.selectedLane, candidate_chain: [] },
      provider_attempts: [],
      final: {
        model_alias: null,
        provider_model: null,
        status: "error",
        error_reason: planned.reject.error_class,
      },
      latency_total_ms: 0,
      fallback_count: 0,
      cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
      // Stamped by the GATEWAY after inject ran (memory is a middleware) — the
      // routing core always emits null.
      memory: null,
    };
    deps.log(decision);
    return {
      decision,
      final: { status: "error" },
      body: null,
      stream: null,
      error: planned.reject,
    };
  }

  const { plan: execPlan, classifier, policy, evalUsd } = planned;

  const outcome = await deps.execute(execPlan, req);

  const finalRecord: DecisionRecord["final"] =
    outcome.final.status === "ok"
      ? {
          model_alias: outcome.final.alias,
          provider_model: outcome.final.providerModel,
          status: "ok",
          error_reason: null,
        }
      : {
          model_alias: null,
          provider_model: null,
          status: "error",
          error_reason: outcome.final.error.error_class,
        };

  // completion_usd = Σ served attempts' cost; null (not 0) when none measured so
  // "unknown" stays distinct from "free". eval_usd is the Layer-2 self-cost.
  const completionUsd = outcome.attempts.reduce<number | null>((acc, a) => {
    if (a.cost_usd === null) return acc;
    return (acc ?? 0) + a.cost_usd;
  }, null);
  const totalUsd =
    evalUsd === null && completionUsd === null ? null : (evalUsd ?? 0) + (completionUsd ?? 0);
  // EXECUTION-stage fallback count (principle 5): non-skipped attempts beyond the
  // first, clamped ≥0. Skipped candidates (capability filter / circuit-open) are
  // not swaps and never counted.
  const servedAttempts = outcome.attempts.filter((a) => !a.skipped).length;

  const decision: DecisionRecord = {
    request_id: req.request_id,
    trace_id: req.request_id,
    requested_model: req.requested_model,
    key_prefix: opts.keyPrefix ?? null,
    classifier,
    policy,
    lane: { selected_lane: execPlan.selected_lane, candidate_chain: execPlan.candidate_chain },
    provider_attempts: outcome.attempts,
    final: finalRecord,
    latency_total_ms: outcome.attempts.reduce((acc, a) => acc + a.latency_ms, 0),
    fallback_count: Math.max(0, servedAttempts - 1),
    cost_breakdown: {
      eval_usd: evalUsd,
      completion_usd: completionUsd,
      total_usd: totalUsd,
    },
    // Stamped by the GATEWAY after inject ran (memory is a middleware) — the
    // routing core always emits null.
    memory: null,
  };

  deps.log(decision);

  if (outcome.final.status === "ok") {
    return {
      decision,
      final: { status: "ok", alias: outcome.final.alias },
      body: outcome.body,
      stream: outcome.stream,
      error: null,
    };
  }
  return {
    decision,
    final: { status: "error" },
    body: null,
    stream: null,
    error: outcome.final.error,
  };
}
