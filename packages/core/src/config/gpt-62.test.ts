import { describe, expect, it } from "vitest";
import { computeCostUsd } from "../catalog/cost.js";
import { loadRuntimeCatalog } from "../catalog/load.js";
import { expandLaneChain } from "../lanes/expand-chain.js";
import { resolveModelAlias } from "../routing/model-alias.js";
import { loadConfig } from "./loader.js";

const cfg = loadConfig({ configDir: "config", env: {} });
const catalog = loadRuntimeCatalog({ configDir: "config" });
describe.each([
  ["astra", 8, 40, 272000],
  ["sol", 2, 10, 500000],
] as const)("GPT-6.2 %s", (family, input, output, codexContext) => {
  const model = `gpt-6.2-${family}`;
  it("routes explicit requests to the new subscription model and registers paid Responses separately", () => {
    for (const id of [
      model,
      `openai.${model}`,
      `${model}-2026-11-17`,
      `openai.${model}-2026-11-17`,
    ]) {
      expect(resolveModelAlias(id, cfg.model_aliases)).toBe(model);
    }
    const chain = expandLaneChain(model, cfg.lanes ?? {});
    expect(chain[0]).toBe(`openai-codex/${model}`);
    expect(chain).not.toContain(`openai/${model}`);
    expect(cfg.providers.find((p) => p.name === "openai-responses")?.models).toContainEqual({
      alias: `openai/${model}`,
      provider_model: model,
    });
  });
  it.each([
    "openai",
    "openai-codex",
  ])("loads %s capabilities and prices the entire request at the correct context and speed", (provider) => {
    const entry = catalog.get(`${provider}/${model}`);
    expect(entry?.capabilities).toMatchObject({
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      jsonOutput: "schema",
      maxContextTokens: provider === "openai" ? 1050000 : codexContext,
      maxOutputTokens: 128000,
    });
    expect(entry?.capabilities.reasoningEffort?.openaiReasoning?.levels).not.toContain("none");
    for (const [serviceTier, multiplier] of [
      ["default", 1],
      ["batch", 0.5],
      ["fast", 2],
      ["priority", 2],
      ["ultrafast", 3],
    ] as const) {
      for (const promptTokens of [272000, 272001]) {
        const long = promptTokens > 272000;
        const expected =
          ((promptTokens - 300) * input + 200 * input * 0.05 + 100 * input * 1.25) *
            (long ? 2 : 1) +
          50 * output * (long ? 1.5 : 1);
        expect(
          computeCostUsd(entry?.pricing, {
            promptTokens,
            completionTokens: 50,
            cachedPromptTokens: 200,
            cacheCreationPromptTokens: 100,
            serviceTier,
            inferenceGeo: "us",
          }),
        ).toBeCloseTo((expected * multiplier * 1.1) / 1e6, 12);
      }
    }
    expect(computeCostUsd(entry?.pricing, { promptTokens: 100, serviceTier: "flex" })).toBeNull();
  });
});
