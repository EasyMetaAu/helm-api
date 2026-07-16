import type { ClassifierConfig, EvalOutput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CascadeDeps,
  type ClassificationResult,
  classify,
  type EvalDecisionResult,
  type RulesResult,
} from "./cascade.js";
import type { ClassifierInput } from "./eval/cache-key.js";

// eval.cascade tests — Layer-2 wiring: rules (Layer 1) -> eval (Layer 2, only
// when enabled & confidence < threshold) -> balanced (Layer 3 fail-open). Every
// dep is mocked so the cascade's CONTROL FLOW is asserted in isolation: hit-stop
// (rules high-confidence never touches eval), the two distinct balanced paths
// (eval disabled vs eval fail-open) with distinct `fallback_reason`, decision
// record completeness, and that NO provider/execution-fallback field leaks in.

const INPUT: ClassifierInput = {
  messages: [{ role: "user", content: "hello" }],
  tools: null,
  response_format: null,
  attachments: null,
};

const THRESHOLD = 0.45;

function makeConfig(opts: {
  evalEnabled: boolean;
  rulesEnabled?: boolean;
  threshold?: number;
}): ClassifierConfig {
  return {
    rules: {
      enabled: opts.rulesEnabled ?? true,
      confidence_threshold: opts.threshold ?? THRESHOLD,
    },
    eval: { enabled: opts.evalEnabled },
    // The cascade only reads rules.enabled/confidence_threshold + eval.enabled; the rest
    // of the (large) ClassifierConfig is irrelevant here.
  } as unknown as ClassifierConfig;
}

function rules(over: Partial<RulesResult> = {}): RulesResult {
  return {
    complexity: "standard",
    task_type: "chat",
    confidence: 0.9,
    ...over,
  };
}

const EVAL_OUTPUT: EvalOutput = { complexity: "complex", task_type: "coding", confidence: 0.8 };

function makeDeps(over: {
  rules?: RulesResult;
  config: ClassifierConfig;
  runEvalCached?: CascadeDeps["runEvalCached"];
  resolveLane?: CascadeDeps["resolveLane"];
}): {
  deps: CascadeDeps;
  runEvalCached: ReturnType<typeof vi.fn>;
  runRules: ReturnType<typeof vi.fn>;
} {
  const runEvalCached =
    (over.runEvalCached as ReturnType<typeof vi.fn>) ??
    vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: true,
        output: EVAL_OUTPUT,
        latency_ms: 1,
        cost_usd: 0.00002,
        cache_hit: false,
      }),
    );
  const resolveLane =
    over.resolveLane ?? ((complexity, taskType) => `lane:${complexity}:${taskType}`);
  const runRules = vi.fn(() => over.rules ?? rules());
  return {
    deps: {
      runRules,
      runEvalCached,
      resolveLane,
      config: over.config,
    },
    runEvalCached,
    runRules,
  };
}

describe("classify — cascade control flow", () => {
  it("1. rules high-confidence -> never touches eval (hit-stop)", async () => {
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: 0.9, complexity: "complex", task_type: "coding" }),
      config: makeConfig({ evalEnabled: true }), // even with eval ON
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("rules");
    expect(res.eval_used).toBe(false);
    expect(res.eval_cache_hit).toBe(false);
    expect(res.lane).toBe("lane:complex:coding");
    expect(res.complexity).toBe("complex");
    expect(res.task_type).toBe("coding");
    expect(res.confidence).toBe(0.9);
    expect(runEvalCached).not.toHaveBeenCalled();
  });

  it("2. eval disabled + low confidence -> balanced (eval_disabled)", async () => {
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: false }),
    });

    const res = await classify(INPUT, deps);

    expect(res.lane).toBe("balanced");
    expect(res.decided_by).toBe("fallback");
    expect(res.fallback_reason).toBe("eval_disabled");
    expect(res.eval_used).toBe(false);
    expect(res.eval_cache_hit).toBe(false);
    expect(runEvalCached).not.toHaveBeenCalled();
  });

  it("2b. rules disabled + eval enabled skips Layer 1 and runs eval directly", async () => {
    const { deps, runRules, runEvalCached } = makeDeps({
      config: makeConfig({ rulesEnabled: false, evalEnabled: true }),
    });
    const res = await classify(INPUT, deps);

    expect(runRules).not.toHaveBeenCalled();
    expect(runEvalCached).toHaveBeenCalledOnce();
    expect(res.decided_by).toBe("eval");
    expect(res.rules_confidence).toBeNull();
  });

  it("2c. rules and eval disabled skip both layers and use the balanced fallback", async () => {
    const { deps, runRules, runEvalCached } = makeDeps({
      config: makeConfig({ rulesEnabled: false, evalEnabled: false }),
    });
    const res = await classify(INPUT, deps);

    expect(runRules).not.toHaveBeenCalled();
    expect(runEvalCached).not.toHaveBeenCalled();
    expect(res.lane).toBe("balanced");
    expect(res.decided_by).toBe("fallback");
    expect(res.fallback_reason).toBe("rules_and_eval_disabled");
    expect(res.rules_confidence).toBeNull();
  });

  it("3. low confidence triggers eval -> eval decides the lane", async () => {
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: true }),
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("eval");
    expect(res.eval_used).toBe(true);
    expect(res.complexity).toBe("complex");
    expect(res.task_type).toBe("coding");
    expect(res.confidence).toBe(0.8);
    // The eval verdict REPLACED the rules one — but the Layer-1 gate value that
    // caused the escalation survives separately (the "why eval ran" record).
    expect(res.rules_confidence).toBe(0.1);
    // lane derived from eval output via resolveLane
    expect(res.lane).toBe("lane:complex:coding");
    expect(runEvalCached).toHaveBeenCalledTimes(1);
  });

  it("3b. rules_confidence equals confidence on the rules and fallback paths", async () => {
    const rulesRes = await classify(
      INPUT,
      makeDeps({ rules: rules({ confidence: 0.9 }), config: makeConfig({ evalEnabled: true }) })
        .deps,
    );
    expect(rulesRes.decided_by).toBe("rules");
    expect(rulesRes.rules_confidence).toBe(rulesRes.confidence);

    const fb = await classify(
      INPUT,
      makeDeps({ rules: rules({ confidence: 0.2 }), config: makeConfig({ evalEnabled: false }) })
        .deps,
    );
    expect(fb.decided_by).toBe("fallback");
    expect(fb.rules_confidence).toBe(0.2);
    expect(fb.rules_confidence).toBe(fb.confidence);
  });

  it("4. eval cache hit is propagated", async () => {
    const runEvalCached = vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: true,
        output: EVAL_OUTPUT,
        latency_ms: 0,
        // Cache hit → no new model call, so no incremental eval self-cost.
        cost_usd: null,
        cache_hit: true,
      }),
    );
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: true }),
      runEvalCached,
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("eval");
    expect(res.eval_used).toBe(true);
    expect(res.eval_cache_hit).toBe(true);
  });

  it("4b. eval self-cost (eval_usd) surfaces from a decided eval", async () => {
    const runEvalCached = vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: true,
        output: EVAL_OUTPUT,
        latency_ms: 3,
        cost_usd: 0.00002,
        cache_hit: false,
      }),
    );
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: true }),
      runEvalCached,
    });

    const res = await classify(INPUT, deps);
    expect(res.decided_by).toBe("eval");
    expect(res.eval_usd).toBeCloseTo(0.00002);
  });

  it("4c. eval_usd is null when eval did not run (rules hit-stop)", async () => {
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.9 }),
      config: makeConfig({ evalEnabled: true }),
    });
    const res = await classify(INPUT, deps);
    expect(res.decided_by).toBe("rules");
    expect(res.eval_usd).toBeNull();
    // Rules hit-stop: eval never ran → no latency.
    expect(res.eval_latency_ms).toBeNull();
  });

  it("4d. eval_latency_ms surfaces the decided eval's measured latency", async () => {
    const runEvalCached = vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: true,
        output: EVAL_OUTPUT,
        latency_ms: 1234,
        cost_usd: 0.00002,
        cache_hit: false,
      }),
    );
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: true }),
      runEvalCached,
    });
    const res = await classify(INPUT, deps);
    expect(res.decided_by).toBe("eval");
    expect(res.eval_latency_ms).toBe(1234);
  });

  it("4e. eval_latency_ms is null when eval is disabled (no Layer-2 call)", async () => {
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: false }),
    });
    const res = await classify(INPUT, deps);
    expect(res.fallback_reason).toBe("eval_disabled");
    expect(res.eval_latency_ms).toBeNull();
  });

  it("5. eval fail-open -> balanced (eval_<reason>)", async () => {
    const runEvalCached = vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: false,
        reason: "timeout",
        latency_ms: 5,
        cache_hit: false,
      }),
    );
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.1 }),
      config: makeConfig({ evalEnabled: true }),
      runEvalCached,
    });

    const res = await classify(INPUT, deps);

    expect(res.lane).toBe("balanced");
    expect(res.decided_by).toBe("fallback");
    expect(res.fallback_reason).toBe("eval_timeout");
    expect(res.eval_used).toBe(true);
    expect(res.eval_cache_hit).toBe(false);
    // Eval ran (then failed open), so its measured latency is carried through.
    expect(res.eval_latency_ms).toBe(5);
  });

  it("5b. eval fail-open carries cache_hit through (cached fail never happens, but reason precise)", async () => {
    const runEvalCached = vi.fn(
      async (): Promise<EvalDecisionResult> => ({
        decided: false,
        reason: "schema_invalid",
        latency_ms: 2,
        cache_hit: false,
      }),
    );
    const { deps } = makeDeps({
      rules: rules({ confidence: 0.0 }),
      config: makeConfig({ evalEnabled: true }),
      runEvalCached,
    });

    const res = await classify(INPUT, deps);

    expect(res.fallback_reason).toBe("eval_schema_invalid");
    expect(res.eval_used).toBe(true);
  });

  it("6. threshold boundary: confidence === threshold goes rules (>=)", async () => {
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: THRESHOLD }),
      config: makeConfig({ evalEnabled: true }),
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("rules");
    expect(runEvalCached).not.toHaveBeenCalled();
  });

  it("6b. threshold boundary: threshold - epsilon enters Layer 2", async () => {
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: THRESHOLD - 1e-9 }),
      config: makeConfig({ evalEnabled: true }),
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("eval");
    expect(runEvalCached).toHaveBeenCalledTimes(1);
  });

  it("7. decision record fields complete & non-contradictory on every path", async () => {
    // rules path
    const r1 = await classify(INPUT, makeDeps({ config: makeConfig({ evalEnabled: true }) }).deps);
    expect(r1.eval_used).toBe(false);
    expect(r1.eval_cache_hit).toBe(false); // never undefined
    expect(r1.fallback_reason).toBeUndefined();

    // eval-disabled fallback
    const r2 = await classify(
      INPUT,
      makeDeps({ rules: rules({ confidence: 0 }), config: makeConfig({ evalEnabled: false }) })
        .deps,
    );
    expect(r2.eval_used).toBe(false);
    expect(r2.eval_cache_hit).toBe(false);
    expect(typeof r2.fallback_reason).toBe("string");

    // eval decision
    const r3 = await classify(
      INPUT,
      makeDeps({ rules: rules({ confidence: 0 }), config: makeConfig({ evalEnabled: true }) }).deps,
    );
    expect(r3.eval_used).toBe(true);
    expect(r3.fallback_reason).toBeUndefined();
  });

  it("8. result holds NO provider/execution-fallback fields (two fallbacks stay separate)", async () => {
    const res = await classify(INPUT, makeDeps({ config: makeConfig({ evalEnabled: true }) }).deps);
    const keys = Object.keys(res);
    // classification record only; execution-fallback fields live in routing/docs04
    for (const forbidden of [
      "provider_fallback",
      "provider",
      "model",
      "attempted_models",
      "fallback_model",
      "chain_index",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("uses the configured threshold (not hard-coded 0.45)", async () => {
    // threshold 0.8: a 0.6 confidence that would pass under 0.45 must now cascade
    const { deps, runEvalCached } = makeDeps({
      rules: rules({ confidence: 0.6 }),
      config: makeConfig({ evalEnabled: true, threshold: 0.8 }),
    });

    const res = await classify(INPUT, deps);

    expect(res.decided_by).toBe("eval");
    expect(runEvalCached).toHaveBeenCalledTimes(1);
  });

  it("never throws and degrades to rules+balanced under default (eval off) config", async () => {
    const res = await classify(
      INPUT,
      makeDeps({ rules: rules({ confidence: 0 }), config: makeConfig({ evalEnabled: false }) })
        .deps,
    );
    expect(res.lane).toBe("balanced");
    expect(res.decided_by).toBe("fallback");
  });
});

// Type-level: ClassificationResult is the cascade's record shape.
const _typecheck: ClassificationResult = {
  lane: "balanced",
  complexity: "standard",
  task_type: "chat",
  confidence: 0.5,
  rules_confidence: 0.5,
  decided_by: "fallback",
  eval_used: false,
  eval_cache_hit: false,
  fallback_reason: "eval_disabled",
  // Fallback/rules path: eval did not produce an isolable self-cost.
  eval_usd: null,
  // No eval ran on this eval_disabled path → no latency.
  eval_latency_ms: null,
};
void _typecheck;
