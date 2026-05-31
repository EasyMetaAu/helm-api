import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { detectTask } from "./taskdetect.js";

// Minimal classifier rules config mirroring config/classifier.yaml's task layer:
// task_keywords + tool_prefixes + task_activation (web raised to 3.0). Parsed
// through the real schema so defaults / shape stay honest. `dimensions` is
// required by the schema but irrelevant to task detection (orthogonal to tiers).
function makeConfig(
  overrides: Partial<{
    task_keywords: Record<string, string[]>;
    tool_prefixes: Record<string, string[]>;
    task_activation: Record<string, number>;
  }> = {},
): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {},
    task_keywords: overrides.task_keywords ?? {
      coding: ["refactor", "function", "bug", "compile"],
      math: ["integral", "matrix", "equation"],
      writing: ["essay", "rewrite", "draft"],
      extraction: ["extract", "parse", "fields"],
      web: ["search the web", "browse", "look up online"],
      data: ["csv", "dataframe", "aggregate", "sql"],
      vision: ["image", "screenshot", "this picture"],
    },
    tool_prefixes: overrides.tool_prefixes ?? {
      web: ["browser_", "web_"],
      coding: ["code_", "shell_", "fs_"],
      data: ["sql_", "sheet_"],
    },
    task_activation: overrides.task_activation ?? { web: 3.0 },
    tier_boundaries: {},
    overrides: {},
    momentum: {},
  });
}

type ReqInput = Pick<InternalRequest, "messages" | "tools" | "response_format" | "attachments">;

function makeReq(text: string, extra: Partial<ReqInput> = {}): ReqInput {
  return {
    messages: [{ role: "user", content: text }],
    tools: null,
    response_format: null,
    attachments: null,
    ...extra,
  };
}

describe("detectTask", () => {
  it("detects coding from a code block + keyword, with both reasons", () => {
    const cfg = makeConfig();
    const text = "```ts\nfunction add(a, b) { return a + b; }\n```\nrefactor this function";
    const res = detectTask(makeReq(text), cfg);
    expect(res.task_type).toBe("coding");
    const coding = res.scores.find((s) => s.task === "coding");
    expect(coding).toBeDefined();
    const reasons = coding?.reasons.join(" ") ?? "";
    expect(reasons).toMatch(/keyword/);
    expect(reasons).toMatch(/code_block/);
  });

  it("detects vision from image attachment + keyword", () => {
    const cfg = makeConfig();
    const res = detectTask(
      makeReq("describe this screenshot", { attachments: [{ type: "image" }] }),
      cfg,
    );
    expect(res.task_type).toBe("vision");
  });

  it("detects extraction from JSON response_format + keyword", () => {
    const cfg = makeConfig();
    const res = detectTask(
      makeReq("extract the fields", { response_format: { type: "json_object" } }),
      cfg,
    );
    expect(res.task_type).toBe("extraction");
  });

  it("uses tool-name prefix plus URL to clear the raised web threshold", () => {
    const cfg = makeConfig();
    const res = detectTask(
      makeReq("find me something on https://example.com/page", {
        tools: [{ function: { name: "browser_search" } }],
      }),
      cfg,
    );
    expect(res.task_type).toBe("web");
    const web = res.scores.find((s) => s.task === "web");
    expect(web?.score).toBeGreaterThanOrEqual(3.0);
  });

  it("does NOT classify a lone URL as web (3.0 activation threshold guard)", () => {
    const cfg = makeConfig();
    const res = detectTask(makeReq("here is a link https://example.com/page"), cfg);
    expect(res.task_type).not.toBe("web");
    const web = res.scores.find((s) => s.task === "web");
    // web may have a small score from the URL signal, but must stay under 3.0.
    expect(web ? web.score : 0).toBeLessThan(3.0);
  });

  it("falls back to chat for greetings with no signal (never throws)", () => {
    const cfg = makeConfig();
    const res = detectTask(makeReq("hi there"), cfg);
    expect(res.task_type).toBe("chat");
  });

  // ── security task_type (eval-v2 cybersecurity domain, Phase 2). The
  // security_kw weight is modest (~0.16) and task_activation.security is raised
  // to >= 2.0 so a single weak keyword cannot false-trigger it — "explain what
  // XSS is" must stay its natural type, only a clearly security-laden request
  // (multiple keywords) crosses the threshold. We exercise against the SHIPPED
  // security keyword set so the four-file lockstep stays honest.
  const SECURITY_KEYWORDS = [
    "cve-",
    "buffer overflow",
    "sql injection",
    "exploit",
    "privilege escalation",
    "xss",
    "reverse engineer",
    "cryptanalysis",
    "ctf",
  ];

  it("detects security from a clear exploit-writing prompt (multiple keywords)", () => {
    const cfg = makeConfig({
      task_keywords: { security: SECURITY_KEYWORDS },
      task_activation: { web: 3.0, security: 2.0 },
    });
    const res = detectTask(
      makeReq(
        "write an exploit for this buffer overflow to achieve privilege escalation against the CVE-2024-1234 target",
      ),
      cfg,
    );
    expect(res.task_type).toBe("security");
    const sec = res.scores.find((s) => s.task === "security");
    expect(sec?.score).toBeGreaterThanOrEqual(2.0);
  });

  it("does NOT activate security from a LONE single security keyword (false-positive guard)", () => {
    const cfg = makeConfig({
      task_keywords: {
        coding: ["refactor", "function", "bug", "compile"],
        security: SECURITY_KEYWORDS,
      },
      task_activation: { web: 3.0, security: 2.0 },
    });
    // A benign explainer that contains exactly one security keyword (xss) and no
    // other security evidence must NOT become security — it stays its natural
    // type (here `chat`, no other signal clears its threshold).
    const res = detectTask(makeReq("can you explain what xss is in simple terms?"), cfg);
    expect(res.task_type).not.toBe("security");
    const sec = res.scores.find((s) => s.task === "security");
    expect(sec ? sec.score : 0).toBeLessThan(2.0);
  });

  it("is data-driven: adding a data keyword reclassifies to data", () => {
    const text = "please tabulate the widgets";
    const baseline = detectTask(makeReq(text), makeConfig());
    expect(baseline.task_type).not.toBe("data");

    const cfg = makeConfig({
      task_keywords: {
        coding: ["refactor"],
        data: ["csv", "tabulate"],
      },
    });
    const res = detectTask(makeReq(text), cfg);
    expect(res.task_type).toBe("data");
  });

  it("fuses multiple evidence paths and lists all candidate scores", () => {
    const cfg = makeConfig();
    const text =
      "```sql\nSELECT * FROM users WHERE active = 1 AND id > 100;\n```\naggregate the sql";
    const res = detectTask(makeReq(text, { tools: [{ function: { name: "sql_query" } }] }), cfg);
    const coding = res.scores.find((s) => s.task === "coding");
    const data = res.scores.find((s) => s.task === "data");
    expect(coding?.score).toBeGreaterThan(0);
    expect(data?.score).toBeGreaterThan(0);
    // Both candidates appear in the full scores list for the explanation.
    expect(res.scores.length).toBeGreaterThanOrEqual(2);
  });

  it("tolerates malformed tool entries without throwing", () => {
    const cfg = makeConfig();
    const res = detectTask(
      makeReq("hello", {
        tools: [null, {}, { function: null }, { function: { name: 42 } }, "nope"],
      }),
      cfg,
    );
    expect(res.task_type).toBe("chat");
  });

  it("breaks an exact-score tie stably, not by config key order (no silent demote)", () => {
    // coding and security tie on score (1.0 each), both cleared their threshold.
    // Whichever loses must NOT depend on Map insertion (= config key) order: the
    // result must be identical regardless of which key is declared first.
    const keywordsCodingFirst = {
      coding: ["alpha"],
      security: ["beta"],
    };
    const keywordsSecurityFirst = {
      security: ["beta"],
      coding: ["alpha"],
    };
    const activation = { web: 3.0, coding: 1.0, security: 1.0 };
    const req = makeReq("alpha beta"); // exactly one hit each → score 1.0 each

    const a = detectTask(
      makeReq("alpha beta"),
      makeConfig({ task_keywords: keywordsCodingFirst, task_activation: activation }),
    );
    const b = detectTask(
      req,
      makeConfig({ task_keywords: keywordsSecurityFirst, task_activation: activation }),
    );
    // Stable: the winner does not flip when the config key order flips.
    expect(a.task_type).toBe(b.task_type);
    // The gated security task is not silently demoted by a tie.
    expect(a.task_type).toBe("security");
  });

  it("prefers the higher-margin candidate on an exact-score tie", () => {
    // Both score 2.0 and clear their thresholds, but `extraction` (activation 1.0)
    // cleared by a wider margin than `data` (activation 1.5) — margin wins the tie
    // independent of declaration order.
    const cfg = makeConfig({
      task_keywords: {
        extraction: ["aa", "bb"],
        data: ["cc", "dd"],
      },
      task_activation: { web: 3.0, extraction: 1.0, data: 1.5 },
    });
    const res = detectTask(makeReq("aa bb cc dd"), cfg);
    expect(res.task_type).toBe("extraction");
  });

  it("is pure & deterministic with no side effects", () => {
    const cfg = makeConfig();
    const req = makeReq("refactor this function, see https://example.com/page");
    const a = detectTask(req, cfg);
    const b = detectTask(req, cfg);
    expect(a).toEqual(b);

    const dateSpy = vi.spyOn(Date, "now");
    const randSpy = vi.spyOn(Math, "random");
    detectTask(req, cfg);
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
    randSpy.mockRestore();
  });
});
