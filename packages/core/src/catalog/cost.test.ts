import type { CatalogEntry, Pricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  billedCostFromBody,
  computeCostUsd,
  resolveCompactionPricing,
  resolveCostUsd,
  usageFromBody,
} from "./cost.js";

// Pricing is per MILLION tokens. cost = prompt/1e6*input + completion/1e6*output.
describe("computeCostUsd — token usage × catalog pricing", () => {
  const gpt4o: Pricing = {
    inputPerMTokUsd: 2.5,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: null,
    cacheWritePerMTokUsd: null,
  };

  it("computes cost from prompt/completion tokens and per-MTok pricing", () => {
    // 1000 prompt * 2.5/1e6 = 0.0025 ; 500 completion * 10/1e6 = 0.005
    const cost = computeCostUsd(gpt4o, { promptTokens: 1000, completionTokens: 500 });
    expect(cost).toBeCloseTo(0.0075, 12);
  });

  it("prices cache read/write tokens with cache-specific rates", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cacheReadPerMTokUsd: 0.3,
      cacheWritePerMTokUsd: 3.75,
    };
    const cost = computeCostUsd(pricing, {
      promptTokens: 1000,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
      completionTokens: 200,
    });
    // fresh 600*3 + read 300*0.3 + write 100*3.75 + output 200*15, all per 1M.
    expect(cost).toBeCloseTo((1800 + 90 + 375 + 3000) / 1_000_000, 12);
  });

  it("falls back cache rates to input pricing when cache-specific rates are unknown", () => {
    const cost = computeCostUsd(gpt4o, {
      promptTokens: 1000,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
      completionTokens: 500,
    });
    expect(cost).toBeCloseTo(1000 * 2.5e-6 + 500 * 10e-6, 12);
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
        {
          inputPerMTokUsd: null,
          outputPerMTokUsd: 10,
          cacheReadPerMTokUsd: null,
          cacheWritePerMTokUsd: null,
        },
        { promptTokens: 1000, completionTokens: 500 },
      ),
    ).toBeNull();
    expect(
      computeCostUsd(
        {
          inputPerMTokUsd: 2.5,
          outputPerMTokUsd: null,
          cacheReadPerMTokUsd: null,
          cacheWritePerMTokUsd: null,
        },
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

  it("extracts OpenAI-compatible cache read/write token details", () => {
    expect(
      usageFromBody({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: {
            cached_tokens: 300,
            cache_creation_tokens: 100,
          },
        },
      }),
    ).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
    });
  });

  it("normalizes Anthropic-style input/cache usage into full prompt tokens", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 600,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
          output_tokens: 200,
        },
      }),
    ).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
    });
  });

  it("extracts Responses-style input token details", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          input_tokens_details: {
            cached_tokens: 300,
            cache_creation_input_tokens: 100,
          },
        },
      }),
    ).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
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
  const gpt4o: Pricing = {
    inputPerMTokUsd: 2.5,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: null,
    cacheWritePerMTokUsd: null,
  };

  it("uses the upstream-billed cost over the catalog estimate", () => {
    const body = { usage: { prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.99 } };
    // Estimate would be 0.0075; the billed 0.99 must win.
    expect(resolveCostUsd(gpt4o, body)).toBe(0.99);
  });

  it("falls back to the catalog estimate when no billed cost is present", () => {
    const body = { usage: { prompt_tokens: 1000, completion_tokens: 500 } };
    expect(resolveCostUsd(gpt4o, body)).toBeCloseTo(0.0075, 12);
  });

  it("uses cache-specific catalog prices when estimating from usage details", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cacheReadPerMTokUsd: 0.3,
      cacheWritePerMTokUsd: 3.75,
    };
    const body = {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
      },
    };
    expect(resolveCostUsd(pricing, body)).toBeCloseTo((1800 + 90 + 375 + 3000) / 1_000_000, 12);
  });

  it("honors a billed cost even when pricing is unknown (no catalog entry)", () => {
    expect(resolveCostUsd(undefined, { usage: { cost_usd: 0.02 } })).toBe(0.02);
  });

  it("returns null when there is neither a billed cost nor pricing", () => {
    expect(resolveCostUsd(undefined, { usage: { prompt_tokens: 10 } })).toBeNull();
  });
});

// resolveCompactionPricing: the memory compaction model's price/context lookup.
// Pure catalog read — every field nullable, no heuristics here (the compaction
// policy owns its own fallbacks so they stay unit-testable in one place).
describe("resolveCompactionPricing — compaction inputs from the catalog", () => {
  const entry: CatalogEntry = {
    modelKey: "anthropic/claude-3-5-sonnet",
    capabilities: {
      supportsTools: true,
      supportsJsonMode: false,
      supportsVision: true,
      supportsStreaming: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 8_192,
    },
    pricing: {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cacheReadPerMTokUsd: 0.3,
      cacheWritePerMTokUsd: 3.75,
    },
    source: "generated",
  };
  const catalog = new Map([[entry.modelKey, entry]]);

  it("resolves all prices + context window for a known model", () => {
    expect(resolveCompactionPricing(catalog, "anthropic/claude-3-5-sonnet")).toEqual({
      modelKey: "anthropic/claude-3-5-sonnet",
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.3,
      cacheWritePerMtok: 3.75,
      maxContextTokens: 200_000,
    });
  });

  it("returns all-null for an unknown model (fail-open, caller falls back)", () => {
    expect(resolveCompactionPricing(catalog, "nope/unknown")).toEqual({
      modelKey: null,
      inputPerMtok: null,
      outputPerMtok: null,
      cacheReadPerMtok: null,
      cacheWritePerMtok: null,
      maxContextTokens: null,
    });
  });

  it("returns all-null when no model key is known yet (first request of a thread)", () => {
    const empty = resolveCompactionPricing(catalog, null);
    expect(empty.modelKey).toBeNull();
    expect(empty.inputPerMtok).toBeNull();
    expect(empty.maxContextTokens).toBeNull();
  });

  it("passes through per-field nulls and treats a 0 context window as unknown", () => {
    const sparse: CatalogEntry = {
      ...entry,
      modelKey: "local/llama",
      capabilities: { ...entry.capabilities, maxContextTokens: 0 },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
    };
    const resolved = resolveCompactionPricing(new Map([[sparse.modelKey, sparse]]), "local/llama");
    expect(resolved).toEqual({
      modelKey: "local/llama",
      inputPerMtok: null,
      outputPerMtok: null,
      cacheReadPerMtok: null,
      cacheWritePerMtok: null,
      maxContextTokens: null,
    });
  });
});
