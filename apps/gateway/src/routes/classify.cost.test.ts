import { type CatalogEntry, ClassifierConfigSchema, type InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { buildClassifyAdapter, type ProviderForEval } from "./classify.js";

// cost-wire (docs/07): the eval call's OWN token usage × catalog pricing →
// Classification.eval_usd (the Layer-2 self-cost, kept SEPARATE from completion
// cost). A missing pricing entry → eval_usd null, no crash.

const LANES = {
  economy: { primary: "cheap_model", fallback: ["balanced"], constraints: {} },
  balanced: { primary: "default_good_model", fallback: ["premium"], constraints: {} },
  premium: { primary: "best_reasoning_model", fallback: ["balanced"], constraints: {} },
} as never;

function classifierCfg() {
  const cfg = ClassifierConfigSchema.parse({
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
  cfg.eval.enabled = true; // eval ON
  cfg.rules.confidence_threshold = 1; // always uncertain at Layer-1 → eval runs
  return cfg;
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

// Eval provider returning a valid verdict + OpenAI-shaped usage.
function evalProviderWithUsage(prompt: number, completion: number): ProviderForEval {
  return {
    chatCompletion: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              complexity: "complex",
              task_type: "coding",
              confidence: 0.9,
            }),
          },
        },
      ],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    }),
  };
}

function priced(modelKey: string, pricing: CatalogEntry["pricing"]): CatalogEntry {
  return {
    modelKey,
    capabilities: {
      supportsTools: false,
      supportsJsonMode: false,
      supportsVision: false,
      supportsStreaming: false,
      maxContextTokens: 0,
      maxOutputTokens: null,
    },
    pricing,
    source: "generated",
  };
}

describe("classify adapter — eval self-cost from usage × catalog pricing", () => {
  it("records eval_usd = prompt/1e6*input + completion/1e6*output for a fresh eval call", async () => {
    // eval-model priced $0.15/MTok in, $0.60/MTok out. usage 400 prompt + 100 completion:
    //   400/1e6*0.15 = 0.00006 ; 100/1e6*0.60 = 0.00006 ; total = 0.00012.
    const classify = buildClassifyAdapter({
      getClassifierConfig: classifierCfg,
      lanes: LANES,
      provider: evalProviderWithUsage(400, 100),
      now: () => Date.now(),
      log: () => {},
      catalog: new Map([
        ["eval-model", priced("eval-model", { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 })],
      ]),
    });

    const cls = await classify(req("write a compiler"));
    expect(cls.decided_by).toBe("eval");
    expect(cls.eval_usd).toBeCloseTo(0.00012, 12);
  });

  it("records eval_usd = null (no crash) when the eval model has no pricing entry", async () => {
    const classify = buildClassifyAdapter({
      getClassifierConfig: classifierCfg,
      lanes: LANES,
      provider: evalProviderWithUsage(400, 100),
      now: () => Date.now(),
      log: () => {},
      catalog: new Map(), // no pricing for eval-model
    });

    const cls = await classify(req("write a compiler"));
    expect(cls.decided_by).toBe("eval");
    expect(cls.eval_usd).toBeNull();
  });
});
