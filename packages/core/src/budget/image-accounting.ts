import {
  type ArkImageGenerationResponse,
  BailianImageResponseSchema,
  type DecisionRecord,
  type MediaPriceRate,
  type MediaPricing,
} from "@helm/shared";

export type NativeImageCost = NonNullable<DecisionRecord["media_cost"]>;

function imageRate(
  card: MediaPricing,
  direction: MediaPriceRate["direction"],
  unit: MediaPriceRate["unit"],
  matches: (conditions: MediaPriceRate["conditions"]) => boolean,
): MediaPriceRate | undefined {
  const rates = card.rates.filter(
    (rate) => rate.direction === direction && rate.unit === unit && matches(rate.conditions),
  );
  return rates.length === 1 ? rates[0] : undefined;
}

const unconditional = (conditions: MediaPriceRate["conditions"]) =>
  Object.keys(conditions).length === 0;

function qwenImageCost(card: MediaPricing, inputImages: number, response: unknown): number | null {
  const parsed = BailianImageResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  const usage = parsed.data.usage;
  const outputImages = parsed.data.data.length;
  const width = usage?.output_width;
  const height = usage?.output_height;
  const pixelTier =
    typeof width === "number" &&
    Number.isSafeInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isSafeInteger(height) &&
    height > 0
      ? width * height <= 2_250_000
        ? "1k"
        : "2k"
      : null;
  const reportedType = usage?.output_image_type;
  const resolutionClass =
    reportedType === undefined
      ? pixelTier
      : reportedType === "qima_output_1k"
        ? "1k"
        : reportedType === "qima_output_2k"
          ? "2k"
          : null;
  if (
    !resolutionClass ||
    (pixelTier !== null && pixelTier !== resolutionClass) ||
    (usage?.input_image_count !== undefined && usage.input_image_count !== inputImages) ||
    (usage?.output_image_count !== undefined && usage.output_image_count !== outputImages)
  )
    return null;

  const inputRate = imageRate(card, "input", "image", unconditional);
  const outputRate = imageRate(
    card,
    "output",
    "image",
    (conditions) =>
      Object.keys(conditions).length === 1 && conditions.resolutionClass === resolutionClass,
  );
  if (!inputRate || !outputRate || outputRate.freeQuantity) return null;
  return (
    Math.max(0, inputImages - (inputRate.freeQuantity ?? 0)) * inputRate.price +
    outputImages * outputRate.price
  );
}

function seedreamImageCost(
  card: MediaPricing,
  inputImages: number,
  layered: boolean,
  response: ArkImageGenerationResponse,
): number | null {
  const { data, usage } = response;
  if (
    data.some((item) => (item.z_index !== undefined) !== layered) ||
    (usage?.input_images !== undefined && usage.input_images !== inputImages) ||
    (usage?.generated_images !== undefined && usage.generated_images !== data.length)
  )
    return null;

  const inputRate = imageRate(card, "input", "image", unconditional);
  if (!inputRate) return null;
  const inputCost = Math.max(0, inputImages - (inputRate.freeQuantity ?? 0)) * inputRate.price;

  if (card.providerModel === "doubao-seedream-5-0-flash-260915") {
    const rate = imageRate(card, "output", "image", unconditional);
    return rate && !rate.freeQuantity ? inputCost + data.length * rate.price : null;
  }

  const mode = layered ? "layer_decomposition" : "single_image";
  const unit = layered ? "layer" : "image";
  let cost = inputCost;
  // The provider charges per successful output image in the requested scene,
  // including the base (z_index 0) in a decomposition result.
  for (const item of data) {
    const [width = 0, height = 0] = item.size.split("x").map(Number);
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels)) return null;
    const rate = imageRate(card, "output", unit, (conditions) => {
      const { mode: rateMode, pixelsGt, pixelsLte, ...other } = conditions;
      return (
        rateMode === mode &&
        Object.keys(other).length === 0 &&
        (pixelsGt === undefined || pixels > pixelsGt) &&
        (pixelsLte === undefined || pixels <= pixelsLte)
      );
    });
    if (!rate || rate.freeQuantity) return null;
    cost += rate.price;
  }
  return cost;
}

function imageInputCount(request: Record<string, unknown>): number | null {
  const image = request.image;
  if (image !== undefined && typeof image !== "string" && !Array.isArray(image)) return null;
  return typeof image === "string" ? 1 : (image?.length ?? 0);
}

function imageCostInCurrencies(card: MediaPricing, amount: number | null): NativeImageCost | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  const fx = card.currency === "USD" ? 1 : card.billing?.usdPerCurrencyUnit;
  const usd = fx === undefined ? null : amount * fx;
  return {
    currency: card.currency,
    amount,
    cost_usd: usd !== null && Number.isFinite(usd) ? usd : null,
    basis: card.basis,
    verified_on: card.verifiedOn,
  };
}

export function priceArkImage(
  card: MediaPricing | undefined,
  request: Record<string, unknown>,
  response: ArkImageGenerationResponse,
): NativeImageCost | null {
  if (card?.providerModel !== response.model) return null;
  const inputImages = imageInputCount(request);
  return inputImages === null
    ? null
    : imageCostInCurrencies(
        card,
        seedreamImageCost(card, inputImages, request.layer_decomposition === true, response),
      );
}

export function priceQwenImage(
  card: MediaPricing | undefined,
  request: Record<string, unknown>,
  response: unknown,
): NativeImageCost | null {
  if (card?.providerModel !== "qwen-image-3.0-pro") return null;
  const inputImages = imageInputCount(request);
  return inputImages === null
    ? null
    : imageCostInCurrencies(card, qwenImageCost(card, inputImages, response));
}
