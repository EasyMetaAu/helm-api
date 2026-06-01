import type { Pricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { billedCostFromBody, computeCostUsd, resolveCostUsd, usageFromBody } from "./cost.js";

// Pricing is per MILLION tokens. cost = prompt/1e6*input + completion/1e6*output.
describe("computeCostUsd — token usage × catalog pricing", () => {
  const gpt4o: Pricing = { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 };

  it("computes cost from prompt/completion tokens and per-MTok pricing", () => {
    // 1000 prompt * 2.5/1e6 = 0.0025 ; 500 completion * 10/1e6 = 0.005
    const cost = computeCostUsd(gpt4o, { promptTokens: 1000, completionTokens: 500 });
    expect(cost).toBeCloseTo(0.0075, 12);
  });

  it("treats absent token counts as zero (still a measured number, not null)", () => {
    expect(computeCostUsd(gpt4o, { promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(computeCostUsd(gpt4o, {})).toBe(0);
  });

  it("returns null when pricing is undefined (no catalog entry)", () => {
    expect(computeCostUsd(undefined, { promptTokens: 1000, completionTokens: 500 })).toBeNull();
  });

  it("returns null when either price field is null (missing pricing data)", () => {
    expect(
      computeCostUsd(
        { inputPerMTokUsd: null, outputPerMTokUsd: 10 },
        { promptTokens: 1000, completionTokens: 500 },
      ),
    ).toBeNull();
    expect(
      computeCostUsd(
        { inputPerMTokUsd: 2.5, outputPerMTokUsd: null },
        { promptTokens: 1000, completionTokens: 500 },
      ),
    ).toBeNull();
  });
});

// usageFromBody extracts OpenAI-shaped token counts defensively: only FINITE,
// non-negative numbers survive; everything else collapses to undefined (→ 0 by
// computeCostUsd), preserving the null-vs-0 cost invariant.
describe("usageFromBody — defensive token extraction", () => {
  it("extracts finite non-negative prompt/completion tokens", () => {
    expect(usageFromBody({ usage: { prompt_tokens: 1000, completion_tokens: 500 } })).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
    });
  });

  it("accepts a measured zero (a real count, not absent)", () => {
    expect(usageFromBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it("drops NaN to undefined (NaN cost would serialize to null masquerading as not-measured)", () => {
    expect(usageFromBody({ usage: { prompt_tokens: Number.NaN, completion_tokens: 500 } })).toEqual(
      {
        promptTokens: undefined,
        completionTokens: 500,
      },
    );
  });

  it("drops negatives and non-finite values to undefined", () => {
    expect(
      usageFromBody({ usage: { prompt_tokens: -1, completion_tokens: Number.POSITIVE_INFINITY } }),
    ).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
    });
  });

  it("returns {} for a missing or non-object usage field", () => {
    expect(usageFromBody({})).toEqual({});
    expect(usageFromBody(null)).toEqual({});
    expect(usageFromBody({ usage: "nope" })).toEqual({});
  });
});

// billedCostFromBody surfaces an upstream-returned cost (real money charged),
// probing usage.cost_usd → usage.cost (OpenRouter) → top-level cost_usd, and
// defensively rejecting anything non-finite/negative.
describe("billedCostFromBody — upstream-returned cost", () => {
  it("reads usage.cost_usd", () => {
    expect(billedCostFromBody({ usage: { cost_usd: 0.0123 } })).toBe(0.0123);
  });

  it("reads OpenRouter-style usage.cost", () => {
    expect(billedCostFromBody({ usage: { cost: 0.0042 } })).toBe(0.0042);
  });

  it("reads a top-level cost_usd", () => {
    expect(billedCostFromBody({ cost_usd: 0.5 })).toBe(0.5);
  });

  it("prefers usage.cost_usd over usage.cost and top-level cost_usd", () => {
    expect(billedCostFromBody({ cost_usd: 9, usage: { cost_usd: 1, cost: 2 } })).toBe(1);
    // usage.cost beats the top-level fallback when usage.cost_usd is absent.
    expect(billedCostFromBody({ cost_usd: 9, usage: { cost: 2 } })).toBe(2);
  });

  it("accepts a measured zero billed cost", () => {
    expect(billedCostFromBody({ usage: { cost_usd: 0 } })).toBe(0);
  });

  it("returns null when no billed cost is present", () => {
    expect(billedCostFromBody({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toBeNull();
    expect(billedCostFromBody({})).toBeNull();
    expect(billedCostFromBody(null)).toBeNull();
  });

  it("rejects non-finite / negative billed costs (falls back to estimate)", () => {
    expect(billedCostFromBody({ usage: { cost_usd: -1 } })).toBeNull();
    expect(billedCostFromBody({ usage: { cost: Number.NaN } })).toBeNull();
    expect(billedCostFromBody({ cost_usd: "1.0" })).toBeNull();
  });
});

// resolveCostUsd is the single override-or-preset rule: upstream-billed cost wins;
// otherwise estimate from tokens × pricing; null only when neither is available.
describe("resolveCostUsd — billed overrides preset estimate", () => {
  const gpt4o: Pricing = { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 };

  it("uses the upstream-billed cost over the catalog estimate", () => {
    const body = { usage: { prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.99 } };
    // Estimate would be 0.0075; the billed 0.99 must win.
    expect(resolveCostUsd(gpt4o, body)).toBe(0.99);
  });

  it("falls back to the catalog estimate when no billed cost is present", () => {
    const body = { usage: { prompt_tokens: 1000, completion_tokens: 500 } };
    expect(resolveCostUsd(gpt4o, body)).toBeCloseTo(0.0075, 12);
  });

  it("honors a billed cost even when pricing is unknown (no catalog entry)", () => {
    expect(resolveCostUsd(undefined, { usage: { cost_usd: 0.02 } })).toBe(0.02);
  });

  it("returns null when there is neither a billed cost nor pricing", () => {
    expect(resolveCostUsd(undefined, { usage: { prompt_tokens: 10 } })).toBeNull();
  });
});
