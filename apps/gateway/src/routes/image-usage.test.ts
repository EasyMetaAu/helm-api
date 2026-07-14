import { describe, expect, it } from "vitest";
import { geminiImageUsageBody } from "./image-usage.js";

describe("geminiImageUsageBody", () => {
  it("preserves image/text/thinking output modalities for exact billing", () => {
    expect(
      geminiImageUsageBody({
        promptTokenCount: 100,
        cachedContentTokenCount: 20,
        candidatesTokenCount: 1_180,
        thoughtsTokenCount: 40,
        candidatesTokensDetails: [
          { modality: "IMAGE", tokenCount: 1_120 },
          { modality: "TEXT", tokenCount: 60 },
        ],
      }),
    ).toEqual({
      usage: {
        input_tokens: 100,
        output_tokens: 1_220,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: {
          image_tokens: 1_120,
          text_tokens: 60,
          reasoning_tokens: 40,
        },
      },
    });
  });

  it("keeps the image/text partition unknown when modality detail is absent", () => {
    expect(geminiImageUsageBody({ promptTokenCount: 9, candidatesTokenCount: 1_120 })).toEqual({
      usage: {
        input_tokens: 9,
        output_tokens: 1_120,
      },
    });
    expect(
      geminiImageUsageBody({
        promptTokenCount: 9,
        candidatesTokenCount: 1_120,
        candidatesTokensDetails: [],
      }),
    ).toEqual({ usage: { input_tokens: 9, output_tokens: 1_120 } });
  });
});
