import { z } from "zod";

// Grok's async video surface deliberately has two strict request shapes. Keeping
// this schema closed prevents unsupported paid options (notably ZDR `output`) from
// being silently forwarded before Helm has an end-to-end redaction contract for it.
const VideoSourceSchema = z.strictObject({ url: z.string().min(1) });
const VideoDurationSchema = z.union([z.literal(6), z.literal(10), z.literal(15), z.literal(30)]);
const VideoResolutionSchema = z.enum(["480p", "720p"]);
const VideoAspectRatioSchema = z.enum(["1:1", "16:9", "9:16", "3:2", "2:3"]);
const PromptVideoModelSchema = z.enum(["grok-imagine-video", "xai/grok-imagine-video"]);
const SingleImageVideoModelSchema = z.enum([
  "grok-imagine-video-1.5-preview",
  "xai/grok-imagine-video-1.5-preview",
  "grok-imagine-video-1.5",
  "xai/grok-imagine-video-1.5",
]);
const ReferenceImageVideoModelSchema = z.enum([
  "grok-imagine-video-1.5",
  "xai/grok-imagine-video-1.5",
]);

// Sub2API's proven forwarding contract uses the base Imagine model for a native
// prompt-only create. Keep this separate from 1.5, whose upstream contract still
// requires an input image.
const PromptOnlyVideoRequestSchema = z.strictObject({
  model: PromptVideoModelSchema,
  prompt: z.string().min(1),
  aspect_ratio: VideoAspectRatioSchema.optional(),
  duration: VideoDurationSchema.optional(),
  resolution: z.union([VideoResolutionSchema, z.literal("1080p")]).optional(),
  audio: z.boolean().optional(),
});

const SingleImageVideoRequestSchema = z.strictObject({
  model: SingleImageVideoModelSchema,
  // xAI permits an empty motion prompt for the single-image workflow.
  prompt: z.string(),
  image: VideoSourceSchema,
  duration: VideoDurationSchema,
  resolution: VideoResolutionSchema,
});

const ReferenceImageVideoRequestBase = {
  // Grok Build's reference_to_video tool sends the stable 1.5 wire model.
  // The base model is prompt-only; preview has no verified reference contract.
  model: ReferenceImageVideoModelSchema,
  prompt: z.string().min(1),
  aspect_ratio: VideoAspectRatioSchema,
  duration: VideoDurationSchema,
  resolution: VideoResolutionSchema,
};

const ReferenceImageVideoRequestSchema = z.union([
  z.strictObject({
    ...ReferenceImageVideoRequestBase,
    reference_images: z.array(VideoSourceSchema).min(2).max(7),
  }),
  z.strictObject({
    ...ReferenceImageVideoRequestBase,
    images: z.array(VideoSourceSchema).min(2).max(7),
  }),
]);

export const VideoGenerationRequestSchema = z.union([
  PromptOnlyVideoRequestSchema,
  SingleImageVideoRequestSchema,
  ReferenceImageVideoRequestSchema,
]);

export const VideoExtensionRequestSchema = z.strictObject({
  model: PromptVideoModelSchema,
  prompt: z.string().min(1),
  video: VideoSourceSchema,
  duration: VideoDurationSchema,
});

// The provider body may contain extra task metadata. Helm validates only the
// fields needed for safe ownership/polling while returning the provider shape.
export const VideoGenerationResponseSchema = z.looseObject({
  request_id: z.string().refine((value) => value.trim().length > 0, "request_id must not be blank"),
});

export const VideoRetrieveResponseSchema = z
  .looseObject({
    // Unknown states intentionally stay untouched; only the client knows whether to
    // continue polling, while Helm merely proves the response is a video task body.
    status: z.string().refine((value) => value.trim().length > 0, "status must not be blank"),
  })
  .superRefine((body, ctx) => {
    if (body.status !== "done") return;
    const video = body.video;
    if (
      video === null ||
      typeof video !== "object" ||
      Array.isArray(video) ||
      typeof (video as Record<string, unknown>).url !== "string" ||
      ((video as Record<string, unknown>).url as string).trim().length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "done video response requires a non-blank video.url",
      });
    }
  });

export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;
export type VideoExtensionRequest = z.infer<typeof VideoExtensionRequestSchema>;
export type VideoGenerationResponse = z.infer<typeof VideoGenerationResponseSchema>;
export type VideoRetrieveResponse = z.infer<typeof VideoRetrieveResponseSchema>;
