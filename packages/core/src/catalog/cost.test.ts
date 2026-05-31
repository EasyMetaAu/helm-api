import type { Pricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { computeCostUsd } from "./cost.js";

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
