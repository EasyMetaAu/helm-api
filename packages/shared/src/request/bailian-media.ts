import { z } from "zod";

/** Input URLs are forwarded to the provider, never fetched by this schema. */
export const MediaHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }, "Expected an HTTP(S) URL without credentials");

function dataUrl(kind: "image" | "audio") {
  return z
    .string()
    .max(14_000_000)
    .refine((value) => {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
      if (!match?.[1]?.startsWith(`${kind}/`) || !match[2]) return false;
      const encoded = match[2];
      return (
        encoded.length % 4 === 0 &&
        (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) <=
          10 * 1024 * 1024
      );
    }, `Expected a base64 ${kind} Data URL no larger than 10 MiB`);
}
export const BailianImageInputSchema = z.union([MediaHttpUrlSchema, dataUrl("image")]);
export const BailianAudioInputSchema = z.union([MediaHttpUrlSchema, dataUrl("audio")]);
const RatioSchema = z.enum(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const UsageSchema = z.record(z.string(), z.unknown());

export const BailianImageRequestSchema = z
  .object({
    model: z.enum([
      "qwen-image-3.0-pro",
      "qwen-image-3.0",
      "qwen-image-2.1-pro",
      "qwen-image-2.1-turbo",
    ]),
    prompt: z.string().trim().min(1),
    image: z
      .union([BailianImageInputSchema, z.array(BailianImageInputSchema).min(1).max(10)])
      .optional(),
    n: z.number().int().min(1).max(6).optional(),
    size: z
      .string()
      .refine((value) => {
        if (value === "auto") return true;
        if (!/^\d+x\d+$/.test(value)) return false;
        const [width = 0, height = 0] = value.split("x").map(Number);
        const area = width * height;
        return (
          area >= 512 * 512 && area <= 2048 * 2048 && width / height >= 1 / 8 && width / height <= 8
        );
      }, "Image size must have 512²–2048² pixels and aspect ratio 1:8–8:1")
      .optional(),
    response_format: z.literal("url").optional(),
    negative_prompt: z.string().optional(),
    seed: z.number().int().min(0).max(2147483647).optional(),
    prompt_extend: z.boolean().optional(),
    prompt_extend_mode: z.enum(["direct", "agent"]).optional(),
    enable_thinking: z.boolean().optional(),
    watermark: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.model.startsWith("qwen-image-3.0") &&
      Array.isArray(body.image) &&
      body.image.length > 3
    )
      ctx.addIssue({
        code: "custom",
        path: ["image"],
        message: "Qwen Image 3.0 supports at most 3 references",
      });
    if (body.model.startsWith("qwen-image-2.1") && body.negative_prompt !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["negative_prompt"],
        message: "negative_prompt requires Qwen Image 3.0",
      });
    if (body.image !== undefined && body.prompt_extend_mode === "agent")
      ctx.addIssue({
        code: "custom",
        path: ["prompt_extend_mode"],
        message: "Agent prompt expansion is text-to-image only",
      });
  });
export type BailianImageRequest = z.infer<typeof BailianImageRequestSchema>;
export const parseBailianImageRequest = (value: unknown) => BailianImageRequestSchema.parse(value);
export const BailianImageResponseSchema = z
  .object({
    data: z.array(z.object({ url: MediaHttpUrlSchema }).passthrough()).min(1),
    usage: UsageSchema.optional(),
  })
  .passthrough();

const WanMediaSchema = z
  .object({
    type: z.enum([
      "first_frame",
      "last_frame",
      "reference_image",
      "reference_video",
      "reference_audio",
      "file",
      "link",
    ]),
    url: z.union([MediaHttpUrlSchema, dataUrl("image"), dataUrl("audio")]),
  })
  .strict();
export const BailianVideoRequestSchema = z
  .object({
    model: z.enum(["wan3.0-video", "wan3.0-video-prime"]),
    input: z
      .object({
        prompt: z.string().trim().min(1).max(20000).optional(),
        media: z.array(WanMediaSchema).min(1).max(22).optional(),
      })
      .strict(),
    parameters: z
      .object({
        resolution: z.enum(["480P", "720P", "1080P"]).optional(),
        ratio: RatioSchema.optional(),
        duration: z.union([z.literal(-1), z.number().int().min(2).max(30)]).optional(),
        audio: z.boolean().optional(),
        seed: z.number().int().min(-1).max(2147483647).optional(),
        prompt_extend: z.boolean().optional(),
        watermark: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const media = body.input.media ?? [];
    const count = (type: string) => media.filter((m) => m.type === type).length;
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", path: ["input", "media"], message });
    if (!body.input.prompt && media.length === 0) issue("prompt or media is required");
    for (const [type, max] of [
      ["first_frame", 1],
      ["last_frame", 1],
      ["reference_image", 10],
      ["reference_video", 5],
      ["reference_audio", 5],
      ["file", 1],
      ["link", 1],
    ] as const) {
      if (count(type) > max) issue(`Too many ${type} inputs`);
    }
    const frames = count("first_frame") + count("last_frame");
    if (frames > 0 && frames !== media.length) issue("Frame and reference inputs cannot be mixed");
    if (count("file") && count("link")) issue("file and link cannot be mixed");
    if ((count("file") || count("link")) && body.parameters?.prompt_extend === false)
      issue("file/link requires prompt expansion");
    for (const item of media) {
      if (
        item.url.startsWith("data:") &&
        !(item.type.endsWith("frame") || item.type === "reference_image"
          ? item.url.startsWith("data:image/")
          : item.type === "reference_audio" && item.url.startsWith("data:audio/"))
      )
        issue("Data URL media type does not match its role");
    }
  });
export type BailianVideoRequest = z.infer<typeof BailianVideoRequestSchema>;
export const parseBailianVideoRequest = (value: unknown) => BailianVideoRequestSchema.parse(value);

const TranscriptionParametersSchema = z
  .object({
    channel_id: z.array(z.number().int().min(0)).min(1).optional(),
    language_hints: z.array(z.string().min(1)).min(1).optional(),
    enable_itn: z.boolean().optional(),
    diarization_enabled: z.boolean().optional(),
    speaker_count: z.number().int().min(1).optional(),
    disfluency_removal_enabled: z.boolean().optional(),
    timestamp_alignment_enabled: z.boolean().optional(),
  })
  .strict();
export const BailianTranscriptionRequestSchema = z.discriminatedUnion("model", [
  z
    .object({
      model: z.enum([
        "qwen-audio-3.1-asr-flash-filetrans",
        "qwen-audio-3.0-asr-flash-filetrans",
        "fun-asr",
        "paraformer-v2",
        "paraformer-8k-v2",
      ]),
      input: z.object({ file_urls: z.array(MediaHttpUrlSchema).length(1) }).strict(),
      parameters: TranscriptionParametersSchema.optional(),
    })
    .strict(),
  z
    .object({
      model: z.literal("qwen3-asr-flash-filetrans"),
      input: z.object({ file_url: MediaHttpUrlSchema }).strict(),
      parameters: z
        .object({
          channel_id: z.array(z.number().int().min(0)).min(1).optional(),
          language: z.string().min(1).optional(),
          enable_itn: z.boolean().optional(),
          enable_words: z.boolean().optional(),
          enable_punctuation_prediction: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const parseBailianTranscriptionRequest = (value: unknown) =>
  BailianTranscriptionRequestSchema.parse(value);

const TaskStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "UNKNOWN",
]);
const FileResultSchema = z
  .object({
    file_url: MediaHttpUrlSchema.optional(),
    subtask_status: TaskStatusSchema.optional(),
    transcription_url: MediaHttpUrlSchema.optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export const BailianTaskResponseSchema = z
  .object({
    output: z
      .object({
        task_id: z.string().min(1),
        task_status: TaskStatusSchema,
        video_url: MediaHttpUrlSchema.optional(),
        results: z.array(FileResultSchema).optional(),
        result: FileResultSchema.optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
    usage: UsageSchema.optional(),
    request_id: z.string().optional(),
  })
  .passthrough();

export const BailianShortAsrRequestSchema = z
  .object({
    model: z.literal("qwen3-asr-flash"),
    messages: z
      .array(
        z.union([
          z.object({ role: z.literal("system"), content: z.string() }).strict(),
          z
            .object({
              role: z.literal("user"),
              content: z
                .array(
                  z
                    .object({
                      type: z.literal("input_audio"),
                      input_audio: z.object({ data: BailianAudioInputSchema }).strict(),
                    })
                    .strict(),
                )
                .length(1),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(2),
    asr_options: z
      .object({ language: z.string().min(1).optional(), enable_itn: z.boolean().optional() })
      .strict()
      .optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.messages.at(-1)?.role !== "user" ||
      (body.messages.length === 2 && body.messages[0]?.role !== "system")
    )
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Expected optional system context then one user audio message",
      });
    if (!body.stream && body.stream_options !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["stream_options"],
        message: "stream_options requires stream:true",
      });
  });
