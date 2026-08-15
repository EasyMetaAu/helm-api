import { z } from "zod";

// Grok's async video surface deliberately has two strict request shapes. Keeping
// this schema closed prevents unsupported paid options (notably ZDR `output`) from
// being silently forwarded before Helm has an end-to-end redaction contract for it.
const VideoSourceSchema = z.strictObject({ url: z.string().min(1) });
const VideoDurationSchema = z.union([z.literal(6), z.literal(10)]);
const CurrentVideoModelSchema = z.literal("grok-imagine-video-1.5");
const VideoResolutionSchema = z.enum(["480p", "720p"]);

const SingleImageVideoRequestSchema = z.strictObject({
  model: z.union([z.literal("grok-imagine-video-1.5-preview"), CurrentVideoModelSchema]),
  // xAI permits an empty motion prompt for the single-image workflow.
  prompt: z.string(),
  image: VideoSourceSchema,
  duration: VideoDurationSchema,
  resolution: VideoResolutionSchema,
});

const ReferenceImageVideoRequestSchema = z.strictObject({
  model: z.literal("grok-imagine-video"),
  prompt: z.string().min(1),
  reference_images: z.array(VideoSourceSchema).min(2).max(7),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "3:2", "2:3"]),
  duration: VideoDurationSchema,
  resolution: VideoResolutionSchema,
});

const CurrentReferenceVideoRequestSchema = z
  .strictObject({
    model: CurrentVideoModelSchema,
    prompt: z.string().min(1),
    reference_images: z.array(VideoSourceSchema).max(7).optional(),
    reference_audios: z
      .array(
        z.strictObject({
          voice_id: z
            .string()
            .refine((value) => value.trim().length > 0, "voice_id must not be blank"),
        }),
      )
      .max(3)
      .optional(),
    aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]),
    duration: z.number().int().min(1).max(15),
    resolution: VideoResolutionSchema,
  })
  .refine(
    (value) =>
      (value.reference_images?.length ?? 0) > 0 || (value.reference_audios?.length ?? 0) > 0,
    "at least one reference image or audio is required",
  );

export const VideoGenerationRequestSchema = z.union([
  SingleImageVideoRequestSchema,
  ReferenceImageVideoRequestSchema,
  CurrentReferenceVideoRequestSchema,
]);

// The provider body may contain extra task metadata. Helm validates only the
// fields needed for safe ownership/polling while returning the provider shape.
export const VideoGenerationResponseSchema = z.looseObject({
  request_id: z.string().refine((value) => value.trim().length > 0, "request_id must not be blank"),
});

export const VideoRetrieveResponseSchema = z.looseObject({
  // Unknown states intentionally stay untouched; only the client knows whether to
  // continue polling, while Helm merely proves the response is a video task body.
  status: z.string(),
});

export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;
export type VideoGenerationResponse = z.infer<typeof VideoGenerationResponseSchema>;
export type VideoRetrieveResponse = z.infer<typeof VideoRetrieveResponseSchema>;
