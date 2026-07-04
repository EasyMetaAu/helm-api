import { describe, expect, it } from "vitest";
import {
  ClassifierConfigSchema,
  ClassifierEvalConfigSchema,
  ClassifierRulesConfigSchema,
} from "./classifier-schema.js";

// A full, explicit classifier config mirroring config/classifier.yaml defaults.
function fullClassifier() {
  return {
    rules: {
      enabled: true,
      confidence_threshold: 0.45,
      sigmoid_k: 8,
      tier_boundaries: { standard: -0.1, complex: 0.08, reasoning: 0.35 },
      dimensions: {
        reasoning_kw: { weight: 0.35, keywords: ["prove", "derive"] },
        has_code_block: { weight: 0.2 },
      },
      task_keywords: { coding: ["function", "class"] },
      tool_prefixes: { coding: ["code_"] },
      task_activation: { web: 3.0 },
      overrides: {
        heartbeat_tokens: ["HEARTBEAT_OK"],
        low_cost_automation: {
          intent_markers: ["[cron:", "MONITOR.md"],
          no_reply_markers: ["NO_REPLY"],
        },
        cheap_model_low_risk: {
          requested_model_markers: [
            "economy",
            "gpt-5.4-mini",
            "spark",
            "deepseek-v4-flash",
            "claude-haiku",
          ],
          current_turn_max_chars: 300,
          low_risk_markers: ["check", "status"],
          blocked_markers: ["fix", "implement"],
        },
        formal_logic_keywords: ["⊢"],
        tools_floor: "standard",
        long_context_token_threshold: 64000,
        long_context_floor: "complex",
        short_message_max_chars: 50,
      },
      momentum: {
        enabled: true,
        ttl_sec: 1800,
        history_size: 5,
        short_message_max_chars: 30,
        disable_above_chars: 100,
        max_history_weight: 0.6,
      },
    },
    eval: {
      enabled: false,
      model: "deepseek/deepseek-v4-flash",
      temperature: 0,
      max_tokens: 256,
      timeout_ms: 250,
      outer_timeout_ms: 350,
      on_failure: "balanced",
      cache: { enabled: true, key: "content_hash", ttl_sec: 300, max_entries: 5000 },
    },
  };
}

describe("ClassifierConfigSchema", () => {
  it("accepts a full valid classifier config", () => {
    expect(ClassifierConfigSchema.safeParse(fullClassifier()).success).toBe(true);
  });

  it("eval defaults to disabled with the documented eval defaults", () => {
    // model is required by the hardened eval schema (an enabled eval with no
    // model is a lie); supply only model and assert the rest defaults.
    const parsed = ClassifierEvalConfigSchema.parse({ model: "deepseek/deepseek-v4-flash" });
    expect(parsed.enabled).toBe(false);
    expect(parsed.max_tokens).toBe(256);
    expect(parsed.timeout_ms).toBe(250);
    expect(parsed.outer_timeout_ms).toBe(350);
    expect(parsed.on_failure).toBe("balanced");
    expect(parsed.temperature).toBe(0);
    expect(parsed.cache.enabled).toBe(true);
    expect(parsed.cache.key).toBe("content_hash");
    expect(parsed.cache.ttl_sec).toBe(300);
    expect(parsed.cache.max_entries).toBe(5000);
  });

  it("backfills momentum + overrides defaults from a minimal rules block", () => {
    const parsed = ClassifierRulesConfigSchema.parse({
      tier_boundaries: {},
      dimensions: {},
      task_keywords: {},
      tool_prefixes: {},
      overrides: {},
      momentum: {},
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.confidence_threshold).toBe(0.45);
    expect(parsed.sigmoid_k).toBe(8);
    expect(parsed.tier_boundaries.standard).toBe(-0.1);
    expect(parsed.tier_boundaries.complex).toBe(0.08);
    expect(parsed.tier_boundaries.reasoning).toBe(0.35);
    expect(parsed.momentum.ttl_sec).toBe(1800);
    expect(parsed.momentum.history_size).toBe(5);
    expect(parsed.momentum.max_history_weight).toBe(0.6);
    expect(parsed.overrides.long_context_token_threshold).toBe(64000);
    expect(parsed.overrides.heartbeat_tokens).toEqual(["HEARTBEAT_OK"]);
    expect(parsed.overrides.low_cost_automation).toEqual({
      intent_markers: [],
      no_reply_markers: [],
    });
    expect(parsed.overrides.cheap_model_low_risk).toEqual({
      requested_model_markers: [],
      current_turn_max_chars: 300,
      low_risk_markers: [],
      blocked_markers: [],
    });
    expect(parsed.overrides.tools_floor).toBe("standard");
  });

  it("defaults keyword dimensions to an empty keyword list (structural dims)", () => {
    const parsed = ClassifierRulesConfigSchema.parse({
      tier_boundaries: {},
      dimensions: { has_url: { weight: 0.05 } },
      task_keywords: {},
      tool_prefixes: {},
      overrides: {},
      momentum: {},
    });
    expect(parsed.dimensions.has_url?.keywords).toEqual([]);
  });

  it("rejects a confidence_threshold above 1 (fail-closed)", () => {
    const bad = fullClassifier();
    bad.rules.confidence_threshold = 1.5;
    const res = ClassifierConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "rules.confidence_threshold")).toBe(
        true,
      );
    }
  });

  it("rejects a non-numeric tier boundary (fail-closed)", () => {
    const bad = fullClassifier();
    (bad.rules.tier_boundaries as Record<string, unknown>).complex = "x";
    const res = ClassifierConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join(".") === "rules.tier_boundaries.complex"),
      ).toBe(true);
    }
  });

  it("rejects an invalid tools_floor enum value", () => {
    const bad = fullClassifier();
    (bad.rules.overrides as Record<string, unknown>).tools_floor = "nope";
    expect(ClassifierConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts open task_activation records (new task names allowed)", () => {
    const cfg = fullClassifier();
    (cfg.rules as { task_activation: Record<string, number> }).task_activation = {
      web: 3.0,
      vision: 2.5,
    };
    const res = ClassifierConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rules.task_activation.web).toBe(3.0);
      expect(res.data.rules.task_activation.vision).toBe(2.5);
    }
  });

  it("defaults task_activation to an empty record when omitted", () => {
    const parsed = ClassifierRulesConfigSchema.parse({
      tier_boundaries: {},
      dimensions: {},
      task_keywords: {},
      tool_prefixes: {},
      overrides: {},
      momentum: {},
    });
    expect(parsed.task_activation).toEqual({});
  });
});
