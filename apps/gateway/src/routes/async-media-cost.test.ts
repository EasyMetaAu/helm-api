import type { MediaPricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { priceAsyncMediaResult } from "./async-media-cost.js";

const card = (
  providerModel: string,
  rates: MediaPricing["rates"],
  currency: MediaPricing["currency"] = "CNY",
): MediaPricing => ({
  providerModel,
  rates,
  currency,
  region: "test",
  source: "https://example.test/pricing",
  basis: "official_list_price",
  verifiedOn: "2026-11-20",
  notes: [],
});

describe("asynchronous media prices", () => {
  const wan = card("wan3.0-video", [
    {
      direction: "input_and_output_video",
      unit: "second",
      price: 0.6,
      conditions: { outputResolution: "720P" },
      promotion: { multiplier: 0.7, effectivePrice: 0.42, endDate: null, status: "temporary" },
    },
  ]);
  it("uses actual Wan input + output duration and SR, with catalog list pricing", () => {
    const result = priceAsyncMediaResult(
      { requestId: "req", profile: "wan", hasInputVideo: true, pricing: wan },
      { usage: { SR: "720P", input_video_duration: 3, output_video_duration: 7 } },
    );
    expect(result?.cost).toEqual({
      currency: "CNY",
      amount: 6,
      cost_usd: null,
      basis: "official_list_price",
      verified_on: "2026-11-20",
    });
    expect(
      priceAsyncMediaResult(
        { requestId: "req", profile: "wan", hasInputVideo: false, pricing: wan },
        { usage: { SR: 720, output_video_duration: 7 } },
      )?.cost.amount,
    ).toBeCloseTo(4.2);
    expect(
      priceAsyncMediaResult(
        { requestId: "req", profile: "wan", hasInputVideo: true, pricing: wan },
        { usage: { SR: "720P", output_video_duration: 7 } },
      ),
    ).toBeNull();
  });

  it("prices MiniMax input, output and images once using actual resolution and free images", () => {
    const h3 = card(
      "MiniMax-H3",
      [
        {
          direction: "input_video",
          unit: "second",
          price: 0.08,
          conditions: { outputResolution: "768P" },
        },
        {
          direction: "output_video",
          unit: "second",
          price: 0.08,
          conditions: { outputResolution: "768P" },
        },
        { direction: "input_image", unit: "image", price: 0.04, freeQuantity: 5, conditions: {} },
        { direction: "input_audio", unit: "second", price: 0, conditions: {} },
      ],
      "USD",
    );
    const result = priceAsyncMediaResult(
      { requestId: "req", profile: "minimax", pricing: h3 },
      {
        task: {
          resolution: "768P",
          usage: { input_seconds: 2, output_seconds: 6, input_image_count: 7, total_seconds: 8 },
        },
      },
    );
    expect(result?.cost.cost_usd).toBeCloseTo(0.72);
  });

  it("prices Fun-ASR by provider duration and retains CNY without a configured FX rate", () => {
    const fun = card("fun-asr", [
      { direction: "input_audio", unit: "second", price: 0.00022, conditions: {} },
    ]);
    const result = priceAsyncMediaResult(
      { requestId: "req", profile: "fun-asr", pricing: fun },
      { usage: { duration: 15, channels: 2 } },
    );
    expect(result?.cost.amount).toBeCloseTo(0.0033);
    expect(result?.cost.cost_usd).toBeNull();
    expect(
      priceAsyncMediaResult(
        { requestId: "req", profile: "fun-asr", pricing: fun },
        { usage: { duration: 0 } },
      )?.cost.amount,
    ).toBe(0);
  });
});
