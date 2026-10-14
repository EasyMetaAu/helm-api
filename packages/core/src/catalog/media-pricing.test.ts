import { readFileSync } from "node:fs";
import { PricingOverrideSchema, PricingSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseLanesConfig } from "../lanes/schema.js";
import { loadRuntimeCatalog } from "./load.js";
import { buildModelsList } from "./models-list.js";

// Independently transcribed official list prices, in the order of the billing
// dimensions in the card. Keep CNY separate from USD and promotions separate
// from permanent list prices. Sources and verification date live on each card.
const expected = {
  "ark/seedream-5.0-flash": [0, 0.12],
  "ark/seedream-5.0-pro": [0.02, 0.3, 0.6, 0.15, 0.3],
  "ark/seedance-2.5": [70, 70, 77, 42, 42, 46],
  "ark/seed3d-2.0": [2.4],
  "bailian/qwen-image-3.0-pro": [0.02, 0.25, 0.5],
  "bailian/qwen-image-3.0": [0.02, 0.18, 0.18],
  "bailian/qwen-image-2.1-pro": [0, 0.25],
  "bailian/qwen-image-2.1-turbo": [0, 0.1],
  "bailian/wan3.0-video": [0.3, 0.6, 1.2],
  "bailian/wan3.0-video-prime": [0.45, 0.9, 1.8],
  "bailian/qwen3-asr-flash": [0.00022],
  "bailian/qwen3-asr-flash-filetrans": [0.00022],
  "bailian/qwen-audio-3.0-asr-flash-filetrans": [0.00022],
  "bailian/fun-asr": [0.00022],
  "bailian/paraformer-v2": [0.00008],
  "bailian/paraformer-8k-v2": [0.00008],
  "bailian/qwen-audio-3.1-asr-flash-filetrans": [0.8, 2.7],
  "bailian/qwen-audio-3.1-tts-flash": [1.5, 12],
  "bailian/qwen-audio-3.0-tts-plus": [1.4],
  "bailian/cosyvoice-v3.5-plus": [1.5],
  "bailian/cosyvoice-v3.5-flash": [0.8],
  "minimax/MiniMax-H3": [0.08, 0.13, 0.08, 0.13, 0.04, 0],
  "minimax/MiniMax-H3-Max": [0.05, 0.08, 0.0553, 0.143, 0.074, 0],
  "minimax/speech-2.8-hd": [100],
  "minimax/speech-2.8-turbo": [60],
};

describe("native media model pricing configuration", () => {
  it("covers every configured Ark, Bailian and MiniMax alias, including wire-model identity", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const providers = parseYaml(readFileSync("config/providers.yaml", "utf8")).providers as {
      type: string;
      models: { alias: string; provider_model: string }[];
    }[];
    const models = providers
      .filter((p) => ["ark", "bailian-media", "minimax-media"].includes(p.type))
      .flatMap((p) => p.models);
    expect(models.map((m) => m.alias).sort()).toEqual(Object.keys(expected).sort());
    for (const model of models) {
      const pricing = catalog.get(model.alias)?.pricing;
      expect(pricing?.media, model.alias).toMatchObject({
        providerModel: model.provider_model,
        currency: model.alias.startsWith("minimax/") ? "USD" : "CNY",
        verifiedOn: "2026-10-14",
        basis: "official_list_price",
      });
      expect(
        pricing?.media?.rates.map((r) => r.price),
        model.alias,
      ).toEqual(expected[model.alias as keyof typeof expected]);
      expect(pricing?.inputPerMTokUsd).toBeNull();
      expect(pricing?.outputPerMTokUsd).toBeNull();
    }
  });

  it("retains tier boundaries, free quantities, token/character units and temporary discounts", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const card = (key: string) => catalog.get(key)?.pricing.media;
    expect(card("ark/seedream-5.0-pro")?.rates).toMatchObject([
      { freeQuantity: 1 },
      { conditions: { mode: "single_image", pixelsLte: 2610000 } },
      { conditions: { mode: "single_image", pixelsGt: 2610000 } },
      { unit: "layer", conditions: { mode: "layer_decomposition", pixelsLte: 2610000 } },
      { unit: "layer", conditions: { mode: "layer_decomposition", pixelsGt: 2610000 } },
    ]);
    expect(card("ark/seedance-2.5")?.rates[3]).toMatchObject({
      direction: "completion",
      unit: "million_tokens",
      price: 42,
      conditions: { resolution: "480p", hasInputVideo: true },
    });
    expect(card("ark/seed3d-2.0")?.rates).toHaveLength(1);
    expect(card("bailian/wan3.0-video")?.rates[0]).toMatchObject({
      direction: "input_and_output_video",
      unit: "second",
      price: 0.3,
      promotion: { multiplier: 0.7, effectivePrice: 0.21, endDate: null },
    });
    expect(card("bailian/qwen-audio-3.1-asr-flash-filetrans")?.rates[0]?.unit).toBe(
      "million_tokens",
    );
    expect(card("bailian/qwen-audio-3.0-tts-plus")?.rates[0]?.unit).toBe(
      "ten_thousand_billable_characters",
    );
    expect(card("minimax/MiniMax-H3")?.rates[4]?.freeQuantity).toBe(5);
    expect(card("minimax/MiniMax-H3-Max")?.rates[4]?.freeQuantity).toBe(2);
    for (const alias of ["minimax/speech-2.8-hd", "minimax/speech-2.8-turbo"]) {
      expect(card(alias)?.rates[0]?.unit).toBe("million_billable_characters");
      expect(card(alias)?.conditionalFees).toEqual([
        { kind: "rapid_voice_cloning", pricePerVoice: 1.5, charged: "first_synthesis_use" },
        { kind: "voice_design", pricePerVoice: 3, charged: "first_synthesis_use" },
      ]);
    }
  });

  it("exposes the loaded cards only on permitted concrete model entries", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const args = {
      catalog,
      lanes: parseLanesConfig({ balanced: { primary: "ark/seedream-5.0-flash", fallback: [] } }),
      providerAliases: Object.keys(expected),
    };
    const visible = buildModelsList({ ...args, allowCustomModel: true });
    for (const alias of Object.keys(expected)) {
      const item = visible.data.find((m) => m.id === alias);
      expect(item?.pricing?.media, alias).toBeDefined();
      expect(item?.pricing).toEqual(catalog.get(alias)?.pricing);
    }
    const ordinary = buildModelsList({ ...args, allowCustomModel: false });
    expect(ordinary.data.every((m) => m.pricing === undefined)).toBe(true);
  });

  it("preserves old configs and rejects invalid native price fields instead of stripping them", () => {
    const base = { inputPerMTokUsd: null, outputPerMTokUsd: null };
    expect(PricingSchema.parse(base)).not.toHaveProperty("media");
    const media = {
      currency: "CNY",
      region: "cn-beijing",
      providerModel: "model",
      basis: "official_list_price",
      verifiedOn: "2026-10-14",
      source: "https://example.com/pricing",
      notes: [],
      rates: [{ direction: "output", unit: "image", price: 0.12, conditions: {} }],
    };
    expect(PricingOverrideSchema.safeParse({ model: { media } }).success).toBe(true);
    for (const invalid of [
      { ...media, currency: "CYN" },
      { ...media, verifiedOn: "tomorrow" },
      { ...media, source: "javascript:alert(1)" },
      { ...media, rates: [] },
      { ...media, rates: [{ ...media.rates[0], price: -1 }] },
      { ...media, rates: [{ ...media.rates[0], unit: "token" }] },
      { ...media, rates: [{ ...media.rates[0], conditions: { resoultion: "480p" } }] },
      { ...media, rates: [{ ...media.rates[0], conditions: { pixelsGt: 20, pixelsLte: 10 } }] },
    ]) {
      expect(PricingOverrideSchema.safeParse({ model: { media: invalid } }).success).toBe(false);
      expect(() =>
        loadRuntimeCatalog({
          configDir: "config",
          readFile: (path) =>
            path.endsWith("pricing.yaml")
              ? JSON.stringify({ model: { media: invalid } })
              : readFileSync(path, "utf8"),
        }),
      ).toThrow();
    }
  });
});
