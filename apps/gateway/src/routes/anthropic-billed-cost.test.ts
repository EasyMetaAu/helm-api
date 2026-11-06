import { loadRuntimeCatalog, resolveCostUsd } from "@helm/core";
import { describe, expect, it } from "vitest";
import { usageFromAnthropicResponse, usageFromAnthropicSSE } from "./payload-capture.js";

const usage = { input_tokens: 18, output_tokens: 4, inference_geo: "global", cost: "0.000152" };
describe("Anthropic relay billed cost", () => {
  it("preserves decimal amounts on non-stream responses, including zero", () => {
    expect(usageFromAnthropicResponse({ usage })?.cost_usd).toBe(0.000152);
    expect(usageFromAnthropicResponse({ usage: { ...usage, cost: "0" } })?.cost_usd).toBe(0);
  });
  it("uses the final cumulative SSE amount, not the sum, and ignores invalid tails", () => {
    const raw = [
      {
        type: "message_start",
        message: { usage: { ...usage, output_tokens: 0, cost: "0.000072" } },
      },
      { type: "message_delta", usage: { output_tokens: 4, cost: "0.000152" } },
      { type: "message_delta", usage: { cost: "NaN" } },
    ]
      .map((x) => `data: ${JSON.stringify(x)}\n\n`)
      .join("");
    const parsed = usageFromAnthropicSSE(raw);
    expect(parsed?.cost_usd).toBe(0.000152);
    expect(resolveCostUsd(undefined, { usage: parsed })).toBe(0.000152);
  });
  it.each([
    "",
    " ",
    "-1",
    "Infinity",
    "NaN",
    "0x10",
    "1usd",
    false,
    null,
  ])("rejects invalid billed amount %j", (cost) => {
    expect(usageFromAnthropicResponse({ usage: { ...usage, cost } })?.cost_usd).toBeUndefined();
  });
  it.each([
    "haiku",
    "sonnet",
    "opus",
  ])("prices the exact ZenMux %s alias with global inference", (tier) => {
    const pricing = loadRuntimeCatalog({ configDir: "config" }).get(
      `zenmux-anthropic/claude-${tier}-5.5`,
    )?.pricing;
    expect(pricing?.inferenceGeoMultipliers?.global).toBe(1);
    expect(
      resolveCostUsd(pricing, {
        usage: { prompt_tokens: 18, completion_tokens: 4, inference_geo: "global" },
      }),
    ).toBeGreaterThan(0);
  });
});
