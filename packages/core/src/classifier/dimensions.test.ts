import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { wrapMemoryReminder } from "../memory/inject-bridge.js";
import { scoreDimensions } from "./dimensions.js";

// A minimal but representative classifier rules config mirroring config/classifier
// .yaml: keyword dimensions (sign = direction) + structural dimensions whose
// signal is fed by code, not data.
function makeConfig(
  overrides: Record<string, { weight: number; keywords?: string[] }> = {},
): ClassifierRulesConfig {
  const dimensions = {
    reasoning_kw: { weight: 0.35, keywords: ["prove", "theorem", "step by step"] },
    coding_kw: { weight: 0.2, keywords: ["refactor", "stack trace"] },
    simple_kw: { weight: -0.25, keywords: ["hi", "thanks", "ok"] },
    has_code_block: { weight: 0.2, keywords: [] },
    has_url: { weight: 0.05, keywords: [] },
    has_stack: { weight: 0.15, keywords: [] },
    has_file_path: { weight: 0.1, keywords: [] },
    has_attachment: { weight: 0.1, keywords: [] },
    has_json_format: { weight: 0.08, keywords: [] },
    msg_length: { weight: 0.1, keywords: [] },
    ...overrides,
  };
  // Parse through the real schema so defaults / shape stay honest.
  return ClassifierRulesConfigSchema.parse({
    dimensions,
    task_keywords: {},
    tool_prefixes: {},
    tier_boundaries: {},
    overrides: {},
    momentum: {},
  });
}

type ReqInput = Pick<
  InternalRequest,
  "messages" | "tools" | "response_format" | "attachments" | "max_tokens"
>;

function makeReq(text: string, extra: Partial<ReqInput> = {}): ReqInput {
  return {
    messages: [{ role: "user", content: text }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    ...extra,
  };
}

describe("scoreDimensions", () => {
  it("scores a positive keyword dimension (reasoning) above zero", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("prove the theorem step by step"), cfg);
    const hit = res.hits.find((h) => h.dimension === "reasoning_kw");
    expect(hit).toBeDefined();
    expect(hit?.contribution).toBeGreaterThan(0);
    expect(res.rawScore).toBeGreaterThan(0);
  });

  it("scores a negative keyword dimension (simple) below zero", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("hi thanks"), cfg);
    const hit = res.hits.find((h) => h.dimension === "simple_kw");
    expect(hit).toBeDefined();
    expect(hit?.contribution).toBeLessThan(0);
    expect(res.rawScore).toBeLessThan(0);
  });

  it("detects a fenced code block (>=40 chars) but not short inline code", () => {
    const cfg = makeConfig();
    const long = "```ts\nconst answer = computeTheUltimateMeaningOfLife(42);\n```";
    const res = scoreDimensions(makeReq(long), cfg);
    expect(res.hits.find((h) => h.dimension === "has_code_block")?.signal).toBe(1);

    const inline = scoreDimensions(makeReq("use `x` here"), cfg);
    expect(inline.hits.find((h) => h.dimension === "has_code_block")).toBeUndefined();
  });

  it("isolates structural signals: stack / file-path / url do not cross-talk", () => {
    const cfg = makeConfig();

    const stack = scoreDimensions(
      makeReq("Traceback (most recent call last):\n  at foo (bar.js:10)"),
      cfg,
    );
    expect(stack.hits.find((h) => h.dimension === "has_stack")?.signal).toBe(1);
    expect(stack.hits.find((h) => h.dimension === "has_url")).toBeUndefined();

    const path = scoreDimensions(makeReq("look at src/app/main.ts please"), cfg);
    expect(path.hits.find((h) => h.dimension === "has_file_path")?.signal).toBe(1);
    expect(path.hits.find((h) => h.dimension === "has_url")).toBeUndefined();

    const url = scoreDimensions(makeReq("see https://x.com for info"), cfg);
    expect(url.hits.find((h) => h.dimension === "has_url")?.signal).toBe(1);
    expect(url.hits.find((h) => h.dimension === "has_file_path")).toBeUndefined();
  });

  it("is pure & deterministic with no side effects", () => {
    const cfg = makeConfig();
    const req = makeReq("prove the theorem step by step, see https://x.com");
    const a = scoreDimensions(req, cfg);
    const b = scoreDimensions(req, cfg);
    expect(a.rawScore).toBe(b.rawScore);
    expect(a).toEqual(b);

    const dateSpy = vi.spyOn(Date, "now");
    const randSpy = vi.spyOn(Math, "random");
    scoreDimensions(req, cfg);
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
    randSpy.mockRestore();
  });

  it("returns zero score and no hits for blank input", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("   \n  \t "), cfg);
    expect(res.rawScore).toBe(0);
    expect(res.hits).toEqual([]);
  });

  it("is config-driven: doubling a weight doubles the contribution", () => {
    const base = makeConfig();
    const doubled = makeConfig({
      reasoning_kw: { weight: 0.7, keywords: ["prove", "theorem", "step by step"] },
    });
    const req = makeReq("prove the theorem step by step");
    const baseHit = scoreDimensions(req, base).hits.find((h) => h.dimension === "reasoning_kw");
    const dblHit = scoreDimensions(req, doubled).hits.find((h) => h.dimension === "reasoning_kw");
    expect(baseHit).toBeDefined();
    expect(dblHit).toBeDefined();
    expect(dblHit?.contribution).toBeCloseTo((baseHit?.contribution ?? 0) * 2, 10);
  });

  it("feeds context signals from attachments and JSON response_format", () => {
    const cfg = makeConfig();
    const att = scoreDimensions(
      makeReq("describe this", { attachments: [{ type: "image" }] }),
      cfg,
    );
    expect(att.hits.find((h) => h.dimension === "has_attachment")?.signal).toBe(1);

    const json = scoreDimensions(
      makeReq("give me data", { response_format: { type: "json_object" } }),
      cfg,
    );
    expect(json.hits.find((h) => h.dimension === "has_json_format")?.signal).toBe(1);
  });

  it("skips dimensions absent from the config without throwing", () => {
    // cfg has no `has_url` dimension; a URL message must not error or invent a hit.
    const cfg = makeConfig();
    const partial = ClassifierRulesConfigSchema.parse({
      dimensions: { reasoning_kw: cfg.dimensions.reasoning_kw },
      task_keywords: {},
      tool_prefixes: {},
      tier_boundaries: {},
      overrides: {},
      momentum: {},
    });
    const res = scoreDimensions(makeReq("see https://x.com and prove the theorem"), partial);
    expect(res.hits.find((h) => h.dimension === "has_url")).toBeUndefined();
    expect(res.hits.find((h) => h.dimension === "reasoning_kw")).toBeDefined();
  });
});

// CURRENT-TURN SCOPING: the TEXT-derived dimensions (keyword dims + content-type
// structural signals + msg_length) must read ONLY the last user message, not the
// concatenated history. A constant system/developer prompt describes an agent's
// standing capabilities, not THIS request's complexity — scoring it pushed a
// trivial chat over the `complex` boundary (prod 5ee4bf79: a 7599-char Mimi prompt
// inflated complexity → premium lane). The AMBIENT request-shape dimensions
// (turn_count / tool_count / has_tools / has_attachment / has_json_format) stay
// full-request — they measure shape, not intent, and are immune to prompt text.
// Mirrors taskdetect.ts + the engine §5.5 language guard.
describe("scoreDimensions scopes text-derived dimensions to the current user turn", () => {
  const bigSystemPrompt = [
    "You are Mimi. You can run shell commands and edit files; check git state.",
    "Team: architecture / Builder (实现 + 自测). Heavy TDD: refactor, fix the stack trace.",
    "```ts\nfunction add(a: number, b: number) { return a + b; }\n```",
    "See src/app/main.ts for the entrypoint.",
  ].join("\n");

  it("ignores coding keywords + code block in an earlier developer message", () => {
    const cfg = makeConfig();
    const req: ReqInput = {
      messages: [
        { role: "developer", content: bigSystemPrompt },
        { role: "assistant", content: "我是 Mimi，已上线 🐱" },
        { role: "user", content: "我喜欢的数字是多少？" },
      ],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
    };
    const res = scoreDimensions(req, cfg);
    expect(res.hits.find((h) => h.dimension === "coding_kw")).toBeUndefined();
    expect(res.hits.find((h) => h.dimension === "has_code_block")).toBeUndefined();
    expect(res.hits.find((h) => h.dimension === "has_file_path")).toBeUndefined();
    // Nothing in the last user turn crosses the shipped `complex` boundary (0.30).
    expect(res.rawScore).toBeLessThan(0.3);
  });

  it("msg_length reflects the last user message, not the whole concatenated history", () => {
    const cfg = makeConfig();
    const longPrior = "x".repeat(4000);
    const req: ReqInput = {
      messages: [
        { role: "developer", content: longPrior },
        { role: "user", content: "ok" },
      ],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
    };
    const res = scoreDimensions(req, cfg);
    const msgLen = res.hits.find((h) => h.dimension === "msg_length");
    // Last user "ok" is tiny → signal ~0, NOT the saturated signal of a 4000-char prior.
    expect(msgLen?.signal ?? 0).toBeLessThan(0.1);
  });

  it("still scores a code block in the LAST user message (preservation guard)", () => {
    const cfg = makeConfig();
    const req: ReqInput = {
      messages: [
        { role: "system", content: "you are a helpful assistant" },
        { role: "user", content: "```ts\nconst x = computeTheUltimateMeaningOfLife(42);\n```" },
      ],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
    };
    const res = scoreDimensions(req, cfg);
    expect(res.hits.find((h) => h.dimension === "has_code_block")?.signal).toBe(1);
  });

  it("scores the real user turn, not a trailing memory <system-reminder> turn", () => {
    // Memory-inject mode appends the block as a trailing role:"user" reminder.
    // Complexity must still be scored on the genuine coding request before it.
    const cfg = makeConfig();
    const req: ReqInput = {
      messages: [
        { role: "user", content: "refactor this function and fix the stack trace" },
        { role: "user", content: wrapMemoryReminder("Known facts:\n- likes 42") },
      ],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
    };
    const res = scoreDimensions(req, cfg);
    expect(res.hits.find((h) => h.dimension === "coding_kw")).toBeDefined();
  });

  it("keeps AMBIENT shape dimensions (turn_count / tool_count) on the FULL request", () => {
    const cfg = makeConfig({
      turn_count: { weight: 0.08 },
      tool_count: { weight: 0.1 },
    });
    const req: ReqInput = {
      messages: [
        { role: "developer", content: bigSystemPrompt },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "ok" },
      ],
      tools: [{ function: { name: "read" } }, { function: { name: "bash" } }],
      response_format: null,
      attachments: null,
      max_tokens: null,
    };
    const res = scoreDimensions(req, cfg);
    // 4 messages → normalize(4, 12) = 0.333, NOT normalize(1, 12) ≈ 0.083.
    expect(res.hits.find((h) => h.dimension === "turn_count")?.signal).toBeCloseTo(4 / 12, 10);
    // 2 tools → normalize(2, 8) = 0.25 (tools are request-wide, never scoped).
    expect(res.hits.find((h) => h.dimension === "tool_count")?.signal).toBeCloseTo(2 / 8, 10);
  });
});

// Keyword matching must be WORD/TOKEN-boundary aware, not a naive substring
// `includes`. A naive matcher fires `simple_kw` ("hi"/"ok") inside ordinary
// words — "this" contains "hi", "look"/"book" contain "ok" — which silently
// poisons the rawScore of unrelated prompts (regression discovered during the
// 2026-06-01 classifier recalibration). These pin the intended semantics.
describe("scoreDimensions keyword matching is word-boundary aware", () => {
  it("does NOT match 'hi' inside 'this' (no spurious simple_kw hit)", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("fix this function in the codebase"), cfg);
    expect(res.hits.find((h) => h.dimension === "simple_kw")).toBeUndefined();
  });

  it("does NOT match 'ok' inside 'look'/'book'", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("look at the book on the shelf"), cfg);
    expect(res.hits.find((h) => h.dimension === "simple_kw")).toBeUndefined();
  });

  it("STILL matches a standalone keyword token ('hi' as a word)", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("hi there"), cfg);
    expect(res.hits.find((h) => h.dimension === "simple_kw")).toBeDefined();
  });

  it("STILL matches multi-word keywords ('step by step')", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("solve it step by step please"), cfg);
    expect(res.hits.find((h) => h.dimension === "reasoning_kw")).toBeDefined();
  });

  it("STILL matches a keyword ending in punctuation ('cve-' in 'CVE-2021-1234')", () => {
    const cfg = makeConfig({ security_kw: { weight: 0.16, keywords: ["cve-", "exploit"] } });
    const res = scoreDimensions(makeReq("patch the CVE-2021-1234 issue"), cfg);
    expect(res.hits.find((h) => h.dimension === "security_kw")).toBeDefined();
  });

  it("matches a keyword at the very start/end of the text", () => {
    const cfg = makeConfig();
    expect(
      scoreDimensions(makeReq("ok"), cfg).hits.find((h) => h.dimension === "simple_kw"),
    ).toBeDefined();
    expect(
      scoreDimensions(makeReq("please say hi"), cfg).hits.find((h) => h.dimension === "simple_kw"),
    ).toBeDefined();
  });
});

// CJK (Han / Hiragana / Katakana / Hangul) has NO spaces between words, so the
// word-boundary lookarounds that protect Latin keywords ("ok" inside "look") would
// otherwise make EVERY CJK keyword embedded in CJK text unmatchable: a keyword like
// "分析" inside "请分析这个" is flanked by other \p{L} chars, so both boundary
// lookarounds fail. CJK edges must therefore match as plain substrings. These pin
// that contract so config-level localization (e.g. a Chinese keyword list) is even
// possible — see implementation-notes (classifier.multilingual-guard).
describe("scoreDimensions keyword matching handles CJK (no spurious boundary)", () => {
  it("MATCHES a CJK keyword embedded mid-sentence in CJK text", () => {
    const cfg = makeConfig({ analysis_kw: { weight: 0.4, keywords: ["分析", "评估"] } });
    const res = scoreDimensions(makeReq("请分析这家公司的财务状况"), cfg);
    expect(res.hits.find((h) => h.dimension === "analysis_kw")).toBeDefined();
  });

  it("MATCHES a CJK keyword at the start and end of CJK text", () => {
    const cfg = makeConfig({ analysis_kw: { weight: 0.4, keywords: ["分析"] } });
    expect(
      scoreDimensions(makeReq("分析这个"), cfg).hits.find((h) => h.dimension === "analysis_kw"),
    ).toBeDefined();
    expect(
      scoreDimensions(makeReq("请你分析"), cfg).hits.find((h) => h.dimension === "analysis_kw"),
    ).toBeDefined();
  });

  it("MATCHES a Japanese (Hiragana/Kanji) keyword embedded in Japanese text", () => {
    const cfg = makeConfig({ coding_kw: { weight: 0.3, keywords: ["実装"] } });
    const res = scoreDimensions(makeReq("この関数を実装してください"), cfg);
    expect(res.hits.find((h) => h.dimension === "coding_kw")).toBeDefined();
  });

  it("STILL enforces Latin word boundaries (CJK fix must not regress 'ok' in 'look')", () => {
    const cfg = makeConfig();
    const res = scoreDimensions(makeReq("look at the book on the shelf"), cfg);
    expect(res.hits.find((h) => h.dimension === "simple_kw")).toBeUndefined();
  });
});
