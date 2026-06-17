import { describe, expect, it } from "vitest";
import {
  applyForcedAnthropicThinking,
  applyForcedReasoningToNativeBody,
  reasoningEffortToAnthropicThinking,
} from "./reasoning-effort.js";

describe("reasoningEffortToAnthropicThinking", () => {
  it("maps tiers to monotonic budgets ≥ Anthropic's 1024 floor", () => {
    expect(reasoningEffortToAnthropicThinking("minimal")).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
    expect(reasoningEffortToAnthropicThinking("high")?.budget_tokens).toBeGreaterThanOrEqual(1024);
    const low = reasoningEffortToAnthropicThinking("low")?.budget_tokens ?? 0;
    const high = reasoningEffortToAnthropicThinking("high")?.budget_tokens ?? 0;
    expect(high).toBeGreaterThan(low);
  });

  it("returns undefined for `none` (thinking disabled)", () => {
    expect(reasoningEffortToAnthropicThinking("none")).toBeUndefined();
  });
});

describe("applyForcedAnthropicThinking — constraint fix-ups", () => {
  it("enables thinking, bumps max_tokens above the budget, forces temperature=1, drops top_p/top_k", () => {
    const out = applyForcedAnthropicThinking(
      { max_tokens: 100, temperature: 0.2, top_p: 0.9, top_k: 40 },
      "high",
    );
    const thinking = out.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe("enabled");
    expect(out.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
    expect(out.temperature).toBe(1);
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBeUndefined();
  });

  it("does not shrink an already-large max_tokens", () => {
    const out = applyForcedAnthropicThinking({ max_tokens: 100000 }, "minimal");
    expect(out.max_tokens).toBe(100000);
  });

  it("force `none` removes a client thinking block and leaves sampling untouched", () => {
    const out = applyForcedAnthropicThinking(
      { thinking: { type: "enabled", budget_tokens: 5000 }, temperature: 0.5 },
      "none",
    );
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBe(0.5);
  });
});

describe("applyForcedReasoningToNativeBody — per protocol", () => {
  it("gemini: replaces generationConfig.thinkingConfig, preserves other generationConfig keys", () => {
    const { body, mutated } = applyForcedReasoningToNativeBody(
      {
        contents: [],
        generationConfig: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      },
      "gemini",
      "high",
    );
    expect(mutated).toBe(true);
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe("application/json");
    const tc = gc.thinkingConfig as { thinkingBudget: number; thinkingLevel?: string };
    expect(tc.thinkingBudget).toBeGreaterThan(0);
    expect(tc.thinkingLevel).toBeUndefined(); // client's level replaced wholesale
  });

  it("gemini: `none` forces thinkingBudget 0 (thinking off)", () => {
    const { body } = applyForcedReasoningToNativeBody({ contents: [] }, "gemini", "none");
    const tc = (body.generationConfig as Record<string, unknown>).thinkingConfig as {
      thinkingBudget: number;
    };
    expect(tc.thinkingBudget).toBe(0);
  });

  it("openai_responses: sets reasoning.effort, and `none` removes reasoning", () => {
    const set = applyForcedReasoningToNativeBody({ input: [] }, "openai_responses", "high");
    expect(set.body.reasoning).toEqual({ effort: "high" });
    const none = applyForcedReasoningToNativeBody(
      { input: [], reasoning: { effort: "low" } },
      "openai_responses",
      "none",
    );
    expect(none.body.reasoning).toBeUndefined();
  });

  it("anthropic_messages: derives a thinking block with constraint fix-ups", () => {
    const { body, mutated } = applyForcedReasoningToNativeBody(
      { messages: [], max_tokens: 50, temperature: 0 },
      "anthropic_messages",
      "high",
    );
    expect(mutated).toBe(true);
    expect((body.thinking as { type: string }).type).toBe("enabled");
    expect(body.temperature).toBe(1);
  });

  it("openai_chat: no-op (lingua franca never passes through)", () => {
    const { mutated } = applyForcedReasoningToNativeBody({ messages: [] }, "openai_chat", "high");
    expect(mutated).toBe(false);
  });
});
