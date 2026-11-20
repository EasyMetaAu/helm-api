import { ArkImageGenerationResponseSchema, type MediaPricing } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { priceArkImage, priceQwenImage } from "./image-accounting.js";

const flash = "doubao-seedream-5-0-flash-260915";
const pro = "doubao-seedream-5-0-pro-260628";
const qwen = "qwen-image-3.0-pro";
const source = "https://media.example.com/image.png";
const base = { url: source, output_format: "jpeg", size: "2048x2048" };
const layer = {
  url: source,
  size: "1024x1024",
  output_format: "png",
  z_index: 1,
  name: "text",
  description: "Text element",
  bounding_box: { absolute: [0, 0, 1024, 1024], normalized: [0, 0, 500, 500] },
};

function card(providerModel: string, rates: MediaPricing["rates"]): MediaPricing {
  return {
    providerModel,
    rates,
    currency: "CNY",
    billing: { usdPerCurrencyUnit: 0.125 },
    region: "cn-beijing",
    source: "https://example.com/pricing",
    basis: "official_list_price",
    verifiedOn: "2026-11-20",
    notes: [],
  };
}

const flashCard = card(flash, [
  { direction: "input", unit: "image", price: 0, conditions: {} },
  { direction: "output", unit: "image", price: 0.12, conditions: {} },
]);
const proCard = card(pro, [
  { direction: "input", unit: "image", price: 0.02, freeQuantity: 1, conditions: {} },
  {
    direction: "output",
    unit: "image",
    price: 0.3,
    conditions: { mode: "single_image", pixelsLte: 2610000 },
  },
  {
    direction: "output",
    unit: "image",
    price: 0.6,
    conditions: { mode: "single_image", pixelsGt: 2610000 },
  },
  {
    direction: "output",
    unit: "layer",
    price: 0.15,
    conditions: { mode: "layer_decomposition", pixelsLte: 2610000 },
  },
  {
    direction: "output",
    unit: "layer",
    price: 0.3,
    conditions: { mode: "layer_decomposition", pixelsGt: 2610000 },
  },
]);
const qwenCard = card(qwen, [
  { direction: "input", unit: "image", price: 0.02, conditions: {} },
  { direction: "output", unit: "image", price: 0.25, conditions: { resolutionClass: "1k" } },
  { direction: "output", unit: "image", price: 0.5, conditions: { resolutionClass: "2k" } },
]);

const ark = (model: string, data: unknown[]) =>
  ArkImageGenerationResponseSchema.parse({ model, created: 1, data });

describe("native image pricing", () => {
  it("prices Flash per delivered image, including the base and extracted layers", () => {
    expect(
      priceArkImage(
        flashCard,
        { layer_decomposition: true, image: source },
        ark(flash, [{ ...base, z_index: 0 }, layer]),
      ),
    ).toMatchObject({ amount: 0.24, currency: "CNY", cost_usd: 0.03 });
  });

  it("uses actual Pro output pixels and the free first input", () => {
    const price = priceArkImage(
      proCard,
      { prompt: "edit", image: [source, source] },
      ark(pro, [{ ...base, size: "2610x1000" }]),
    );
    expect(price?.amount).toBeCloseTo(0.32);
    expect(price?.cost_usd).toBeCloseTo(0.04);
  });

  it("uses independent pixel bands for each successful Pro output in layer mode", () => {
    const price = priceArkImage(
      proCard,
      { layer_decomposition: true, image: source },
      ark(pro, [{ ...base, z_index: 0 }, layer]),
    );
    expect(price?.amount).toBeCloseTo(0.45);
    expect(price).toMatchObject({
      currency: "CNY",
      basis: "official_list_price",
      verified_on: "2026-11-20",
    });
  });

  it("prices the successful Qwen quantity using upstream billing type, ignoring requested size and n", () => {
    const body = {
      data: [{ url: source }],
      usage: {
        input_image_count: 1,
        output_image_count: 1,
        output_image_type: "qima_output_2k",
      },
    };
    const price = priceQwenImage(
      qwenCard,
      { prompt: "edit", size: "1024x1024", n: 2, image: source },
      body,
    );
    expect(price?.amount).toBeCloseTo(0.52);
    expect(price?.cost_usd).toBeCloseTo(0.065);
    expect(
      priceQwenImage(
        qwenCard,
        { image: source },
        {
          ...body,
          usage: { ...body.usage, output_image_type: "unknown" },
        },
      ),
    ).toBeNull();
  });

  it("uses actual Qwen output pixels when the tier is omitted and rejects conflicting evidence", () => {
    const data = [{ url: source }];
    const usage = { output_width: 1500, output_height: 1500, output_image_count: 1 };
    expect(priceQwenImage(qwenCard, {}, { data, usage })?.amount).toBe(0.25);
    expect(
      priceQwenImage(qwenCard, {}, { data, usage: { ...usage, output_width: 1501 } })?.amount,
    ).toBe(0.5);
    expect(
      priceQwenImage(
        qwenCard,
        {},
        { data, usage: { ...usage, input_image_count: 0, output_image_type: "qima_output_2k" } },
      ),
    ).toBeNull();
  });

  it("keeps a known native amount when FX is missing and rejects mismatched model cards", () => {
    const cnyOnly = { ...flashCard, billing: undefined };
    expect(priceArkImage(cnyOnly, {}, ark(flash, [base]))).toMatchObject({
      currency: "CNY",
      amount: 0.12,
      cost_usd: null,
    });
    expect(priceArkImage(proCard, {}, ark(flash, [base]))).toBeNull();
  });
});
