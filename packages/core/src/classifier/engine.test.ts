import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { ClassifierDecisionSchema, ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { type ScoreRequestDeps, scoreRequest } from "./engine.js";
import { type MomentumDeps, type MomentumEntry, recordMomentum } from "./momentum.js";
import { createMemoryMomentumStore } from "./momentum-store.js";

// The engine is the SINGLE Layer-1 entry point: it orchestrates
// dimensions → momentum → tiers → overrides → taskdetect into one
// ClassificationResult that maps cleanly onto @helm/shared
// ClassifierDecisionSchema. These tests pin the orchestration contract
// (red → green), not the internals of each pure sub-function.

// Parse through the REAL schema so defaults match production (config-as-code).
// Tests that need a specific boundary/keyword merge a partial override in.
function makeConfig(over: Record<string, unknown> = {}): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {
      reasoning_kw: { weight: 0.35, keywords: ["prove", "derive", "theorem", "step by step"] },
      coding_kw: { weight: 0.2, keywords: ["refactor", "debug", "function", "compile"] },
      chitchat_kw: { weight: -0.2, keywords: ["how are you", "good morning"] },
      simple_kw: { weight: -0.25, keywords: ["hi", "thanks", "ok", "ping"] },
      has_code_block: { weight: 0.2 },
      has_stack: { weight: 0.15 },
      has_attachment: { weight: 0.1 },
      msg_length: { weight: 0.1 },
      tool_count: { weight: 0.08 },
    },
    task_keywords: {
      coding: ["function", "class", "bug", "compile", "refactor"],
      math: ["integral", "matrix", "equation"],
      writing: ["essay", "rewrite", "draft"],
    },
    tool_prefixes: {
      coding: ["code_", "shell_"],
      web: ["browser_"],
    },
    task_activation: { web: 3.0 },
    tier_boundaries: {},
    overrides: {},
    momentum: {},
    ...over,
  });
}

// A minimal valid InternalRequest with only the fields the classifier reads
// being meaningful; the rest are filled with valid placeholders.
function makeRequest(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acc-1",
    api_key_id: "key-1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hello" }],
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
  };
}

const NOW = 1_700_000_000_000;

function momentumDeps(opts: {
  cfg: ClassifierRulesConfig;
  seed?: { sessionKey: string; entries: MomentumEntry[] };
}): MomentumDeps {
  const store = createMemoryMomentumStore();
  if (opts.seed) {
    for (const e of opts.seed.entries) store.push(opts.seed.sessionKey, e);
  }
  return { store, now: () => NOW, cfg: opts.cfg };
}

describe("scoreRequest — Layer-1 orchestration", () => {
  it("1. end-to-end normal: a mid coding request scores sanely (normal)", () => {
    const cfg = makeConfig();
    const req = makeRequest({
      messages: [
        {
          role: "user",
          content:
            "Please refactor this function and debug the failing compile error step by step.",
        },
      ],
    });
    const deps: ScoreRequestDeps = { cfg, approxTokens: 30 };

    const out = scoreRequest(req, deps);

    expect(out.decided_by).toBe("rules");
    expect(out.task_type).toBe("coding");
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(["simple", "standard", "complex", "reasoning"]).toContain(out.complexity);
    expect(out.explanation.length).toBeGreaterThan(0);
    // at least one dimension-source explanation entry
    expect(out.explanation.some((e) => e.source === "dimension")).toBe(true);
  });

  it("2. override beats score: HEARTBEAT_OK pins simple (edge)", () => {
    const cfg = makeConfig();
    // include junk dimension hits, but the whole last user message IS the token
    const req = makeRequest({
      messages: [
        { role: "user", content: "refactor debug compile function" },
        { role: "user", content: "HEARTBEAT_OK" },
      ],
    });
    const out = scoreRequest(req, { cfg, approxTokens: 5 });

    expect(out.complexity).toBe("simple");
    expect(out.explanation.some((e) => e.source === "override")).toBe(true);
  });

  it("3. low confidence → uncertain, no eval call (edge)", () => {
    // Raise the threshold so even the sigmoid floor (~0.5 near a boundary) is
    // below it → uncertain true. The engine only MARKS; it must not call eval.
    const cfg = makeConfig({
      confidence_threshold: 0.99,
      tier_boundaries: { standard: 0, complex: 0.5, reasoning: 1 },
    });
    // empty-ish message → rawScore ~ 0, right on the `standard` boundary.
    const req = makeRequest({ messages: [{ role: "user", content: "k" }] });

    const out = scoreRequest(req, { cfg, approxTokens: 1 });

    expect(out.uncertain).toBe(true);
    expect(out.confidence).toBeLessThan(0.99);
    expect(out.decided_by).toBe("rules"); // never flips to eval here
  });

  it("4. constraints derive: tools floor + vision (normal)", () => {
    const cfg = makeConfig();
    // Plain, non-short message so the `short_message` shortcut (which, like any
    // `set` override, would pin `simple`) does not fire — leaving the tools_floor
    // raise as the thing under test.
    const reqTools = makeRequest({
      messages: [
        {
          role: "user",
          content: "Could you look up the current weather for me using the available tool?",
        },
      ],
      tools: [{ type: "function", function: { name: "code_search" } }],
    });
    const outTools = scoreRequest(reqTools, { cfg, approxTokens: 5 });
    expect(outTools.constraints.needs_tools).toBe(true);
    // tools_floor raises complexity to >= standard
    expect(["standard", "complex", "reasoning"]).toContain(outTools.complexity);

    const reqVision = makeRequest({
      messages: [{ role: "user", content: "what is in this picture?" }],
      attachments: [{ type: "image", url: "x" }],
    });
    const outVision = scoreRequest(reqVision, { cfg, approxTokens: 5 });
    expect(outVision.constraints.needs_vision).toBe(true);
    expect(outVision.task_type).toBe("vision");

    const reqJson = makeRequest({
      messages: [{ role: "user", content: "give json" }],
      response_format: { type: "json_object" },
    });
    const outJson = scoreRequest(reqJson, { cfg, approxTokens: 5 });
    expect(outJson.constraints.needs_json).toBe(true);
  });

  it("5. momentum pull-through raises the tier; absent momentum does not (edge)", () => {
    const cfg = makeConfig();
    const sessionKey = "sess-1";
    const entries: MomentumEntry[] = [
      { complexity: "reasoning", rawScore: 0.6, at: NOW - 1000 },
      { complexity: "reasoning", rawScore: 0.6, at: NOW - 800 },
    ];
    const req = makeRequest({
      messages: [{ role: "user", content: "yes" }], // tiny follow-up
      metadata: {
        conversation_id: sessionKey,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
    });

    const withMomentum = scoreRequest(req, {
      cfg,
      approxTokens: 2,
      momentum: momentumDeps({ cfg, seed: { sessionKey, entries } }),
    });
    const withoutMomentum = scoreRequest(req, { cfg, approxTokens: 2 });

    // momentum drags the short follow-up up the tier ladder
    const rank = { simple: 0, standard: 1, complex: 2, reasoning: 3 } as const;
    expect(rank[withMomentum.complexity]).toBeGreaterThan(rank[withoutMomentum.complexity]);
    expect(withMomentum.explanation.some((e) => e.source === "momentum")).toBe(true);
  });

  it("6. result maps onto ClassifierDecisionSchema and parses (edge)", () => {
    const cfg = makeConfig();
    const req = makeRequest({
      messages: [{ role: "user", content: "refactor this function" }],
    });
    const out = scoreRequest(req, { cfg, approxTokens: 10 });

    const decision = {
      task_type: out.task_type,
      complexity: out.complexity,
      confidence: out.confidence,
      decided_by: out.decided_by,
      eval_cache_hit: null,
      constraints: { ...out.constraints },
      explanation: out.explanation,
    };
    const parsed = ClassifierDecisionSchema.parse(decision);
    expect(parsed.decided_by).toBe("rules");
    expect(parsed.eval_cache_hit).toBeNull();
    expect(parsed.constraints.needs_tools).toBe(false);
  });

  it("7. deterministic: same req + same momentum snapshot → equal result (edge)", () => {
    const cfg = makeConfig();
    const sessionKey = "sess-det";
    const entries: MomentumEntry[] = [{ complexity: "complex", rawScore: 0.2, at: NOW - 500 }];
    const req = makeRequest({
      messages: [{ role: "user", content: "and then?" }],
      metadata: {
        conversation_id: sessionKey,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
    });

    // Two independent momentum stores seeded with the SAME snapshot → the
    // recordMomentum write-back must not make the second call differ.
    const a = scoreRequest(req, {
      cfg,
      approxTokens: 4,
      momentum: momentumDeps({ cfg, seed: { sessionKey, entries: [...entries] } }),
    });
    const b = scoreRequest(req, {
      cfg,
      approxTokens: 4,
      momentum: momentumDeps({ cfg, seed: { sessionKey, entries: [...entries] } }),
    });
    expect(a).toEqual(b);
  });

  it("8. fail-open: degenerate input does not throw, yields safe defaults (failure)", () => {
    const cfg = makeConfig();
    const req = makeRequest({
      messages: [{ role: "user", content: "   " }],
      // malformed tools array (not OpenAI shape) must not crash detection
      tools: [42, { weird: true }, null],
    });

    expect(() => scoreRequest(req, { cfg, approxTokens: 0 })).not.toThrow();
    const out = scoreRequest(req, { cfg, approxTokens: 0 });
    expect(["simple", "standard", "complex", "reasoning"]).toContain(out.complexity);
    expect(out.task_type).toBe("chat"); // safe default
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });

  // ── language-coverage guard ────────────────────────────────────────────────
  // The keyword lists are English-only, so a predominantly non-Latin prompt can't
  // be scored by them. The guard forces `uncertain` (confidence 0) so the cascade
  // escalates to the multilingual Layer-2 eval — UNLESS a content-type structural
  // signal gave real grip, or the message is trivially short. See plan / notes
  // (classifier.multilingual-guard).
  const longZh =
    "请帮我详细分析这家公司过去三年的财务状况和现金流情况，并结合所在行业的整体趋势给出具体的投资建议以及主要风险点的评估和应对措施";

  it("language guard: long non-Latin prose with no structural grip is forced uncertain", () => {
    const cfg = makeConfig();
    const req = makeRequest({ messages: [{ role: "user", content: longZh }] });
    const out = scoreRequest(req, { cfg, approxTokens: 40 });

    expect(out.uncertain).toBe(true);
    expect(out.confidence).toBe(0);
    expect(out.explanation.some((e) => e.detail === "low_keyword_coverage")).toBe(true);
  });

  it("language guard: a content-type structural hit (attachment) suppresses the guard", () => {
    const cfg = makeConfig();
    const req = makeRequest({
      messages: [{ role: "user", content: longZh }],
      attachments: [{ type: "image", url: "x" }],
    });
    const out = scoreRequest(req, { cfg, approxTokens: 40 });

    // has_attachment is real, language-agnostic grip → trust the tier, do not force.
    expect(out.explanation.some((e) => e.detail === "low_keyword_coverage")).toBe(false);
  });

  it("language guard: a short non-Latin greeting stays simple, guard skipped", () => {
    const cfg = makeConfig();
    const req = makeRequest({ messages: [{ role: "user", content: "你好" }] });
    const out = scoreRequest(req, { cfg, approxTokens: 1 });

    expect(out.complexity).toBe("simple"); // short_message override still pins simple
    expect(out.explanation.some((e) => e.detail === "low_keyword_coverage")).toBe(false);
  });

  it("language guard: English prose is unaffected (ratio 0)", () => {
    const cfg = makeConfig();
    const req = makeRequest({
      messages: [
        {
          role: "user",
          content:
            "Please give me a thorough overview of how the company performed financially across the last three fiscal years.",
        },
      ],
    });
    const out = scoreRequest(req, { cfg, approxTokens: 40 });
    expect(out.explanation.some((e) => e.detail === "low_keyword_coverage")).toBe(false);
  });

  it("language guard: disabled via config → non-Latin prose not forced", () => {
    const cfg = makeConfig({ language: { non_latin_uncertain: false } });
    const req = makeRequest({ messages: [{ role: "user", content: longZh }] });
    const out = scoreRequest(req, { cfg, approxTokens: 40 });
    expect(out.explanation.some((e) => e.detail === "low_keyword_coverage")).toBe(false);
  });

  it("records final tier back into momentum history (write-back)", () => {
    const cfg = makeConfig();
    const sessionKey = "sess-wb";
    const deps = momentumDeps({ cfg });
    const req = makeRequest({
      messages: [{ role: "user", content: "prove this theorem" }],
      metadata: {
        conversation_id: sessionKey,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
    });

    expect(deps.store.get(sessionKey)).toHaveLength(0);
    scoreRequest(req, { cfg, approxTokens: 10, momentum: deps });
    const hist = deps.store.get(sessionKey);
    expect(hist).toHaveLength(1);
    const [entry] = hist;
    expect(entry?.at).toBe(NOW);
    // sanity: recordMomentum stays the shared write path
    expect(typeof recordMomentum).toBe("function");
  });
});
