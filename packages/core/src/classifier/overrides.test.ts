import type { ClassifierRulesConfig } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { applyOverrides, evaluateOverrides } from "./overrides.js";

// Parse through the real schema for honest defaults and override only the
// override-relevant block. The dimension/scoring surface is irrelevant here —
// overrides are a pure, separate signal path that bypasses weighted scoring.
function makeConfig(
  overridesBlock: Partial<ClassifierRulesConfig["overrides"]> = {},
): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {},
    task_keywords: {},
    tool_prefixes: {},
    tier_boundaries: {},
    overrides: {
      // Give formal-logic keywords a value by default so most tests can rely on
      // it; individual tests can override the whole block.
      formal_logic_keywords: ["modus ponens", "modus tollens", "⊢"],
      ...overridesBlock,
    },
    momentum: {},
  });
}

// Minimal request builder. `evaluateOverrides` only reads messages/tools/
// max_tokens, so we keep the shape to that Pick.
function req(opts: {
  content?: string;
  messages?: { role: string; content: unknown }[];
  requested_model?: string;
  response_format?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  tools?: unknown[] | null;
  max_tokens?: number | null;
}): {
  messages: { role: string; content: unknown }[];
  requested_model: string;
  response_format: Record<string, unknown> | null;
  attachments: unknown[] | null;
  tools: unknown[] | null;
  max_tokens: number | null;
} {
  return {
    messages: opts.messages ?? [{ role: "user", content: opts.content ?? "" }],
    requested_model: opts.requested_model ?? "auto",
    response_format: opts.response_format ?? null,
    attachments: opts.attachments ?? null,
    tools: opts.tools ?? null,
    max_tokens: opts.max_tokens ?? null,
  };
}

describe("evaluateOverrides — heartbeat (set → simple)", () => {
  it("flags a HEARTBEAT_OK message as a set-simple override (normal)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(req({ content: "HEARTBEAT_OK" }), cfg, 5);
    expect(hits).toContainEqual({ rule: "heartbeat", kind: "set", complexity: "simple" });
    // set beats whatever the weighted base tier was.
    expect(applyOverrides("reasoning", hits)).toBe("simple");
  });

  it("does NOT fire on a heartbeat token used as a substring of a real question (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({ content: "explain the HEARTBEAT_OK protocol and write a client for it" }),
      cfg,
      20,
    );
    expect(hits.find((h) => h.rule === "heartbeat")).toBeUndefined();
  });
});

describe("evaluateOverrides — formal logic (set → reasoning)", () => {
  it("flags a formal-logic keyword as set-reasoning regardless of base (normal)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({ content: "Given P and P→Q, derive Q by modus ponens." }),
      cfg,
      30,
    );
    expect(hits).toContainEqual({ rule: "formal_logic", kind: "set", complexity: "reasoning" });
    expect(applyOverrides("simple", hits)).toBe("reasoning");
  });
});

describe("evaluateOverrides — low-cost automation (set → simple)", () => {
  const lowCostAutomation = {
    intent_markers: ["[cron:", "MONITOR.md"],
    no_reply_markers: ["NO_REPLY", "nothing to action"],
  };

  it("pins a cron monitor no-reply probe to simple despite tools floor (prod regression)", () => {
    const cfg = makeConfig({ low_cost_automation: lowCostAutomation });
    const hits = evaluateOverrides(
      req({
        content:
          "[cron:2026-07-03T01:00:00Z] chief-monitor Read /Users/lukin/AgentData/chief/MONITOR.md and execute it strictly. Return NO_REPLY if nothing to action.",
        tools: [{ name: "code_read" }],
      }),
      cfg,
      58_000,
    );
    expect(hits).toContainEqual({
      rule: "low_cost_automation",
      kind: "set",
      complexity: "simple",
    });
    expect(hits).toContainEqual({ rule: "tools_floor", kind: "floor", complexity: "standard" });
    expect(applyOverrides("complex", hits)).toBe("simple");
  });

  it("does not fire on a normal NO_REPLY explanation without an automation marker", () => {
    const cfg = makeConfig({ low_cost_automation: lowCostAutomation });
    const hits = evaluateOverrides(
      req({ content: "Explain why this integration sometimes returns NO_REPLY." }),
      cfg,
      20,
    );
    expect(hits.find((h) => h.rule === "low_cost_automation")).toBeUndefined();
  });

  it("lets low-cost automation beat long-history floors; capability filter owns window fit", () => {
    const cfg = makeConfig({
      low_cost_automation: lowCostAutomation,
      long_context_token_threshold: 100,
    });
    const hits = evaluateOverrides(
      req({
        content:
          "[cron:2026-07-03T01:00:00Z] Read /tmp/MONITOR.md. Return NO_REPLY if nothing to action.",
      }),
      cfg,
      101,
    );
    expect(hits).toContainEqual({
      rule: "low_cost_automation",
      kind: "set",
      complexity: "simple",
    });
    expect(hits).toContainEqual({ rule: "long_context", kind: "floor", complexity: "complex" });
    expect(applyOverrides("complex", hits)).toBe("simple");
  });
});

describe("evaluateOverrides — cheap model low-risk current turn (set → simple)", () => {
  const cheapModelLowRisk = {
    requested_model_markers: [
      "economy",
      "gpt-5.6-luna",
      "gpt-5.6-luna-*",
      "gpt-5.4-mini",
      "gpt-5.4-mini-*",
      "spark",
      "*deepseek-v4-flash",
      "claude-haiku",
      "*claude-haiku-*",
      "claude-3-5-haiku",
      "*claude-3-5-haiku-*",
    ],
    current_turn_max_chars: 300,
    low_risk_markers: ["check", "inspect", "status", "read"],
    blocked_markers: ["debug", "fix", "implement", "refactor", "patch"],
  };

  it("pins a short low-risk cheap-model request to simple despite long history/tools", () => {
    const cfg = makeConfig({
      cheap_model_low_risk: cheapModelLowRisk,
      long_context_token_threshold: 1_000,
    });
    const hits = evaluateOverrides(
      req({
        requested_model: "gpt-5.4-mini",
        messages: [
          { role: "assistant", content: "prior implementation details ".repeat(10_000) },
          { role: "user", content: "Please check the current status and report anything notable." },
        ],
        tools: [{ name: "shell_exec" }],
      }),
      cfg,
      70_000,
    );
    expect(hits).toContainEqual({
      rule: "cheap_model_low_risk",
      kind: "set",
      complexity: "simple",
    });
    expect(hits).toContainEqual({ rule: "tools_floor", kind: "floor", complexity: "standard" });
    expect(hits).toContainEqual({ rule: "long_context", kind: "floor", complexity: "complex" });
    expect(applyOverrides("complex", hits)).toBe("simple");
  });

  it.each([
    "economy",
    "gpt-5.6-luna",
    "gpt-5.6-luna-20260710",
    "gpt-5.4-mini",
    "gpt-5.4-mini-20260101",
    "deepseek-v4-flash",
    "deepseek/deepseek-v4-flash",
    "openrouter/deepseek-v4-flash",
    "claude-haiku",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
    "anthropic/claude-haiku-4-5-20251001",
    "zenmux-anthropic/claude-haiku-4.5",
  ])("treats %s as a cheap-model hint", (requestedModel) => {
    const cfg = makeConfig({ cheap_model_low_risk: cheapModelLowRisk });
    const hits = evaluateOverrides(
      req({
        requested_model: requestedModel,
        content: "Please check the current status and report anything notable.",
      }),
      cfg,
      20,
    );
    expect(hits).toContainEqual({
      rule: "cheap_model_low_risk",
      kind: "set",
      complexity: "simple",
    });
  });

  it("does not fire for explicit heavy-model requests", () => {
    const cfg = makeConfig({ cheap_model_low_risk: cheapModelLowRisk });
    const hits = evaluateOverrides(
      req({
        requested_model: "gpt-5.5",
        content: "Please check the current status and report anything notable.",
      }),
      cfg,
      20,
    );
    expect(hits.find((h) => h.rule === "cheap_model_low_risk")).toBeUndefined();
  });

  it("does not fire for code-changing current turns", () => {
    const cfg = makeConfig({ cheap_model_low_risk: cheapModelLowRisk });
    const hits = evaluateOverrides(
      req({
        requested_model: "gpt-5.4-mini",
        content: "Please inspect this bug, fix the function, and patch the tests.",
      }),
      cfg,
      20,
    );
    expect(hits.find((h) => h.rule === "cheap_model_low_risk")).toBeUndefined();
  });

  it("does not fire when JSON or vision constraints are present", () => {
    const cfg = makeConfig({ cheap_model_low_risk: cheapModelLowRisk });
    expect(
      evaluateOverrides(
        req({
          requested_model: "gpt-5.4-mini",
          content: "Please check this and return structured fields.",
          response_format: { type: "json_schema" },
        }),
        cfg,
        20,
      ).find((h) => h.rule === "cheap_model_low_risk"),
    ).toBeUndefined();
    expect(
      evaluateOverrides(
        req({
          requested_model: "gpt-5.4-mini",
          content: "Please inspect this screenshot status.",
          attachments: [{ type: "image" }],
        }),
        cfg,
        20,
      ).find((h) => h.rule === "cheap_model_low_risk"),
    ).toBeUndefined();
  });
});

describe("evaluateOverrides — tools floor (floor → standard)", () => {
  it("raises a trivial tools request to the standard floor (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({
        content: "Please run the noop tool and report back whatever it returns.",
        tools: [{ name: "noop" }],
      }),
      cfg,
      10,
    );
    expect(hits).toContainEqual({ rule: "tools_floor", kind: "floor", complexity: "standard" });
    expect(applyOverrides("simple", hits)).toBe("standard");
    // floor only raises, never lowers.
    expect(applyOverrides("complex", hits)).toBe("complex");
  });

  it("does not add a tools floor when tools is null or empty (edge)", () => {
    const cfg = makeConfig();
    expect(
      evaluateOverrides(req({ content: "hi", tools: null }), cfg, 5).find(
        (h) => h.rule === "tools_floor",
      ),
    ).toBeUndefined();
    expect(
      evaluateOverrides(req({ content: "hi", tools: [] }), cfg, 5).find(
        (h) => h.rule === "tools_floor",
      ),
    ).toBeUndefined();
  });
});

describe("evaluateOverrides — long context (floor → complex)", () => {
  it("raises a long-context request to the complex floor (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({ content: "Summarize the key findings across all of the attached source documents." }),
      cfg,
      70_000, // above the default 64k long_context threshold
    );
    expect(hits).toContainEqual({ rule: "long_context", kind: "floor", complexity: "complex" });
    expect(applyOverrides("standard", hits)).toBe("complex");
    // does not pull a higher base down.
    expect(applyOverrides("reasoning", hits)).toBe("reasoning");
  });

  it("does not fire below the threshold (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(req({ content: "x" }), cfg, 49_999);
    expect(hits.find((h) => h.rule === "long_context")).toBeUndefined();
  });
});

describe("evaluateOverrides — short-message shortcut (set → simple)", () => {
  it("shortcuts a tiny message with no complex signal to simple (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(req({ content: "ok" }), cfg, 1);
    expect(hits).toContainEqual({ rule: "short_message", kind: "set", complexity: "simple" });
  });

  it("does NOT shortcut a tiny message that carries a code block (edge)", () => {
    const cfg = makeConfig();
    const fence = "```";
    const code = `${fence}\n${"x".repeat(60)}\n${fence}`;
    const hits = evaluateOverrides(req({ content: `ok ${code}` }), cfg, 30);
    expect(hits.find((h) => h.rule === "short_message")).toBeUndefined();
  });

  it("does NOT shortcut a message at/above the char threshold (edge)", () => {
    const cfg = makeConfig({ short_message_max_chars: 5 });
    // exactly 5 chars is not < 5
    const hits = evaluateOverrides(req({ content: "12345" }), cfg, 5);
    expect(hits.find((h) => h.rule === "short_message")).toBeUndefined();
  });
});

describe("evaluateOverrides — set beats floor", () => {
  it("heartbeat + tools: set-simple wins over the tools floor (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({ content: "HEARTBEAT_OK", tools: [{ name: "noop" }] }),
      cfg,
      5,
    );
    // both kinds are reported by evaluate…
    expect(hits.find((h) => h.rule === "heartbeat")).toBeDefined();
    expect(hits.find((h) => h.rule === "tools_floor")).toBeDefined();
    // …but apply resolves to the set value, ignoring the floor.
    expect(applyOverrides("reasoning", hits)).toBe("simple");
  });
});

describe("evaluateOverrides — thresholds are data", () => {
  it("retunes the long-context threshold from config (normal)", () => {
    const cfg = makeConfig({ long_context_token_threshold: 10_000 });
    const hits = evaluateOverrides(req({ content: "x" }), cfg, 12_000);
    expect(hits).toContainEqual({ rule: "long_context", kind: "floor", complexity: "complex" });
  });

  it("respects a configured floor tier other than the default (normal)", () => {
    const cfg = makeConfig({ tools_floor: "complex" });
    const hits = evaluateOverrides(req({ content: "hi", tools: [{ name: "x" }] }), cfg, 5);
    expect(hits).toContainEqual({ rule: "tools_floor", kind: "floor", complexity: "complex" });
  });
});

describe("evaluateOverrides / applyOverrides — no override", () => {
  it("returns [] for an ordinary medium message and applyOverrides is identity (failure)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({ content: "Please write a short paragraph about the history of tea trade." }),
      cfg,
      40,
    );
    expect(hits).toEqual([]);
    expect(applyOverrides("standard", hits)).toBe("standard");
    expect(applyOverrides("reasoning", [])).toBe("reasoning");
  });
});

describe("evaluateOverrides — CJK short-message short-circuit (intl parity)", () => {
  // A config carrying the shipped *_intl_kw signal dimensions so the short-message
  // disqualifier (containsClassifierSignal) can see Chinese analysis/security/
  // diagnostic grip. Regression guard: short Chinese complex prompts must NOT be
  // force-pinned `simple` just because the English signal lists miss them and the
  // old override matcher could not match CJK mid-text.
  function intlConfig(): ClassifierRulesConfig {
    return ClassifierRulesConfigSchema.parse({
      dimensions: {
        analysis_kw: { weight: 0.76, keywords: ["analyze", "root cause"] },
        analysis_intl_kw: { weight: 0.76, keywords: ["分析", "根因", "利弊", "评估"] },
        security_intl_kw: { weight: 1.4, keywords: ["缓冲区溢出", "命令注入", "越权"] },
        diagnostic_short_intl_kw: { weight: 3.6, keywords: ["没有输出", "没有报错"] },
      },
      task_keywords: {},
      tool_prefixes: {},
      tier_boundaries: {},
      overrides: {},
      momentum: {},
    });
  }

  it("does NOT short-circuit a short Chinese ANALYSIS prompt to simple (intl grip)", () => {
    const cfg = intlConfig();
    const hits = evaluateOverrides(req({ content: "分析这个系统的根因和利弊" }), cfg, 8);
    expect(hits.find((h) => h.rule === "short_message")).toBeUndefined();
  });

  it("does NOT short-circuit a short Chinese SECURITY prompt to simple", () => {
    const cfg = intlConfig();
    const hits = evaluateOverrides(req({ content: "这个接口有命令注入和越权漏洞吗" }), cfg, 9);
    expect(hits.find((h) => h.rule === "short_message")).toBeUndefined();
  });

  it("matches a Chinese signal keyword MID-TEXT (CJK boundary carve-out)", () => {
    // "分析" is flanked by other CJK chars — the old WORD-boundary override matcher
    // (no CJK exception) silently failed here, so the prompt was mis-pinned simple.
    const cfg = intlConfig();
    const hits = evaluateOverrides(req({ content: "请你帮我分析一下这段" }), cfg, 7);
    expect(hits.find((h) => h.rule === "short_message")).toBeUndefined();
  });

  it("still short-circuits a short Chinese greeting (no signal) to simple", () => {
    const cfg = intlConfig();
    const hits = evaluateOverrides(req({ content: "你好呀在吗" }), cfg, 5);
    expect(hits).toContainEqual({ rule: "short_message", kind: "set", complexity: "simple" });
  });
});

describe("applyOverrides — multiple floors take the highest", () => {
  it("combines tools + long-context floors to the higher tier (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({
        content: "Process this large batch of records and call the provided tool for each one.",
        tools: [{ name: "x" }],
      }),
      cfg,
      70_000, // above the default 64k long_context threshold
    );
    // tools→standard and long_context→complex both present; highest wins.
    expect(applyOverrides("simple", hits)).toBe("complex");
  });
});
