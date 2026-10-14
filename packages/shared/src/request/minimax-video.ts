import { z } from "zod";
import { BailianImageInputSchema, MediaHttpUrlSchema } from "./bailian-media.js";

const ContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal("image_url"),
      image_url: z.object({ url: BailianImageInputSchema }).strict(),
      role: z.enum(["first_frame", "last_frame", "reference_image"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("video_url"),
      video_url: z.object({ url: MediaHttpUrlSchema }).strict(),
      role: z.literal("reference_video"),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio_url"),
      audio_url: z.object({ url: MediaHttpUrlSchema }).strict(),
      role: z.literal("reference_audio"),
    })
    .strict(),
]);
export const MiniMaxVideoRequestSchema = z
  .object({
    model: z.enum(["MiniMax-H3", "MiniMax-H3-Max"]),
    content: z.array(ContentSchema).min(1).max(17),
    resolution: z.enum(["480P", "768P", "2K"]),
    duration: z.number().int().min(4).max(15),
    ratio: z.enum(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    extra: z
      .object({ prompt_expansion_mode: z.enum(["disabled", "balanced", "quality"]).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (body.model === "MiniMax-H3-Max" && (body.resolution === "2K" || body.duration < 5))
      issue("H3-Max supports 480P/768P and 5–15 seconds");
    if (body.model === "MiniMax-H3" && (body.resolution === "480P" || body.extra !== undefined))
      issue("H3 supports 768P/2K and no extra prompt expansion options");
    const texts = body.content.filter((c) => c.type === "text");
    if (texts.length !== 1) issue("Exactly one non-empty text item is required");
    const media = body.content.filter((c) => c.type !== "text");
    const roles = media.map((c) => c.role ?? "first_frame");
    const frames = roles.filter((r) => r === "first_frame" || r === "last_frame");
    if (frames.length > 0 && frames.length !== roles.length)
      issue("Frame inputs cannot be mixed with references");
    if (media.length === 0 && (!body.ratio || body.ratio === "adaptive"))
      issue("Text-to-video requires a concrete ratio");
    if (frames.length > 0 && body.ratio && body.ratio !== "adaptive")
      issue("Image-to-video supports adaptive ratio only");
    for (const [role, max] of [
      ["first_frame", 1],
      ["last_frame", 1],
      ["reference_image", 9],
      ["reference_video", 3],
      ["reference_audio", 3],
    ] as const)
      if (roles.filter((r) => r === role).length > max) issue(`Too many ${role} inputs`);
  });
export type MiniMaxVideoRequest = z.infer<typeof MiniMaxVideoRequestSchema>;
export const parseMiniMaxVideoRequest = (value: unknown) => MiniMaxVideoRequestSchema.parse(value);
export const MiniMaxVideoCreateResponseSchema = z
  .object({ task_id: z.string().min(1) })
  .passthrough();
export const MiniMaxVideoTaskResponseSchema = z
  .object({
    task: z
      .object({
        id: z.string().min(1),
        model: z.string().optional(),
        status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
        content: z.object({ url: MediaHttpUrlSchema.optional() }).passthrough().optional(),
        error: z
          .object({ code: z.string(), message: z.string().optional() })
          .passthrough()
          .optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if (body.task.status === "succeeded" && !body.task.content?.url)
      ctx.addIssue({
        code: "custom",
        path: ["task", "content"],
        message: "Successful video task must contain a URL",
      });
  });
