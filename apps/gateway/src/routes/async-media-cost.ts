import type { ResponsesRegistryRecord } from "@helm/core";
import { type DecisionRecord, type MediaPricing, MediaPricingSchema } from "@helm/shared";
import { z } from "zod";
import type { VideoCreateTarget, VideosRouteDeps } from "./videos.js";

const TaskPricing = MediaPricingSchema.omit({ notes: true });
const requestId = z.string().min(1).max(128);
export const AsyncMediaBillingSchema = z.discriminatedUnion("profile", [
  z.strictObject({
    profile: z.literal("seedance"),
    requestId,
    hasInputVideo: z.boolean(),
    pricing: TaskPricing,
  }),
  z.strictObject({
    profile: z.literal("wan"),
    requestId,
    hasInputVideo: z.boolean().nullable(),
    pricing: TaskPricing,
  }),
  z.strictObject({
    profile: z.enum(["minimax", "fun-asr"]),
    requestId,
    pricing: TaskPricing,
  }),
]);
export type AsyncMediaBilling = z.infer<typeof AsyncMediaBillingSchema>;

export function captureAsyncMediaBilling(
  kind: "video" | "transcription" | "three-d",
  target: VideoCreateTarget,
  body: Record<string, unknown>,
  requestId: string,
  card: MediaPricing | undefined,
): AsyncMediaBilling | undefined {
  if (!card || card.providerModel !== target.providerModel || card.conditionalFees?.length)
    return undefined;
  const { notes: _, ...pricing } = card;
  const base = { requestId, pricing };
  let binding: unknown;
  if (kind === "video") {
    if (target.providerType === "ark" && target.providerModel === "doubao-seedance-2-5-260628") {
      const content = z.array(z.object({ type: z.string() })).safeParse(body.content);
      if (content.success)
        binding = {
          ...base,
          profile: "seedance",
          hasInputVideo: content.data.some((item) => item.type === "video_url"),
        };
    } else if (
      target.nativeTask?.profile === "bailian" &&
      ["wan3.0-video", "wan3.0-video-prime"].includes(target.providerModel)
    ) {
      const input = z
        .object({ media: z.array(z.object({ type: z.string() })).optional() })
        .safeParse(body.input);
      if (input.success) {
        const media = input.data.media ?? [];
        // Generic file/link inputs require a provider-reported input duration.
        const hasInputVideo = media.some(({ type }) => type === "reference_video")
          ? true
          : media.some(({ type }) => type === "file" || type === "link")
            ? null
            : false;
        binding = { ...base, profile: "wan", hasInputVideo };
      }
    } else if (
      target.nativeTask?.profile === "minimax" &&
      ["MiniMax-H3", "MiniMax-H3-Max"].includes(target.providerModel)
    ) {
      binding = { ...base, profile: "minimax" };
    }
  } else if (
    kind === "transcription" &&
    target.nativeTask?.profile === "bailian" &&
    target.providerModel === "fun-asr"
  ) {
    binding = { ...base, profile: "fun-asr" };
  }
  return AsyncMediaBillingSchema.safeParse(binding).data;
}

const seconds = z.number().nonnegative();
const count = z.number().int().nonnegative();
const wanUsage = z.object({
  SR: z.union([
    z.literal(480),
    z.literal(720),
    z.literal(1080),
    z.string().regex(/^(480|720|1080)p?$/i),
  ]),
  input_video_duration: seconds.optional(),
  output_video_duration: seconds.positive(),
});
const miniMaxTask = z.object({
  resolution: z.string(),
  usage: z.object({
    input_seconds: seconds,
    output_seconds: seconds.positive(),
    input_image_count: count,
  }),
});

type Rate = MediaPricing["rates"][number];

function matchingRate(
  rates: Rate[],
  direction: Rate["direction"],
  unit: Rate["unit"],
  conditions: Record<string, unknown>,
): Rate | undefined {
  const matches = rates.filter(
    (rate) =>
      rate.direction === direction &&
      rate.unit === unit &&
      Object.keys(rate.conditions).length === Object.keys(conditions).length &&
      Object.entries(rate.conditions).every(([key, value]) => conditions[key] === value),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function amountFor(rate: Rate, quantity: number): number {
  return Math.max(0, quantity - (rate.freeQuantity ?? 0)) * rate.price;
}

export function priceAsyncMediaResult(
  billing: AsyncMediaBilling,
  raw: Record<string, unknown>,
): { cost: NonNullable<DecisionRecord["media_cost"]>; completionTokens?: number } | null {
  const { pricing } = billing;
  let amount: number;
  let completionTokens: number | undefined;
  switch (billing.profile) {
    case "seedance": {
      const data = z
        .object({
          resolution: z.string(),
          usage: z.object({ completion_tokens: count.positive() }),
        })
        .safeParse(raw);
      if (!data.success) return null;
      const rate = matchingRate(pricing.rates, "completion", "million_tokens", {
        resolution: data.data.resolution,
        hasInputVideo: billing.hasInputVideo,
      });
      if (!rate) return null;
      completionTokens = data.data.usage.completion_tokens;
      amount = amountFor(rate, completionTokens / 1_000_000);
      break;
    }
    case "wan": {
      const parsed = wanUsage.safeParse(raw.usage);
      if (!parsed.success) return null;
      const { SR, input_video_duration, output_video_duration } = parsed.data;
      const inputSeconds = input_video_duration ?? (billing.hasInputVideo === false ? 0 : null);
      if (inputSeconds === null || (billing.hasInputVideo && inputSeconds === 0)) return null;
      const rate = matchingRate(pricing.rates, "input_and_output_video", "second", {
        outputResolution: `${String(SR).replace(/p$/i, "")}P`,
      });
      if (!rate) return null;
      amount = amountFor(rate, inputSeconds + output_video_duration);
      break;
    }
    case "minimax": {
      const parsed = miniMaxTask.safeParse(raw.task);
      if (!parsed.success) return null;
      const { resolution, usage } = parsed.data;
      const conditions = { outputResolution: resolution.toUpperCase() };
      const input = matchingRate(pricing.rates, "input_video", "second", conditions);
      const output = matchingRate(pricing.rates, "output_video", "second", conditions);
      const images = matchingRate(pricing.rates, "input_image", "image", {});
      const audio = matchingRate(pricing.rates, "input_audio", "second", {});
      if (!input || !output || !images || (audio && audio.price !== 0)) return null;
      amount =
        amountFor(input, usage.input_seconds) +
        amountFor(output, usage.output_seconds) +
        amountFor(images, usage.input_image_count);
      break;
    }
    case "fun-asr": {
      const parsed = z.object({ duration: seconds }).safeParse(raw.usage);
      const rate = matchingRate(pricing.rates, "input_audio", "second", {});
      if (!parsed.success || !rate) return null;
      const rounding = pricing.billing?.roundingSeconds;
      const duration = parsed.data.duration;
      amount = amountFor(rate, rounding ? Math.ceil(duration / rounding) * rounding : duration);
      break;
    }
  }
  const fx = pricing.currency === "USD" ? 1 : pricing.billing?.usdPerCurrencyUnit;
  const usd = fx === undefined ? null : amount * fx;
  if (!Number.isFinite(amount) || (usd !== null && !Number.isFinite(usd))) return null;
  return {
    cost: {
      currency: pricing.currency,
      amount,
      cost_usd: usd,
      basis: pricing.basis,
      verified_on: pricing.verifiedOn,
    },
    ...(completionTokens === undefined ? {} : { completionTokens }),
  };
}

export async function applyAsyncMediaCost(
  deps: VideosRouteDeps,
  record: ResponsesRegistryRecord,
  kind: "video" | "transcription",
  billing: AsyncMediaBilling,
  raw: Record<string, unknown>,
  observedAt: number,
): Promise<void> {
  const telemetry = deps.record?.telemetry;
  if (
    !telemetry?.applyAsyncMediaCost ||
    !record.providerAlias ||
    !record.providerName ||
    record.providerModel !== billing.pricing.providerModel ||
    record.selectedLane !== kind ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(observedAt) ||
    record.createdAt > observedAt ||
    observedAt >= record.expiresAt
  )
    return;
  const priced = priceAsyncMediaResult(billing, raw);
  if (!priced) return;
  try {
    await telemetry.applyAsyncMediaCost({
      requestId: billing.requestId,
      keyId: record.keyId,
      kind,
      providerAlias: record.providerAlias,
      providerName: record.providerName,
      providerModel: record.providerModel,
      providerAccount: record.providerAccount ?? null,
      taskCreatedAt: record.createdAt,
      observedAt,
      ...priced,
    });
  } catch {
    deps.log?.("media.task_cost_update_failed", { request_id: billing.requestId });
  }
}
