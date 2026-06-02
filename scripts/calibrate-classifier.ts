/**
 * Offline classifier calibration harness (NOT a test — a tuning instrument).
 *
 * Reproduces the EXACT production Layer-1 path with eval OFF:
 *   scoreRequest → confidence gate (conf >= rules.confidence_threshold) → routeRequest
 * and prints, per labeled prompt: rawScore, raw tier, confidence, the decided_by
 * the cascade would emit (rules vs fallback), and the resolved lane vs expected.
 *
 * The prompt set + expected lanes are copied from golden-routing.test.ts — the
 * designers' declared intent. The bug we are fixing: with the shipped config the
 * confidence gate NEVER clears, so decided_by is always `fallback` and every lane
 * collapses to `balanced`. Goal: tune config/classifier.yaml (DATA only) so these
 * prompts reach decided_by=rules and resolve to their intended lanes.
 *
 *   node --import tsx scripts/calibrate-classifier.ts            # uses ./config
 *   CONFIG_DIR=/tmp/cand node --import tsx scripts/calibrate-classifier.ts
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InternalRequest } from "@helm/shared";
import { loadConfig } from "../packages/core/src/config/loader.js";
import { scoreDimensions } from "../packages/core/src/classifier/dimensions.js";
import { scoreRequest } from "../packages/core/src/classifier/engine.js";
import type { Complexity } from "../packages/core/src/classifier/tiers.js";
import {
  type Classification,
  type ExecuteOutcome,
  type ExecutionPlan,
  routeRequest,
} from "../packages/core/src/routing/route-request.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configDir = process.env.CONFIG_DIR ?? join(repoRoot, "config");
const config = loadConfig({ configDir, env: {} });
const rulesCfg = config.classifier.rules;
if (config.lanes === undefined) throw new Error("config/lanes.yaml must load");
const lanes = config.lanes;

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
    request_id: "cal",
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
  } as InternalRequest;
}

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
      },
    ],
    final: { status: "ok", alias: head, providerModel: head },
    body: { ok: true },
    stream: null,
  } as ExecuteOutcome;
}

interface Case {
  name: string;
  request: InternalRequest;
  lane: string;
}
const CASES: Case[] = [
  { name: "exact yes", request: req("yes"), lane: "economy" },
  { name: "exact no", request: req("no"), lane: "economy" },
  { name: "exact sure", request: req("sure"), lane: "economy" },
  { name: "exact got it", request: req("got it"), lane: "economy" },
  { name: "greeting hi", request: req("hi"), lane: "economy" },
  { name: "thanks", request: req("thanks"), lane: "economy" },
  { name: "good morning", request: req("good morning"), lane: "economy" },
  { name: "how are you", request: req("how are you"), lane: "economy" },
  { name: "ok", request: req("ok"), lane: "economy" },
  { name: "what is a monad", request: req("what is a monad"), lane: "economy" },
  { name: "who is Ada", request: req("who is Ada Lovelace"), lane: "economy" },
  { name: "define entropy", request: req("define entropy"), lane: "economy" },
  { name: "coding simple->economy", request: req("write a function to reverse a string"), lane: "economy" },
  { name: "coding refactor+complex", request: req("refactor this module and debug the failing function in the compile step"), lane: "coding" },
  { name: "coding code block", request: req("```ts\nfunction add(a: number, b: number) { return a + b; }\n```\nfix this function"), lane: "coding" },
  { name: "coding npm/git", request: req("my npm install fails and git push is rejected, the class wont compile"), lane: "coding" },
  { name: "math integral simple", request: req("solve this integral and the matrix equation"), lane: "balanced" },
  { name: "math probability prove", request: req("prove the probability bound, derive it step by step from the theorem"), lane: "premium" },
  { name: "writing essay", request: req("rewrite this essay draft and polish the tone"), lane: "economy" },
  { name: "extraction parse fields", request: req("extract and parse the fields from this text"), lane: "economy" },
  { name: "extraction json", request: req("extract the fields", { response_format: { type: "json_object" } }), lane: "json" },
  { name: "data csv aggregate", request: req("aggregate this csv into a dataframe and run a sql pivot"), lane: "balanced" },
  { name: "vision image", request: req("describe this screenshot", { attachments: [{ type: "image" }] }), lane: "vision" },
  { name: "web prefix+url", request: req("look this up on https://example.com/page", { tools: [{ function: { name: "browser_search" } }] }), lane: "economy" },
  { name: "lone url not web", request: req("here is a link https://example.com/page"), lane: "economy" },
  { name: "tools generic chat", request: req("call the helper as needed", { tools: [{ function: { name: "do_thing" } }] }), lane: "economy" },
  { name: "planning architecture", request: req("design the architecture for this system, weigh the trade-off and reason about the strategy step by step"), lane: "premium" },
  { name: "analysis root cause", request: req("analyze and compare these approaches, evaluate the implications and find the root cause"), lane: "premium" },
  { name: "coding complex->coding", request: req("refactor and debug this function: prove the algorithm is correct, derive the complexity step by step and reason about the theorem"), lane: "coding" },
  { name: "translate stays chat", request: req("translate this to french"), lane: "economy" },
  { name: "multistep coding", request: req("first set up the repo, then write the function, and then finally compile it"), lane: "coding" },
  { name: "json generic", request: req("respond with structured output", { response_format: { type: "json_object" } }), lane: "json" },
  { name: "ping", request: req("ping"), lane: "economy" },
  // ── vocabulary expansion (2026-06-02) — mirrors golden-routing.test.ts ──
  { name: "expand summarize->writing", request: req("summarize this article in two short sentences"), lane: "economy" },
  { name: "expand paraphrase->writing", request: req("paraphrase this paragraph more clearly"), lane: "economy" },
  { name: "expand derivative->math", request: req("calculate the derivative of this polynomial"), lane: "balanced" },
  { name: "expand implement->coding", request: req("implement binary search and add unit tests for it"), lane: "economy" },
  { name: "expand groupby->data", request: req("group by region and sum the revenue in this spreadsheet"), lane: "balanced" },
  { name: "expand pullout->extraction", request: req("pull out all the email addresses from this text"), lane: "economy" },
  { name: "expand assess->premium", request: req("assess the pros and cons of these two approaches and weigh the trade-offs"), lane: "premium" },
  { name: "expand injection->security", request: req("audit this endpoint for sql injection and command injection vulnerabilities"), lane: "premium" },
  { name: "expand injection no coding crutch->security", request: req("audit this service for sql injection and command injection vulnerabilities"), lane: "premium" },
  { name: "no output analysis not simple", request: req("analyze why there is no output and diagnose the failure root cause"), lane: "premium" },
  { name: "no stack trace debug not simple", request: req("debug why there is no stack trace in this failing compile step and refactor the failing function"), lane: "coding" },
  { name: "no auth check audit not simple", request: req("audit why there is no auth check in this access control system and privilege escalation risk"), lane: "premium" },
  { name: "short no output", request: req("no output"), lane: "premium" },
  { name: "short no stack trace", request: req("no stack trace"), lane: "coding" },
  { name: "short no auth check", request: req("no auth check"), lane: "premium" },
  { name: "short no command injection", request: req("no command injection"), lane: "premium" },
  { name: "expand roadmap->balanced", request: req("outline a project roadmap with milestones and break down the deliverables"), lane: "balanced" },
];

const threshold = rulesCfg.confidence_threshold;

async function decide(request: InternalRequest) {
  const scored = scoreRequest(request, { cfg: rulesCfg, approxTokens: approxTokens(request) });
  const dim = scoreDimensions(request, rulesCfg);
  const confident = scored.confidence >= threshold;
  const decided_by: Classification["decided_by"] = confident ? "rules" : "fallback";
  const cls: Classification = {
    task_type: scored.task_type,
    complexity: mapComplexity(scored.complexity),
    confidence: scored.confidence,
    decided_by,
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
    rawScore: dim.rawScore,
    tier: scored.complexity,
    conf: scored.confidence,
    decided_by,
    task: scored.task_type,
    lane: result.decision.lane.selected_lane,
    hits: dim.hits
      .map((h) => `${h.dimension}=${h.contribution >= 0 ? "+" : ""}${h.contribution.toFixed(3)}`)
      .join(" "),
  };
}

async function main() {
  let pass = 0;
  let fallbacks = 0;
  console.log(`\nthreshold=${threshold}  sigmoid_k=${rulesCfg.sigmoid_k}  boundaries=${JSON.stringify(rulesCfg.tier_boundaries)}\n`);
  console.log(
    `${"case".padEnd(26)} ${"raw".padStart(7)} ${"tier".padEnd(9)} ${"conf".padStart(6)} ${"by".padEnd(8)} ${"lane".padEnd(9)} ${"want".padEnd(9)}  ok`,
  );
  for (const c of CASES) {
    const d = await decide(c.request);
    const ok = d.lane === c.lane;
    if (ok) pass += 1;
    if (d.decided_by === "fallback") fallbacks += 1;
    console.log(
      `${c.name.padEnd(26)} ${d.rawScore.toFixed(3).padStart(7)} ${d.tier.padEnd(9)} ${d.conf.toFixed(3).padStart(6)} ${d.decided_by.padEnd(8)} ${d.lane.padEnd(9)} ${c.lane.padEnd(9)}  ${ok ? "✓" : "✗"}`,
    );
    if (!ok || process.env.EXPLAIN) console.log(`      ↳ task=${d.task}  hits: ${d.hits}`);
  }
  console.log(
    `\n=== ${pass}/${CASES.length} lanes correct;  ${fallbacks}/${CASES.length} fell back to balanced (decided_by=fallback) ===`,
  );
}
main();
