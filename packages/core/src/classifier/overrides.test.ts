import type { ClassifierRulesConfig } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { applyOverrides, evaluateOverrides } from "./overrides.js";

// Parse through the real schema for honest defaults and override only the
// override-relevant block. The dimension/scoring surface is irrelevant here —
// overrides are a pure, separate signal path that bypasses weighted scoring.
function makeConfig(
  overridesBlock: Partial<{
    heartbeat_tokens: string[];
    formal_logic_keywords: string[];
    tools_floor: "simple" | "standard" | "complex" | "reasoning";
    long_context_token_threshold: number;
    long_context_floor: "simple" | "standard" | "complex" | "reasoning";
    short_message_max_chars: number;
  }> = {},
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
  tools?: unknown[] | null;
  max_tokens?: number | null;
}): {
  messages: { role: string; content: unknown }[];
  tools: unknown[] | null;
  max_tokens: number | null;
} {
  return {
    messages: opts.messages ?? [{ role: "user", content: opts.content ?? "" }],
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
      60_000,
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

describe("applyOverrides — multiple floors take the highest", () => {
  it("combines tools + long-context floors to the higher tier (edge)", () => {
    const cfg = makeConfig();
    const hits = evaluateOverrides(
      req({
        content: "Process this large batch of records and call the provided tool for each one.",
        tools: [{ name: "x" }],
      }),
      cfg,
      60_000,
    );
    // tools→standard and long_context→complex both present; highest wins.
    expect(applyOverrides("simple", hits)).toBe("complex");
  });
});
