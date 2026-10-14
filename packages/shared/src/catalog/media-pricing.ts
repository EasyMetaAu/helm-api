import { z } from "zod";

// Native media cards describe official list prices, not USD token costs or
// settled invoices. The card replaces as a whole on manual override. Consumers
// must retain all dimensions (including free quantities and conditional fees).
const ConditionsSchema = z
  .strictObject({
    mode: z.enum(["single_image", "layer_decomposition"]).optional(),
    pixelsLte: z.number().int().positive().optional(),
    pixelsGt: z.number().int().nonnegative().optional(),
    resolution: z.enum(["480p", "720p", "1080p"]).optional(),
    hasInputVideo: z.boolean().optional(),
    resolutionClass: z.enum(["1k", "2k"]).optional(),
    outputResolution: z.enum(["480P", "720P", "768P", "1080P", "2K"]).optional(),
  })
  .refine(
    (c) => c.pixelsLte === undefined || c.pixelsGt === undefined || c.pixelsGt < c.pixelsLte,
    {
      message: "Pixel range must be nonempty",
    },
  );

export const MediaPriceRateSchema = z
  .strictObject({
    direction: z.enum([
      "input",
      "output",
      "completion",
      "input_and_output_video",
      "input_video",
      "output_video",
      "input_image",
      "input_audio",
    ]),
    unit: z.enum([
      "image",
      "layer",
      "successful_3d_file",
      "second",
      "million_tokens",
      "ten_thousand_billable_characters",
      "million_billable_characters",
    ]),
    price: z.number().nonnegative(),
    conditions: ConditionsSchema,
    freeQuantity: z.number().int().nonnegative().optional(),
    // Informational only: an undated temporary offer must not silently become
    // the permanent price used for admission, settlement or historical costs.
    promotion: z
      .strictObject({
        multiplier: z.number().positive().max(1),
        effectivePrice: z.number().nonnegative(),
        endDate: z.iso.date().nullable(),
        status: z.string().min(1),
      })
      .optional(),
  })
  .refine(
    (r) =>
      !r.promotion ||
      Math.abs(r.price * r.promotion.multiplier - r.promotion.effectivePrice) < 1e-10,
    {
      message: "Promotion must agree with list price times multiplier",
    },
  );

export const MediaPricingSchema = z.strictObject({
  currency: z.enum(["CNY", "USD"]),
  region: z.string().min(1),
  providerModel: z.string().min(1),
  basis: z.literal("official_list_price"),
  verifiedOn: z.iso.date(),
  source: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Price source must use HTTPS",
    }),
  rates: z.array(MediaPriceRateSchema).min(1),
  conditionalFees: z
    .array(
      z.strictObject({
        kind: z.enum(["rapid_voice_cloning", "voice_design"]),
        pricePerVoice: z.number().nonnegative(),
        charged: z.literal("first_synthesis_use"),
      }),
    )
    .optional(),
  notes: z.array(z.string().min(1)),
});

export type MediaPriceRate = z.infer<typeof MediaPriceRateSchema>;
export type MediaPricing = z.infer<typeof MediaPricingSchema>;
