import type { Pricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { resolveCostUsd } from "./cost.js";

// gpt-image-2 (ZenMux): input $5/M text, image-output $30/M. The generated image
// is billed as `usage.output_tokens` (= output_tokens_details.image_tokens), which
// usageFromBody maps to completionTokens — so the existing token-cost path prices
// it exactly (no images-specific cost code needed).
describe("resolveCostUsd — OpenAI Images usage shape", () => {
  const gptImage2: Pricing = {
    inputPerMTokUsd: 5.0,
    outputPerMTokUsd: 30.0,
    cacheReadPerMTokUsd: null,
    cacheWritePerMTokUsd: null,
  };

  it("prices input_tokens at the input rate and output (image) tokens at the image rate", () => {
    const body = {
      usage: { input_tokens: 15, output_tokens: 196, output_tokens_details: { image_tokens: 196 } },
    };
    // 15*5/1e6 + 196*30/1e6 = 0.000075 + 0.00588 = 0.005955
    expect(resolveCostUsd(gptImage2, body)).toBeCloseTo((15 * 5 + 196 * 30) / 1_000_000, 10);
  });

  it("returns null when pricing is missing (fail-open)", () => {
    expect(resolveCostUsd(undefined, { usage: { output_tokens: 196 } })).toBeNull();
  });
});
