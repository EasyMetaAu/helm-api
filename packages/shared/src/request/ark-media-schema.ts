import { z } from "zod";

// Standalone Ark wire contracts. Public alias resolution and route composition
// belong to the gateway; see docs/ark-media-contract.md for sources and limits.
export const ArkImageModelSchema = z.enum([
  "doubao-seedream-5-0-flash-260915",
  "doubao-seedream-5-0-pro-260628",
]);
export const ArkVideoModelSchema = z.literal("doubao-seedance-2-5-260628");
export const ArkThreeDModelSchema = z.literal("doubao-seed3d-2-0-260328");
const Nonblank = z.string().refine((value) => value.trim().length > 0, "Must not be blank");
const Count = z.number().int().nonnegative();

// URL syntax admission only, never DNS resolution or a remote media download.
// Deliberately restrict v1 to HTTPS DNS names and default port; IP literals,
// local names, credentials, fragments, data URIs and asset IDs are out of scope.
export const ArkMediaUrlSchema = z.string().refine((value) => {
  if (!/^https:\/\//.test(value) || /\s|\\/.test(value)) return false;
  if (value.slice(8).split(/[/?#]/, 1)[0]?.includes("@")) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !value.includes("#") &&
      !url.port &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|home|invalid)$/.test(host)
    );
  } catch {
    return false;
  }
}, "Expected an HTTPS DNS URL without credentials, fragment, local name or custom port");

const PixelSize = z.string().regex(/^[1-9]\d*x[1-9]\d*$/);
const GenerationSize = PixelSize.refine((value) => {
  const [width = 0, height = 0] = value.split("x").map(Number);
  return (
    width * height >= 921600 &&
    width * height <= 4624220 &&
    width / height >= 1 / 16 &&
    width / height <= 16
  );
}, "Size must have 921600–4624220 pixels and an aspect ratio between 1:16 and 16:1");
const ImageFormat = z.enum(["png", "jpeg"]);
const ImageSize = z.union([z.enum(["1K", "1.5K", "2K", "auto"]), GenerationSize]);

export const ArkImageGenerationRequestSchema = z
  .strictObject({
    model: ArkImageModelSchema,
    prompt: Nonblank.optional(),
    image: z.union([ArkMediaUrlSchema, z.array(ArkMediaUrlSchema).min(1).max(10)]).optional(),
    size: ImageSize.optional(),
    layer_decomposition: z.boolean().optional(),
    output_format: ImageFormat.optional(),
    background: z.enum(["opaque", "transparent"]).optional(),
    response_format: z.enum(["url", "b64_json"]).optional(),
    watermark: z.boolean().optional(),
    stream: z.literal(false).optional(),
    optimize_prompt_options: z.strictObject({ mode: z.enum(["standard", "fast"]) }).optional(),
  })
  .superRefine((body, ctx) => {
    const images =
      body.image === undefined ? [] : typeof body.image === "string" ? [body.image] : body.image;
    if (body.layer_decomposition) {
      if (images.length !== 1)
        ctx.addIssue({
          code: "custom",
          path: ["image"],
          message: "Layer decomposition requires exactly one image",
        });
      if (body.size?.includes("x"))
        ctx.addIssue({
          code: "custom",
          path: ["size"],
          message: "Layer decomposition accepts resolution tiers or auto only",
        });
    } else {
      if (body.prompt === undefined)
        ctx.addIssue({ code: "custom", path: ["prompt"], message: "Generation requires a prompt" });
      if (body.size === "auto")
        ctx.addIssue({
          code: "custom",
          path: ["size"],
          message: "auto is only supported for layer decomposition",
        });
    }
    if (
      body.background === "transparent" &&
      (images.length !== 1 || body.output_format === "jpeg")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["background"],
        message: "Transparent output requires one alpha image and PNG output (explicit or default)",
      });
    }
    if (
      body.model === "doubao-seedream-5-0-flash-260915" &&
      body.optimize_prompt_options?.mode === "fast"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["optimize_prompt_options", "mode"],
        message: "Flash does not support fast prompt optimization",
      });
    }
  });

const VideoText = z.strictObject({
  type: z.literal("text"),
  // Ark also interprets command flags in prompts. Reject that second parameter
  // channel so it cannot bypass the structured field allowlist or numeric limits.
  text: Nonblank.refine(
    (value) => !/(?:^|\s)--[a-zA-Z]/.test(value),
    "Use structured parameters; inline command flags are unsupported",
  ),
});
const Source = z.strictObject({ url: ArkMediaUrlSchema });
const VideoImage = z.strictObject({
  type: z.literal("image_url"),
  image_url: Source,
  role: z.enum(["first_frame", "last_frame", "reference_image"]),
});
const VideoSource = z.strictObject({
  type: z.literal("video_url"),
  video_url: Source,
  role: z.literal("reference_video"),
});
const AudioSource = z.strictObject({
  type: z.literal("audio_url"),
  audio_url: Source,
  role: z.literal("reference_audio"),
});
const VideoRatio = z.enum(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);
const VideoResolution = z.enum(["480p", "720p", "1080p"]);
export const ArkVideoGenerationRequestSchema = z
  .strictObject({
    model: ArkVideoModelSchema,
    content: z
      .array(z.discriminatedUnion("type", [VideoText, VideoImage, VideoSource, AudioSource]))
      .min(1)
      .max(51),
    duration: z.union([z.literal(-1), z.number().int().min(4).max(30)]).optional(),
    ratio: VideoRatio.optional(),
    resolution: VideoResolution.optional(),
    generate_audio: z.boolean().optional(),
    watermark: z.boolean().optional(),
    output_format: z.literal("mp4").optional(),
    omni_reference_task_type: z.literal("reference").optional(),
  })
  .superRefine((body, ctx) => {
    const images = body.content.filter((item) => item.type === "image_url");
    const videos = body.content.filter((item) => item.type === "video_url");
    const audios = body.content.filter((item) => item.type === "audio_url");
    const texts = body.content.filter((item) => item.type === "text");
    const first = images.filter((item) => item.role === "first_frame");
    const last = images.filter((item) => item.role === "last_frame");
    const references =
      images.filter((item) => item.role === "reference_image").length +
      videos.length +
      audios.length;
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["content"], message });
    if (texts.length > 1) issue("At most one text item is supported");
    if (images.length > 30 || videos.length > 10 || audios.length > 10)
      issue("Reference limits are 30 images, 10 videos and 10 audios");
    if (first.length || last.length) {
      if (first.length !== 1 || last.length > 1 || references > 0)
        issue(
          "Pinned frames require one first frame, at most one last frame and no reference media",
        );
      if (body.ratio !== "adaptive")
        ctx.addIssue({
          code: "custom",
          path: ["ratio"],
          message: "Pinned frames require explicit adaptive ratio",
        });
      if (body.omni_reference_task_type !== undefined)
        issue("Task type guidance is only supported for reference media");
    } else if (references > 0) {
      if (body.omni_reference_task_type !== "reference")
        ctx.addIssue({
          code: "custom",
          path: ["omni_reference_task_type"],
          message:
            "Reference media require explicit reference mode; auto/edit/extend are not supported",
        });
    } else if (body.omni_reference_task_type !== undefined) {
      issue("Reference mode requires at least one reference asset");
    }
  });

const Subdivision = z.enum(["low", "medium", "high"]);
export const ArkThreeDGenerationRequestSchema = z.strictObject({
  model: ArkThreeDModelSchema,
  content: z.array(z.strictObject({ type: z.literal("image_url"), image_url: Source })).length(1),
  file_format: z.literal("glb").optional(),
  subdivision_level: Subdivision.optional(),
});

export const ArkMediaErrorSchema = z.strictObject({ code: Nonblank, message: Nonblank });
const Rectangle = z
  .tuple([Count, Count, Count, Count])
  .refine(
    ([left, top, right, bottom]) => right > left && bottom > top,
    "Rectangle must have positive width and height",
  );
const NormalizedRectangle = z
  .tuple([Count.max(1000), Count.max(1000), Count.max(1000), Count.max(1000)])
  .refine(
    ([left, top, right, bottom]) => right >= left && bottom >= top,
    "Normalized bounds must be ordered",
  );
const ImageResult = z
  .strictObject({
    url: ArkMediaUrlSchema.optional(),
    b64_json: z
      .string()
      .min(1)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    size: PixelSize,
    output_format: ImageFormat,
    z_index: Count.max(16).optional(),
    bounding_box: z
      .strictObject({ absolute: Rectangle, normalized: NormalizedRectangle })
      .optional(),
    name: Nonblank.optional(),
    description: Nonblank.optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.url === undefined) === (item.b64_json === undefined))
      ctx.addIssue({ code: "custom", message: "Exactly one image delivery field is required" });
    if (item.z_index !== undefined && item.z_index > 0) {
      if (!item.bounding_box || !item.name || !item.description || item.output_format !== "png")
        ctx.addIssue({
          code: "custom",
          message: "Layers require PNG, bounding_box, name and description",
        });
    } else if (item.bounding_box || item.name || item.description) {
      ctx.addIssue({ code: "custom", message: "Layer metadata requires a positive z_index" });
    }
  });
export const ArkImageGenerationResponseSchema = z
  .strictObject({
    model: ArkImageModelSchema,
    created: Count,
    data: z.array(ImageResult).min(1).max(17),
    usage: z
      .strictObject({
        input_images: Count.optional(),
        generated_images: Count,
        output_tokens: Count,
        total_tokens: Count,
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const layered = body.data.some((item) => item.z_index !== undefined);
    if (
      layered ? body.data.some((item, index) => item.z_index !== index) : body.data.length !== 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: "Expected one image, or ordered layers beginning at base z_index 0",
      });
    }
  });

export const ArkTaskCreateResponseSchema = z.strictObject({ id: Nonblank });
// Current API docs include expired; the Python 0.12.0 enum does not.
export const ArkTaskStatusSchema = z.enum([
  "queued",
  "running",
  "cancelled",
  "succeeded",
  "failed",
  "expired",
]);
const TaskBase = {
  id: Nonblank,
  status: ArkTaskStatusSchema,
  created_at: Count.optional(),
  updated_at: Count.optional(),
  error: ArkMediaErrorSchema.nullable().optional(),
  usage: z.strictObject({ completion_tokens: Count, total_tokens: Count }).optional(),
};
function checkTask(
  body: { status: string; error?: unknown; content?: unknown },
  ctx: z.RefinementCtx,
) {
  if (body.status === "succeeded" && (!body.content || body.error))
    ctx.addIssue({ code: "custom", message: "Successful task requires an artifact and no error" });
  if (body.status === "failed" && !body.error)
    ctx.addIssue({
      code: "custom",
      path: ["error"],
      message: "Failed task requires structured error",
    });
  if (body.status !== "succeeded" && body.content)
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "Only a successful task may expose a result",
    });
}
export const ArkVideoRetrieveResponseSchema = z
  .strictObject({
    ...TaskBase,
    usage: z
      .strictObject({
        completion_tokens: Count,
        total_tokens: Count,
        tool_usage: z.strictObject({ web_search: Count }).optional(),
      })
      .optional(),
    model: ArkVideoModelSchema,
    content: z
      .strictObject({ video_url: ArkMediaUrlSchema, last_frame_url: ArkMediaUrlSchema.optional() })
      .optional(),
    resolution: VideoResolution.optional(),
    ratio: VideoRatio.optional(),
    duration: Count.optional(),
    frames: Count.optional(),
    framespersecond: z.number().positive().optional(),
    seed: z.number().int().optional(),
    generate_audio: z.boolean().optional(),
    output_format: z.enum(["mp4", "mov"]).optional(),
    draft: z.boolean().optional(),
    service_tier: z.enum(["default", "flex"]).optional(),
    priority: Count.max(9).optional(),
    safety_identifier: z.string().optional(),
    tools: z.array(z.strictObject({ type: z.literal("web_search") })).optional(),
    execution_expires_after: Count.optional(),
  })
  .superRefine(checkTask);
export const ArkThreeDRetrieveResponseSchema = z
  .strictObject({
    ...TaskBase,
    model: ArkThreeDModelSchema,
    status: ArkTaskStatusSchema.exclude(["expired"]),
    content: z.strictObject({ file_url: ArkMediaUrlSchema }).optional(),
    fileformat: z.literal("glb").optional(),
    subdivisionlevel: Subdivision.optional(),
  })
  .superRefine(checkTask);

export type ArkImageGenerationRequest = z.infer<typeof ArkImageGenerationRequestSchema>;
export type ArkVideoGenerationRequest = z.infer<typeof ArkVideoGenerationRequestSchema>;
export type ArkThreeDGenerationRequest = z.infer<typeof ArkThreeDGenerationRequestSchema>;
export type ArkImageGenerationResponse = z.infer<typeof ArkImageGenerationResponseSchema>;
export type ArkTaskCreateResponse = z.infer<typeof ArkTaskCreateResponseSchema>;
export type ArkVideoRetrieveResponse = z.infer<typeof ArkVideoRetrieveResponseSchema>;
export type ArkThreeDRetrieveResponse = z.infer<typeof ArkThreeDRetrieveResponseSchema>;
export type ArkTaskStatus = z.infer<typeof ArkTaskStatusSchema>;
