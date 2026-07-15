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

  it("prices Anthropic 5-minute and 1-hour cache writes at distinct official rates", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cacheReadPerMTokUsd: 0.3,
      cacheWritePerMTokUsd: 3.75,
      cacheWrite1hPerMTokUsd: 6,
    };
    const cost = computeCostUsd(pricing, {
      promptTokens: 1_000,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 300,
      cacheCreation5mPromptTokens: 200,
      cacheCreation1hPromptTokens: 100,
      completionTokens: 200,
    });
    // fresh 400*3 + read 300*.3 + 5m write 200*3.75 + 1h write 100*6 + output 200*15.
    expect(cost).toBeCloseTo((1200 + 90 + 750 + 600 + 3000) / 1_000_000, 12);
  });

  it("applies the full-request context tier above its official input-token threshold", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 12,
      cacheReadPerMTokUsd: 0.2,
      cacheWritePerMTokUsd: null,
      contextTiers: [
        {
          minPromptTokens: 200_001,
          inputPerMTokUsd: 4,
          outputPerMTokUsd: 18,
          cacheReadPerMTokUsd: 0.4,
        },
      ],
    };
    const cost = computeCostUsd(pricing, {
      promptTokens: 250_000,
      cachedPromptTokens: 50_000,
      completionTokens: 10_000,
    });
    expect(cost).toBeCloseTo((200_000 * 4 + 50_000 * 0.4 + 10_000 * 18) / 1_000_000, 12);
  });

  it("prices image output tokens separately from text and thinking output", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 3,
      imageOutputPerMTokUsd: 60,
      cacheReadPerMTokUsd: null,
      cacheWritePerMTokUsd: null,
    };
    const cost = computeCostUsd(pricing, {
      promptTokens: 100,
      completionTokens: 1_220,
      imageOutputTokens: 1_120,
    });
    expect(cost).toBeCloseTo((100 * 0.5 + 100 * 3 + 1_120 * 60) / 1_000_000, 12);
  });

  it("returns unknown when a split-rate image/audio model omits modality details", () => {
    expect(
      computeCostUsd(
        {
          inputPerMTokUsd: 0.5,
          outputPerMTokUsd: 3,
          imageOutputPerMTokUsd: 60,
          cacheReadPerMTokUsd: null,
          cacheWritePerMTokUsd: null,
        },
        { promptTokens: 100, completionTokens: 1_120 },
      ),
    ).toBeNull();
    expect(
      computeCostUsd(
        {
          inputPerMTokUsd: 0.25,
          outputPerMTokUsd: 1.5,
          audioInputPerMTokUsd: 0.5,
          cacheReadPerMTokUsd: 0.025,
          audioCacheReadPerMTokUsd: 0.05,
          cacheWritePerMTokUsd: null,
        },
        { promptTokens: 100, completionTokens: 10 },
      ),
    ).toBeNull();
  });

  it("uses the provider-confirmed service tier instead of standard prices", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 30,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 6.25,
      serviceTiers: {
        priority: {
          inputPerMTokUsd: 10,
          outputPerMTokUsd: 60,
          cacheReadPerMTokUsd: 1,
          cacheWritePerMTokUsd: 12.5,
          maxPromptTokens: 272_000,
        },
      },
    };
    expect(
      computeCostUsd(pricing, {
        promptTokens: 1_000,
        cachedPromptTokens: 200,
        cacheCreationPromptTokens: 100,
        completionTokens: 100,
        serviceTier: "priority",
      }),
    ).toBeCloseTo((700 * 10 + 200 * 1 + 100 * 12.5 + 100 * 60) / 1_000_000, 12);
    // OpenAI does not publish >272K Priority rates; unknown must stay null.
    expect(
      computeCostUsd(pricing, {
        promptTokens: 272_001,
        completionTokens: 1,
        serviceTier: "priority",
      }),
    ).toBeNull();
  });

  it("normalizes official Gemini tier names and treats unspecified as Standard", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 12,
      cacheReadPerMTokUsd: 0.2,
      cacheWritePerMTokUsd: null,
      serviceTiers: {
        flex: {
          inputPerMTokUsd: 1,
          outputPerMTokUsd: 6,
          cacheReadPerMTokUsd: 0.2,
        },
      },
    };

    expect(
      computeCostUsd(pricing, {
        promptTokens: 1_000,
        completionTokens: 100,
        serviceTier: " FLEX ",
      }),
    ).toBeCloseTo((1_000 * 1 + 100 * 6) / 1_000_000, 12);
    expect(
      computeCostUsd(pricing, {
        promptTokens: 1_000,
        completionTokens: 100,
        serviceTier: "unspecified",
      }),
    ).toBeCloseTo((1_000 * 2 + 100 * 12) / 1_000_000, 12);
  });

  it("stacks Anthropic US inference geo with Fast and cache TTL pricing", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 6.25,
      cacheWrite1hPerMTokUsd: 10,
      inferenceGeoMultipliers: { global: 1, us: 1.1 },
      serviceTiers: {
        fast: {
          inputPerMTokUsd: 10,
          outputPerMTokUsd: 50,
          cacheReadPerMTokUsd: 1,
          cacheWritePerMTokUsd: 12.5,
          cacheWrite1hPerMTokUsd: 20,
        },
      },
    };
    const usage = {
      promptTokens: 1_000,
      cachedPromptTokens: 200,
      cacheCreationPromptTokens: 100,
      cacheCreation5mPromptTokens: 60,
      cacheCreation1hPromptTokens: 40,
      completionTokens: 100,
      serviceTier: "fast",
    };
    const fastBase = 700 * 10 + 200 * 1 + 60 * 12.5 + 40 * 20 + 100 * 50;

    expect(computeCostUsd(pricing, { ...usage, inferenceGeo: "us" })).toBeCloseTo(
      (fastBase * 1.1) / 1_000_000,
      12,
    );
    expect(computeCostUsd(pricing, { ...usage, inferenceGeo: " GLOBAL " })).toBeCloseTo(
      fastBase / 1_000_000,
      12,
    );
  });

  it("keeps unconfigured or unknown inference geos unpriced", () => {
    expect(
      computeCostUsd(gpt4o, {
        promptTokens: 100,
        completionTokens: 10,
        inferenceGeo: "us",
      }),
    ).toBeNull();
    expect(
      computeCostUsd(
        { ...gpt4o, inferenceGeoMultipliers: { global: 1, us: 1.1 } },
        { promptTokens: 100, completionTokens: 10, inferenceGeo: "moon" },
      ),
    ).toBeNull();
  });

  it("uses the global card when Anthropic reports that inference geo is unavailable", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 6.25,
      inferenceGeoMultipliers: { global: 1, us: 1.1 },
    };

    expect(
      computeCostUsd(pricing, {
        promptTokens: 467_556,
        cachedPromptTokens: 466_435,
        cacheCreationPromptTokens: 1_119,
        completionTokens: 264,
        inferenceGeo: " NOT_AVAILABLE ",
      }),
    ).toBeCloseTo(0.24682125, 12);
    expect(
      computeCostUsd(pricing, {
        promptTokens: 100,
        completionTokens: 10,
        inferenceGeo: " ",
      }),
    ).toBeCloseTo((100 * 5 + 10 * 25) / 1_000_000, 12);
  });

  it("keeps unsupported Gemini image service tiers unpriced", () => {
    const standardOnlyImage: Pricing = {
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 3,
      imageOutputPerMTokUsd: 60,
      cacheReadPerMTokUsd: null,
      cacheWritePerMTokUsd: null,
    };
    expect(
      computeCostUsd(standardOnlyImage, {
        promptTokens: 100,
        completionTokens: 1_120,
        imageOutputTokens: 1_120,
        serviceTier: "flex",
      }),
    ).toBeNull();
  });

  it("prices Gemini Flash-Lite audio input and cached audio at their modality rates", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 0.25,
      outputPerMTokUsd: 1.5,
      cacheReadPerMTokUsd: 0.025,
      cacheWritePerMTokUsd: null,
      audioInputPerMTokUsd: 0.5,
      audioCacheReadPerMTokUsd: 0.05,
    };
    const cost = computeCostUsd(pricing, {
      promptTokens: 1_000,
      cachedPromptTokens: 200,
      audioPromptTokens: 400,
      cachedAudioPromptTokens: 100,
      completionTokens: 100,
    });
    // Fresh: 500 default + 300 audio. Cached: 100 default + 100 audio.
    expect(cost).toBeCloseTo(
      (500 * 0.25 + 300 * 0.5 + 100 * 0.025 + 100 * 0.05 + 100 * 1.5) / 1_000_000,
      12,
    );
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

  it("preserves Anthropic's 5-minute and 1-hour cache-creation breakdown", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 600,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_5m_input_tokens: 70,
            ephemeral_1h_input_tokens: 30,
          },
          output_tokens: 200,
        },
      }),
    ).toEqual({
      promptTokens: 1_000,
      completionTokens: 200,
      cachedPromptTokens: 300,
      cacheCreationPromptTokens: 100,
      cacheCreation5mPromptTokens: 70,
      cacheCreation1hPromptTokens: 30,
    });
  });

  it("preserves response-confirmed Anthropic speed and inference geo", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          speed: "fast",
          inference_geo: "us",
        },
      }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      serviceTier: "fast",
      inferenceGeo: "us",
    });
  });

  it("recognizes DeepSeek's automatic disk-cache hit tokens", () => {
    expect(
      usageFromBody({
        usage: {
          prompt_tokens: 1_000,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
          completion_tokens: 100,
        },
      }),
    ).toEqual({
      promptTokens: 1_000,
      completionTokens: 100,
      cachedPromptTokens: 800,
    });
  });

  it("extracts image-output modality tokens for mixed Gemini image responses", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 100,
          output_tokens: 1_220,
          output_tokens_details: { image_tokens: 1_120, text_tokens: 60, reasoning_tokens: 40 },
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 1_220,
      imageOutputTokens: 1_120,
    });
    expect(
      usageFromBody({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 1_220,
          completion_tokens_details: { image_tokens: 1_120 },
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 1_220,
      imageOutputTokens: 1_120,
    });
  });

  it("extracts prompt and cached-audio modality details", () => {
    expect(
      usageFromBody({
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          input_tokens_details: {
            cached_tokens: 200,
            audio_tokens: 400,
            cached_audio_tokens: 100,
          },
        },
      }),
    ).toEqual({
      promptTokens: 1_000,
      completionTokens: 100,
      cachedPromptTokens: 200,
      audioPromptTokens: 400,
      cachedAudioPromptTokens: 100,
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

  it("reads the actual response service_tier for official tier pricing", () => {
    const pricing: Pricing = {
      ...gpt4o,
      serviceTiers: {
        priority: {
          inputPerMTokUsd: 5,
          outputPerMTokUsd: 20,
          cacheReadPerMTokUsd: 2.5,
        },
      },
    };
    expect(
      resolveCostUsd(pricing, {
        service_tier: "priority",
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      }),
    ).toBeCloseTo(0.015, 12);
  });

  it("reads Anthropic usage.speed for official Fast pricing", () => {
    const pricing: Pricing = {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 6.25,
      serviceTiers: {
        fast: {
          inputPerMTokUsd: 10,
          outputPerMTokUsd: 50,
          cacheReadPerMTokUsd: 1,
          cacheWritePerMTokUsd: 12.5,
        },
      },
    };
    expect(
      resolveCostUsd(pricing, {
        usage: {
          input_tokens: 700,
          output_tokens: 100,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
          speed: "fast",
        },
      }),
    ).toBeCloseTo((700 * 10 + 200 * 1 + 100 * 12.5 + 100 * 50) / 1_000_000, 12);
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

  it("returns null when a priced response reports no usable token usage", () => {
    expect(resolveCostUsd(gpt4o, { id: "response-without-usage" })).toBeNull();
    expect(resolveCostUsd(gpt4o, { usage: {} })).toBeNull();
    expect(resolveCostUsd(gpt4o, { usage: { service_tier: "priority" } })).toBeNull();
    // Explicit zero fields are measured usage and remain a real zero-dollar cost.
    expect(resolveCostUsd(gpt4o, { usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBe(0);
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
      jsonOutput: "none",
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

  it("preserves long-context tiers for compaction economics", () => {
    const tiered: CatalogEntry = {
      ...entry,
      modelKey: "openai/gpt-5.6-sol",
      pricing: {
        ...entry.pricing,
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 30,
        cacheReadPerMTokUsd: 0.5,
        cacheWritePerMTokUsd: 6.25,
        contextTiers: [
          {
            minPromptTokens: 272_001,
            inputPerMTokUsd: 10,
            outputPerMTokUsd: 45,
            cacheReadPerMTokUsd: 1,
            cacheWritePerMTokUsd: 12.5,
          },
        ],
      },
    };
    expect(
      resolveCompactionPricing(new Map([[tiered.modelKey, tiered]]), tiered.modelKey).contextTiers,
    ).toEqual(tiered.pricing.contextTiers);
  });
});
