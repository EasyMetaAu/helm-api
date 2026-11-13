import { describe, expect, it } from "vitest";
import { resolveCostUsd } from "./cost.js";
import { loadRuntimeCatalog } from "./load.js";

// Official price cards checked 2026-11-14:
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
const catalog = loadRuntimeCatalog({ configDir: "config" });

describe("current model pricing", () => {
  it.each([
    "anthropic",
    "anthropic-api",
  ])("%s prices Fable/Mythos 5.2 with both cache durations, Fast and US inference", (provider) => {
    for (const model of ["claude-fable-5-2", "claude-mythos-5-2"]) {
      const pricing = catalog.get(`${provider}/${model}`)?.pricing;
      for (const [speed, multiplier] of [
        ["standard", 1],
        ["fast", 2],
      ] as const) {
        for (const [inference_geo, geo] of [
          ["global", 1],
          ["us", 1.1],
        ] as const) {
          expect(
            resolveCostUsd(pricing, {
              usage: {
                input_tokens: 600,
                cache_read_input_tokens: 300,
                cache_creation_input_tokens: 100,
                cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
                output_tokens: 200,
                speed,
                inference_geo,
              },
            }),
          ).toBeCloseTo(
            ((600 * 8 + 300 * 0.2 + 60 * 10 + 40 * 16 + 200 * 40) * multiplier * geo) / 1_000_000,
            12,
          );
        }
      }
    }
  });

  it.each([
    "anthropic",
    "anthropic-api",
  ])("%s prices Haiku 5.5 above 100K using the whole prompt including caches", (provider) => {
    const pricing = catalog.get(`${provider}/claude-haiku-5-5`)?.pricing;
    for (const prompt of [100_000, 100_001]) {
      for (const [inference_geo, geo] of [
        ["global", 1],
        ["us", 1.1],
      ] as const) {
        expect(
          resolveCostUsd(pricing, {
            usage: {
              input_tokens: prompt - 400,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 100,
              cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
              output_tokens: 200,
              inference_geo,
            },
          }),
        ).toBeCloseTo(
          (((prompt - 400) * 0.1 + 300 * 0.01 + 60 * 0.125 + 40 * 0.2 + 200 * 0.5) *
            (prompt > 100_000 ? 5 : 1) *
            geo) /
            1_000_000,
          12,
        );
      }
    }
  });

  it.each([
    "anthropic",
    "anthropic-api",
  ])("%s uses Sonnet 5.5's 5%% cache-read rate", (provider) => {
    expect(
      resolveCostUsd(catalog.get(`${provider}/claude-sonnet-5-5`)?.pricing, {
        usage: { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 },
      }),
    ).toBeCloseTo(0.1, 12);
  });

  it.each([
    "openai",
    "openai-codex",
  ])("%s prices the current GPT lineup across context, speed and region", (provider) => {
    for (const [model, input, output, read] of [
      ["gpt-6-astra", 10, 50, 1],
      ["gpt-6.1-sol", 2, 10, 0.1],
      ["gpt-6.1-terra", 1, 5, 0.05],
      ["gpt-6-luna", 0.1, 0.5, 0.01],
    ] as const) {
      const pricing = catalog.get(`${provider}/${model}`)?.pricing;
      const tiers: [string, number][] = [
        ["default", 1],
        ["flex", 0.5],
        ["priority", 2],
        ["fast", 2],
      ];
      if (model === "gpt-6-astra" || model === "gpt-6.1-sol") tiers.push(["ultrafast", 6]);
      for (const [service_tier, multiplier] of tiers) {
        for (const prompt of [272_000, 272_001]) {
          for (const [inference_geo, geo] of [
            ["global", 1],
            ["us", 1.1],
            ["eu", 1.1],
          ] as const) {
            const context = prompt > 272_000 ? 2 : 1;
            expect(
              resolveCostUsd(pricing, {
                service_tier,
                usage: {
                  input_tokens: prompt,
                  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
                  output_tokens: 200,
                  inference_geo,
                },
              }),
            ).toBeCloseTo(
              (((prompt - 400) * input * context +
                300 * read * context +
                100 * input * 1.25 * context +
                200 * output * (prompt > 272_000 ? 1.5 : 1)) *
                multiplier *
                geo) /
                1_000_000,
              12,
            );
          }
        }
      }
    }
  });
});
