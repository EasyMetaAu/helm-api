import type { DecisionRecord, HelmError, InternalRequest } from "@helm/shared";
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
  eval_cache_hit?: boolean | null;
  fallback_reason?: string | null;
  constraints: {
    needs_json?: boolean;
    needs_tools?: boolean;
    needs_vision?: boolean;
    [k: string]: unknown;
  };
  explanation: unknown[];
}

// The resolved execution plan handed to execute(). For explicit passthrough the
// chain is exactly [explicit_model]; otherwise it is the selected lane's primary
// plus its (recursively expanded, deduped, cycle-safe) fallback aliases.
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
}

export interface RouteOptions {
  /** From the API key's caps (auth). Gates explicit-model passthrough (docs/04). */
  allowCustomModel?: boolean;
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

// Expand a selected lane into an ordered candidate chain. Each primary/fallback
// element may name a model alias OR another lane (docs/04). Lane references are
// expanded recursively; model aliases are appended. Dedup keeps first
// occurrence; a `visited` set bounds recursion so `a→b→a` cannot loop.
function expandChain(laneName: string, lanes: LanesConfig): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const push = (alias: string): void => {
    if (!seen.has(alias)) {
      seen.add(alias);
      chain.push(alias);
    }
  };

  const visit = (name: string, visitedLanes: Set<string>): void => {
    if (visitedLanes.has(name)) return; // cycle guard
    visitedLanes.add(name);
    const lane = lanes[name];
    if (lane === undefined) {
      // Not a lane → it is a model alias; append it.
      push(name);
      return;
    }
    // Lane: primary then fallback, each possibly a lane or an alias.
    const elements = [lane.primary, ...lane.fallback];
    for (const el of elements) {
      if (Object.hasOwn(lanes, el)) {
        visit(el, visitedLanes);
      } else {
        push(el);
      }
    }
  };

  visit(laneName, new Set<string>());
  return chain;
}

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
    project_id: req.metadata.project_id,
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
}

// Compute the execution plan + the classifier/policy decision segments. Explicit
// passthrough short-circuits classify/policy/resolver entirely (docs/04: highest
// priority, gated by allow_custom_model).
async function plan(
  req: InternalRequest,
  deps: RouteDeps,
  opts: RouteOptions,
): Promise<PlanDecision> {
  // 1) Explicit passthrough — bypass the whole routing brain.
  if (opts.allowCustomModel === true && req.requested_model.length > 0) {
    const model = req.requested_model;
    return {
      plan: { selected_lane: model, candidate_chain: [model], explicit_model: model },
      classifier: {
        task_type: "passthrough",
        complexity: "passthrough",
        confidence: 1,
        decided_by: "default",
        eval_cache_hit: null,
        fallback_reason: null,
        constraints: {},
        explanation: [],
      },
      policy: { matched_policy_id: null, reason: "explicit model passthrough" },
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
  const cappedLane = applyCaps(laneDecision.selected_lane, outcome);
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
  };
}

export async function routeRequest(
  req: InternalRequest,
  deps: RouteDeps,
  opts: RouteOptions = {},
): Promise<ExecutionResult> {
  const { plan: execPlan, classifier, policy } = await plan(req, deps, opts);

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

  const decision: DecisionRecord = {
    request_id: req.request_id,
    trace_id: req.request_id,
    requested_model: req.requested_model,
    classifier,
    policy,
    lane: { selected_lane: execPlan.selected_lane, candidate_chain: execPlan.candidate_chain },
    provider_attempts: outcome.attempts,
    final: finalRecord,
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
