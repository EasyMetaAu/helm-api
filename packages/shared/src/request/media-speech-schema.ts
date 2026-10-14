import { z } from "zod";

export const MediaSpeechFormatSchema = z.enum(["mp3", "wav", "pcm", "flac", "opus"]);
export const MediaSpeechRequestSchema = z.strictObject({
  model: z.string().trim().min(1).max(256),
  input: z.string().min(1).max(10_000),
  voice: z.string().trim().min(1).max(256),
  response_format: MediaSpeechFormatSchema.default("mp3"),
  speed: z.number().min(0.5).max(2).default(1),
  sample_rate: z.number().int().positive().max(48000).default(32000),
  stream: z.boolean().default(false),
});
export type MediaSpeechRequest = z.infer<typeof MediaSpeechRequestSchema>;
export const MediaSpeechUsageSchema = z.object({
  usage_characters: z.number().nonnegative().optional(),
  usage_voice_count: z.number().nonnegative().optional(),
});
export type MediaSpeechUsage = z.infer<typeof MediaSpeechUsageSchema>;
export const MediaSpeechCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    request: MediaSpeechRequestSchema.omit({ input: true, stream: true }),
  }),
  z.strictObject({ type: z.literal("append"), text: z.string().min(1).max(10_000) }),
  z.strictObject({ type: z.literal("flush") }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("finish") }),
]);
