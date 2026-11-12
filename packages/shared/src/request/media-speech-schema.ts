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
  output: z.enum(["audio", "json"]).optional(),
  timestamps: z.enum(["sentence", "word"]).optional(),
});
export type MediaSpeechRequest = z.infer<typeof MediaSpeechRequestSchema>;
export const MediaSpeechUsageSchema = z.object({
  text_words: z.number().nonnegative().optional(),
  audio_length: z.number().nonnegative().optional(),
  usage_characters: z.number().nonnegative().optional(),
  usage_voice_count: z.number().nonnegative().optional(),
});
export type MediaSpeechUsage = z.infer<typeof MediaSpeechUsageSchema>;
export const MediaSpeechCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    request: MediaSpeechRequestSchema.omit({ input: true, stream: true }).extend({
      sample_rate: MediaSpeechRequestSchema.shape.sample_rate.removeDefault().optional(),
      max_input_characters: z.number().int().positive().max(10000).optional(),
    }),
  }),
  z.strictObject({ type: z.literal("append"), text: z.string().min(1).max(10_000) }),
  z.strictObject({ type: z.literal("flush") }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("finish") }),
]);

const TimedTextSchema = z
  .object({
    text: z.string(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
  })
  .refine((value) => value.endMs >= value.startMs, "timestamp end precedes start");
export const MediaSpeechTimestampSchema = TimedTextSchema.safeExtend({
  textBegin: z.number().int().nonnegative().optional(),
  textEnd: z.number().int().nonnegative().optional(),
  words: z.array(TimedTextSchema).optional(),
});
export type MediaSpeechTimestamp = z.infer<typeof MediaSpeechTimestampSchema>;
