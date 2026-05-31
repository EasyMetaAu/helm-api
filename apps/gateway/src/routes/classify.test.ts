import { ClassifierConfigSchema, type InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { buildClassifyAdapter, type ProviderForEval } from "./classify.js";

// classify.hotapply — pins the admin.classifier-hotapply contract: the classify
// adapter must read the CURRENT classifier config from the RuleStore per request,
// so an admin edit (flip eval.enabled / change confidence_threshold) is observed
// by the NEXT classification WITHOUT a process restart. The eval cache must be
// invalidated when the classifier config changes so a stale verdict isn't served.

const LANES = {
  economy: { primary: "cheap_model", fallback: ["balanced"], constraints: {} },
  balanced: { primary: "default_good_model", fallback: ["premium"], constraints: {} },
  premium: { primary: "best_reasoning_model", fallback: ["balanced"], constraints: {} },
} as never;

function baseClassifier() {
  return ClassifierConfigSchema.parse({
    rules: {
      tier_boundaries: {},
      dimensions: {},
      task_keywords: {},
      tool_prefixes: {},
      overrides: {},
      momentum: {},
    },
    eval: { model: "eval-model" },
  });
}

function req(text: string): InternalRequest {
  return {
    messages: [{ role: "user", content: text }],
    tools: null,
    response_format: null,
    attachments: null,
    metadata: { conversation_id: null },
  } as unknown as InternalRequest;
}

// An eval provider whose JSON verdict is controllable per call, and which counts
// how many times it was invoked (cache hits skip it).
function makeEvalProvider(
  verdict: () => { complexity: string; task_type: string; confidence: number },
) {
  const calls = { n: 0 };
  const provider: ProviderForEval = {
    chatCompletion: async () => {
      calls.n += 1;
      return {
        choices: [{ message: { content: JSON.stringify(verdict()) } }],
      };
    },
  };
  return { provider, calls };
}

describe("classify adapter — admin classifier hot-apply", () => {
  it("reads the CURRENT classifier config per request (eval toggled on without rebuild)", async () => {
    let cfg = baseClassifier();
    cfg.eval.enabled = false; // eval OFF initially
    // Force every prompt to be uncertain at Layer-1 so the eval gate is what
    // decides whether Layer-2 runs.
    cfg.rules.confidence_threshold = 1; // nothing clears the gate -> always uncertain

    const { provider, calls } = makeEvalProvider(() => ({
      complexity: "complex",
      task_type: "coding",
      confidence: 0.9,
    }));

    const classify = buildClassifyAdapter({
      getClassifierConfig: () => cfg,
      lanes: LANES,
      provider,
      now: () => Date.now(),
      log: () => {},
    });

    // eval OFF -> uncertain falls open to balanced via fallback, eval never called.
    const first = await classify(req("please refactor this function"));
    expect(calls.n).toBe(0);
    expect(first.decided_by).toBe("fallback");

    // Admin flips eval.enabled = true (a NEW config object, as the RuleStore stores
    // the freshly parsed body). No rebuild of the adapter.
    cfg = ClassifierConfigSchema.parse({
      ...cfg,
      eval: { ...cfg.eval, enabled: true },
    });

    const second = await classify(req("please refactor this other function"));
    // The change took effect: eval ran for the (cache-miss) prompt.
    expect(calls.n).toBe(1);
    expect(second.decided_by).toBe("eval");
  });

  it("invalidates the eval cache when the classifier config changes (no stale verdict)", async () => {
    let cfg = baseClassifier();
    cfg.eval.enabled = true;
    cfg.rules.confidence_threshold = 1; // always uncertain -> always cascades to eval

    let verdictConfidence = 0.91;
    const { provider, calls } = makeEvalProvider(() => ({
      complexity: "complex",
      task_type: "coding",
      confidence: verdictConfidence,
    }));

    const classify = buildClassifyAdapter({
      getClassifierConfig: () => cfg,
      lanes: LANES,
      provider,
      now: () => Date.now(),
      log: () => {},
    });

    const prompt = "summarize the meeting notes please";
    const first = await classify(req(prompt));
    expect(calls.n).toBe(1);
    expect(first.eval_cache_hit).toBe(false);

    // Same prompt again -> cache hit, eval NOT re-invoked.
    const second = await classify(req(prompt));
    expect(calls.n).toBe(1);
    expect(second.eval_cache_hit).toBe(true);

    // Admin edits the classifier config. The cache must be dropped so the next
    // identical prompt re-evaluates under the new config instead of serving the
    // stale verdict.
    verdictConfidence = 0.42;
    cfg = ClassifierConfigSchema.parse({
      ...cfg,
      rules: { ...cfg.rules, sigmoid_k: cfg.rules.sigmoid_k + 1 },
    });

    const third = await classify(req(prompt));
    expect(calls.n).toBe(2); // eval re-ran -> cache was invalidated
    expect(third.eval_cache_hit).toBe(false);
  });
});
