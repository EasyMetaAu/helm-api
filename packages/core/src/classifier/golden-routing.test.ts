import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  routeRequest,
} from "../routing/route-request.js";
import { scoreRequest } from "./engine.js";
import type { Complexity } from "./tiers.js";

// GOLDEN baseline — a table-driven snapshot of the FULL Layer-1 classify + route
// decision over a representative prompt set, computed against TODAY's shipped
// config (config/classifier.yaml + lanes.yaml + policies.yaml). It does NOT
// assert what behavior SHOULD be — it characterizes what behavior IS, so any
// later phase that changes routing without intending to is caught red.
//
// Pure / network-free (CLAUDE.md principle 1/4): Layer-1 `scoreRequest` only
// (eval is OFF by default and never invoked here); momentum is NOT injected so
// each prompt is judged in isolation (deterministic). The classifier's four
// tiers are collapsed through the SAME `mapComplexity` the gateway uses
// (apps/gateway/src/routes/classify.ts), then `routeRequest` resolves the lane
// from the real policies + lanes. We read the resolved lane from the
// DecisionRecord, exactly as the gateway would.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");
const config = loadConfig({ configDir, env: {} });
const rulesCfg = config.classifier.rules;
if (config.lanes === undefined) {
  throw new Error("config/lanes.yaml must load into config.lanes");
}
const lanes = config.lanes;

// The gateway's tier collapse (classify.ts mapComplexity): standard->medium,
// complex & reasoning -> complex, else simple. Phase 0 KEEPS this collapse.
function mapComplexity(c: Complexity): Classification["complexity"] {
  switch (c) {
    case "standard":
      return "medium";
    case "reasoning":
      return "complex";
    case "complex":
      return "complex";
    default:
      return "simple";
  }
}

function approxTokens(req: InternalRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
  }
  return Math.ceil(chars / 4);
}

function req(content: string, over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "golden",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content }],
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

// A stub executor that lands on the head candidate; we only read the lane.
function okExecute(plan: ExecutionPlan): ExecuteOutcome {
  const head = plan.candidate_chain[0] ?? "none";
  return {
    attempts: [
      {
        alias: head,
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1,
        cost_usd: 0,
        error_detail: null,
      },
    ],
    final: { status: "ok", alias: head, providerModel: head },
    body: { ok: true },
    stream: null,
  };
}

// Run the REAL Layer-1 classifier + the REAL router; return the observed triple.
async function decide(request: InternalRequest): Promise<{
  task_type: string;
  complexity: Classification["complexity"];
  selected_lane: string;
}> {
  const scored = scoreRequest(request, { cfg: rulesCfg, approxTokens: approxTokens(request) });
  const complexity = mapComplexity(scored.complexity);
  const cls: Classification = {
    task_type: scored.task_type,
    complexity,
    confidence: scored.confidence,
    decided_by: "rules",
    constraints: {
      needs_json: scored.constraints.needs_json,
      needs_tools: scored.constraints.needs_tools,
      needs_vision: scored.constraints.needs_vision,
    },
    explanation: [],
  };
  const result = await routeRequest(request, {
    classify: async () => cls,
    policies: config.policies,
    lanes,
    execute: async (plan) => okExecute(plan),
    now: () => new Date(0),
    log: () => {},
  });
  return {
    task_type: cls.task_type,
    complexity,
    selected_lane: result.decision.lane.selected_lane,
  };
}

interface GoldenCase {
  name: string;
  request: InternalRequest;
  task_type: string;
  complexity: Classification["complexity"];
  selected_lane: string;
}

// ── golden table: ~30 representative prompts ─────────────────────────────────
// Values were captured from the CURRENT code. If a change here is INTENTIONAL,
// update the expectation in the same commit and note it; an UNINTENTIONAL drift
// is exactly what this test exists to catch.
const CASES: GoldenCase[] = [
  // — greetings / chit-chat (simple chat) —
  {
    name: "greeting hi",
    request: req("hi"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "thanks",
    request: req("thanks"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "good morning",
    request: req("good morning"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "how are you",
    request: req("how are you"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "ok",
    request: req("ok"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — lookups / definitions —
  {
    name: "what is X",
    request: req("what is a monad"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "who is X",
    request: req("who is Ada Lovelace"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "define X",
    request: req("define entropy"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — coding (task lane is resolved by task_type for medium/complex tiers; the
  //   `simple` tier is now steered DOWN to economy by Phase-1
  //   coding_simple_to_economy — llm-router MBPP fix: trivial code ≠ premium) —
  {
    // Phase 1 (2026-05-31): MOVED coding→economy. This prompt scores coding+
    // simple; coding_simple_to_economy now pins economy instead of the coding
    // task lane.
    name: "coding keyword simple -> economy (Phase 1 MBPP fix)",
    request: req("write a function to reverse a string"),
    task_type: "coding",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "coding refactor + complexity",
    request: req("refactor this module and debug the failing function in the compile step"),
    task_type: "coding",
    complexity: "complex",
    selected_lane: "coding",
  },
  {
    name: "coding with code block",
    request: req(
      "```ts\nfunction add(a: number, b: number) { return a + b; }\n```\nfix this function",
    ),
    task_type: "coding",
    complexity: "complex",
    selected_lane: "coding",
  },
  {
    name: "coding npm/git",
    request: req("my npm install fails and git push is rejected, the class wont compile"),
    task_type: "coding",
    complexity: "medium",
    selected_lane: "coding",
  },

  // — math (no `math` lane exists; complexity lane, but Phase-1
  //   math_simple_to_balanced raises simple math OFF economy) —
  {
    // Phase 1 (2026-05-31): MOVED economy→balanced. math+simple is steered to
    // balanced by math_simple_to_balanced ("math is never economy"); previously
    // it rode the simple→economy complexity fallback.
    name: "math integral simple -> balanced (Phase 1: math never economy)",
    request: req("solve this integral and the matrix equation"),
    task_type: "math",
    complexity: "simple",
    selected_lane: "balanced",
  },
  {
    // Heavy reasoning keywords push complexity to `complex`, but the `*_kw`
    // dimensions outweigh the math task keywords so task_type lands on `chat`.
    name: "math probability prove",
    request: req("prove the probability bound, derive it step by step from the theorem"),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },

  // — writing (no `writing` lane; complexity lane) —
  {
    name: "writing essay",
    request: req("rewrite this essay draft and polish the tone"),
    task_type: "writing",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — extraction (no `extraction` lane; complexity lane) —
  {
    name: "extraction parse fields",
    request: req("extract and parse the fields from this text"),
    task_type: "extraction",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // needs_json fires the json policy first-match -> json lane regardless of tier.
    name: "extraction json response_format",
    request: req("extract the fields", { response_format: { type: "json_object" } }),
    task_type: "extraction",
    complexity: "simple",
    selected_lane: "json",
  },

  // — data (no `data` lane; complexity lane) —
  {
    name: "data csv aggregate",
    request: req("aggregate this csv into a dataframe and run a sql pivot"),
    task_type: "data",
    complexity: "medium",
    selected_lane: "balanced",
  },

  // — vision (vision task lane resolved by task_type) —
  {
    name: "vision image attachment",
    request: req("describe this screenshot", { attachments: [{ type: "image" }] }),
    task_type: "vision",
    complexity: "simple",
    selected_lane: "vision",
  },

  // — web (raised activation: needs prefix + url; no `web` lane -> complexity) —
  {
    name: "web tool prefix + url",
    request: req("look this up on https://example.com/page", {
      tools: [{ function: { name: "browser_search" } }],
    }),
    task_type: "web",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "lone url is NOT web",
    request: req("here is a link https://example.com/page"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — tools present, generic chat (no policy on needs_tools; complexity lane) —
  {
    name: "tools present generic chat",
    request: req("call the helper as needed", {
      tools: [{ function: { name: "do_thing" } }],
    }),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — reasoning / planning (complex) —
  {
    name: "planning architecture trade-off",
    request: req(
      "design the architecture for this system, weigh the trade-off and reason about the strategy step by step",
    ),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },
  {
    name: "analysis root cause",
    request: req(
      "analyze and compare these approaches, evaluate the implications and find the root cause",
    ),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },

  // — coding + complex => coding policy (first-match) —
  {
    name: "coding complex -> coding lane via policy",
    request: req(
      "refactor and debug this function: prove the algorithm is correct, derive the complexity step by step and reason about the theorem",
    ),
    task_type: "coding",
    complexity: "complex",
    selected_lane: "coding",
  },

  // — translation (negative weight, stays simple chat) —
  {
    name: "translate stays chat",
    request: req("translate this to french"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // — multi-step coding (coding task lane) —
  {
    name: "multistep first then finally",
    request: req("first set up the repo, then write the function, and then finally compile it"),
    task_type: "coding",
    complexity: "complex",
    selected_lane: "coding",
  },

  // — json-constrained generic: the JSON response_format is itself an extraction
  //   structural signal, so task_type lands `extraction`; the needs_json policy
  //   still pins the json lane first-match. —
  {
    name: "json constrained generic chat",
    request: req("respond with structured output", { response_format: { type: "json_object" } }),
    task_type: "extraction",
    complexity: "simple",
    selected_lane: "json",
  },

  // — empty-ish whitespace question (falls to chat/simple) —
  {
    name: "short question stays simple",
    request: req("ping"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },

  // ── VOCABULARY EXPANSION (2026-06-02) ──────────────────────────────────────
  // Real-world phrasings the original thin keyword lists missed entirely (they
  // fell through to chat/balanced). These encode the human-obvious routing and
  // are made to pass by the classifier.yaml vocabulary expansion in the same
  // commit. Each was RED against the pre-expansion config.
  {
    // "summarize" / "article" are new writing_kw + task_keywords.writing terms.
    name: "expand: summarize -> writing",
    request: req("summarize this article in two short sentences"),
    task_type: "writing",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // "paraphrase" is a new writing term.
    name: "expand: paraphrase -> writing",
    request: req("paraphrase this paragraph more clearly"),
    task_type: "writing",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // "derivative" / "polynomial" are new math terms; math+simple -> balanced
    // (math_simple_to_balanced). "derivative" deliberately does NOT substring-
    // match "derive" in the existing "math probability prove" golden case.
    name: "expand: derivative -> math/balanced",
    request: req("calculate the derivative of this polynomial"),
    task_type: "math",
    complexity: "simple",
    selected_lane: "balanced",
  },
  {
    // "implement" / "unit tests" are new coding terms. This short prompt is
    // pinned `simple` by the short-message override, so coding_simple_to_economy
    // steers it to economy (trivial-code-is-not-premium philosophy).
    name: "expand: implement -> coding/economy",
    request: req("implement binary search and add unit tests for it"),
    task_type: "coding",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // "group by" / "spreadsheet" are new data terms; data has no own lane so a
    // medium data task rides the complexity fallback to balanced.
    name: "expand: group by -> data/balanced",
    request: req("group by region and sum the revenue in this spreadsheet"),
    task_type: "data",
    complexity: "medium",
    selected_lane: "balanced",
  },
  {
    // "pull out" is a new extraction term; extraction+simple -> economy.
    name: "expand: pull out -> extraction",
    request: req("pull out all the email addresses from this text"),
    task_type: "extraction",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // "assess" / "pros and cons" / "trade-offs" are new analysis/planning
    // complexity terms (analysis is not a task_type, so task stays chat);
    // chat+complex -> premium.
    name: "expand: assess pros/cons -> premium",
    request: req("assess the pros and cons of these two approaches and weigh the trade-offs"),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },
  {
    // "command injection" is a new security term; paired with "sql injection" it
    // clears the raised security activation (>= 2.0). security+complex -> premium.
    name: "expand: injection audit -> security/premium",
    request: req("audit this endpoint for sql injection and command injection vulnerabilities"),
    task_type: "security",
    complexity: "complex",
    selected_lane: "premium",
  },
  {
    // "roadmap" / "break down" are new planning terms. With no reasoning
    // co-signal a pure-planning prompt lands medium (not complex like the
    // reasoning-laden "planning architecture" case) -> balanced. Task stays chat
    // (planning is not a task_type). Guards the "tone" substring fix: "milestones"
    // must NOT be mis-detected as the writing task.
    name: "expand: roadmap -> planning/balanced",
    request: req("outline a project roadmap with milestones and break down the deliverables"),
    task_type: "chat",
    complexity: "medium",
    selected_lane: "balanced",
  },

  // ── INTERNATIONAL (Simplified Chinese) PARITY (2026-06-16) ──────────────────
  // ZH rows mirror their English golden rows. The analysis/security rows are the
  // regression guard for the overrides.ts CJK short-circuit fix: a SHORT ZH
  // analysis/security prompt must NOT be force-pinned simple→economy because the
  // English signal lists miss it (and the old override matcher could not match CJK).
  {
    name: "zh greeting -> economy",
    request: req("你好"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "zh lookup what-is -> economy",
    request: req("什么是单子"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "zh translate -> economy",
    request: req("把这段话翻译成英文"),
    task_type: "chat",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    name: "zh trivial coding -> economy",
    request: req("写一个反转字符串的函数"),
    task_type: "coding",
    complexity: "simple",
    selected_lane: "economy",
  },
  {
    // BUG-FIX guard: this short ZH analysis prompt was mis-pinned simple→economy
    // before the overrides CJK short-circuit fix; now analysis_intl grip routes it up.
    name: "zh analysis (short) -> up, NOT economy",
    request: req("分析这个系统的根因和利弊"),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },
  {
    // BUG-FIX guard: short ZH security audit (>=2 security hits) routes up.
    name: "zh security (short) -> premium",
    request: req("检查这个接口的命令注入和越权漏洞"),
    task_type: "security",
    complexity: "complex",
    selected_lane: "premium",
  },
  {
    // POLITENESS-PREAMBLE guard: a 你好 preamble must NOT drag a genuine complex ZH
    // request down (你好 is deliberately excluded from the negative intl dims).
    name: "zh polite preamble + complex analysis -> premium",
    request: req("你好，请分析这个复杂分布式系统的架构权衡、性能瓶颈和根因"),
    task_type: "chat",
    complexity: "complex",
    selected_lane: "premium",
  },
];

describe("GOLDEN classify+route baseline (characterizes current behavior)", () => {
  for (const c of CASES) {
    it(`${c.name} -> task=${c.task_type} complexity=${c.complexity} lane=${c.selected_lane}`, async () => {
      const got = await decide(c.request);
      expect(got).toEqual({
        task_type: c.task_type,
        complexity: c.complexity,
        selected_lane: c.selected_lane,
      });
    });
  }
});
