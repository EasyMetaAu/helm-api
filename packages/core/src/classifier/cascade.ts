import type { ClassifierConfig } from "@helm/shared";
import type { ClassifierInput } from "./eval/cache-key.js";
import type { EvalDecision } from "./eval/client.js";
import type { TaskType } from "./taskdetect.js";
import type { Complexity } from "./tiers.js";

// eval.cascade — the THREE-layer classification cascade (docs/03 §Classification Cascade),
// hit-stop: Layer 1 rules (always-on, zero-network, pure) → Layer 2 eval (ONLY
// when rules are uncertain AND eval is enabled) → Layer 3 `balanced` fail-open.
// This is the eval module's "final assembly": the SINGLE place that references
// the `lane` concept and that translates an eval `{decided:false}` into the
// balanced lane. The earlier blocks (config / contract+client / cache) all
// deliberately avoid `lane`; responsibility converges here (CLAUDE.md principle 5).
//
// It writes the DECISION SOURCE into the classification record — `decided_by`
// (rules | eval | fallback) plus `eval_cache_hit` — so the two kinds of fallback
// stay observable and never get confused. CRITICAL (principle 5): `decided_by`
// describes ONLY the classification stage. The EXECUTION-stage provider fallback
// (→ next model in the chain) is a SEPARATE mechanism with separate fields
// (docs/04 / routing); this module never reads or writes those fields.
//
// `balanced` is the "always-safe default": whether eval is OFF or fails open, a
// lane is always produced and the main path never 5xx's (principle 3). With the
// default config (`eval.enabled:false`) the cascade degrades to the two-layer
// "rules + balanced" path — eval is a pure additive switch.

/** Lane identifier. Lanes are config-defined open strings (lanes.yaml keys);
 *  `balanced` is guaranteed present (classification-fallback terminal). */
export type LaneId = string;

/** Who decided the classification. NOT to be confused with the execution-stage
 *  provider fallback (a separate mechanism, separate fields — principle 5). */
export type DecidedBy = "rules" | "eval" | "fallback";

/** The Layer-1 rules result the cascade consumes — the minimal structural subset
 *  of `classifier.engine`'s richer `scoreRequest` output. */
export interface RulesResult {
  complexity: Complexity;
  task_type: TaskType;
  confidence: number;
}

/** The cached-eval result the cascade consumes: `eval.cache`'s `runEvalCached`
 *  return shape (the client `EvalDecision` plus the cache-hit flag). */
export type EvalDecisionResult = EvalDecision & { cache_hit: boolean };

export interface ClassificationResult {
  lane: LaneId; // resolved lane (via routing.lane-resolver)
  complexity: Complexity;
  task_type: TaskType;
  confidence: number;
  // The LAYER-1 rules confidence — the gate value that decided whether Layer 2
  // ran. On decided_by==="eval" the `confidence` above is the EVAL model's (its
  // verdict replaces the rules one), so this is the only record of why the
  // cascade escalated. Always known here (rules always run).
  rules_confidence: number;
  decided_by: DecidedBy; // observable; never conflated with provider fallback
  eval_used: boolean; // did this request actually invoke/hit Layer-2 eval
  eval_cache_hit: boolean; // eval cache hit (always false when eval unused)
  // Layer-2 eval self-cost (USD). Non-null ONLY when a fresh eval call ran and the
  // provider reported a cost; null when eval was skipped/disabled or served from
  // cache. Kept SEPARATE from completion cost downstream (docs/07; principle 5).
  eval_usd: number | null;
  // Layer-2 eval call latency (ms). Non-null whenever eval actually ran — both when
  // it decided AND when it ran then failed open; null when eval was skipped/disabled
  // (rules hit-stop / eval_disabled). CLASSIFICATION-stage timing, never the
  // execution-stage attempt latency (principle 5).
  eval_latency_ms: number | null;
  // Present ONLY when decided_by === "fallback". Distinguishes WHY we fell back:
  //   eval_disabled            — uncertain but eval is off (no Layer 2 ran)
  //   eval_<timeout|provider_error|circuit_open|not_json|schema_invalid>
  //                            — eval ran but failed open
  fallback_reason?: string;
}

export interface CascadeDeps {
  /** Layer-1 pure rule engine (classifier.engine); never network. */
  runRules: (input: ClassifierInput) => RulesResult;
  /** Layer-2 cached eval runner (eval.cache); already fail-open, never throws. */
  runEvalCached: (input: ClassifierInput) => Promise<EvalDecisionResult>;
  /** Lane resolution delegated to routing.lane-resolver — the cascade does NOT
   *  map complexity→lane itself (separation of concerns). */
  resolveLane: (complexity: Complexity, taskType: TaskType, input: ClassifierInput) => LaneId;
  /** Reads ONLY rules.confidence_threshold + eval.enabled (the rest is unused
   *  here). Threshold comes from config, never hard-coded (principle 2). */
  config: ClassifierConfig;
}

const BALANCED: LaneId = "balanced";

/**
 * Run the classification cascade. NEVER throws: rules is pure, eval is already
 * fail-open at the client layer, and the worst case lands on `balanced`. With
 * the default (eval.enabled:false) config this is a two-layer "rules + balanced"
 * pipeline.
 */
export async function classify(
  input: ClassifierInput,
  deps: CascadeDeps,
): Promise<ClassificationResult> {
  const { runRules, runEvalCached, resolveLane, config } = deps;

  // ── Layer 1: rules. Always runs, zero network. ─────────────────────────────
  const r = runRules(input);

  // Hit-stop: a high-confidence rules verdict ends here and NEVER touches eval,
  // even when eval is enabled — saving the cost and latency of a model call.
  if (r.confidence >= config.rules.confidence_threshold) {
    return {
      lane: resolveLane(r.complexity, r.task_type, input),
      complexity: r.complexity,
      task_type: r.task_type,
      confidence: r.confidence,
      rules_confidence: r.confidence,
      decided_by: "rules",
      eval_used: false,
      eval_cache_hit: false,
      eval_usd: null,
      eval_latency_ms: null,
    };
  }

  // Layer 1 was uncertain. Layer 2 only runs when eval is enabled.
  if (!config.eval.enabled) {
    // Uncertain but eval is off → balanced, distinctly tagged so this is NOT
    // confused with an eval that ran and failed. No eval ran → no latency.
    return balancedFallback(r, "eval_disabled", {
      eval_used: false,
      eval_cache_hit: false,
      eval_latency_ms: null,
    });
  }

  // ── Layer 2: eval. Already fail-open; returns decided / fail-open + cache_hit. ─
  const e = await runEvalCached(input);
  if (e.decided) {
    return {
      lane: resolveLane(e.output.complexity, e.output.task_type, input),
      complexity: e.output.complexity,
      task_type: e.output.task_type,
      confidence: e.output.confidence,
      // The eval verdict replaced the rules one above — keep the Layer-1 gate
      // value so "rules were uncertain → escalated" stays reconstructible.
      rules_confidence: r.confidence,
      decided_by: "eval",
      eval_used: true,
      eval_cache_hit: e.cache_hit,
      eval_usd: e.cost_usd,
      eval_latency_ms: e.latency_ms,
    };
  }

  // ── Layer 3: eval failed open (timeout / provider_error / dirty output) → balanced. ─
  // Eval DID run here, so carry its measured latency through the fallback.
  return balancedFallback(r, `eval_${e.reason}`, {
    eval_used: true,
    eval_cache_hit: e.cache_hit,
    eval_latency_ms: e.latency_ms,
  });
}

// Build the Layer-3 balanced fallback record. Carries the rules-stage
// complexity/task_type/confidence for telemetry continuity, but the lane is
// pinned to `balanced` and `decided_by` is "fallback" with a precise reason.
function balancedFallback(
  r: RulesResult,
  fallbackReason: string,
  evalState: { eval_used: boolean; eval_cache_hit: boolean; eval_latency_ms: number | null },
): ClassificationResult {
  return {
    lane: BALANCED,
    complexity: r.complexity,
    task_type: r.task_type,
    confidence: r.confidence,
    rules_confidence: r.confidence,
    decided_by: "fallback",
    eval_used: evalState.eval_used,
    eval_cache_hit: evalState.eval_cache_hit,
    // No successful eval verdict to attribute a self-cost to (eval was off, or it
    // ran and failed open). Treat as unmeasured.
    eval_usd: null,
    // null on eval_disabled (no eval ran); the measured latency when eval ran-then-failed.
    eval_latency_ms: evalState.eval_latency_ms,
    fallback_reason: fallbackReason,
  };
}
