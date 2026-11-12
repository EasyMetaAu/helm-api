import { z } from "zod";
export const AudioTranscriptionRequestSchema = z.strictObject({
  model: z.string().trim().min(1).max(256),
  languages: z.array(z.string().min(2).max(20)).max(16).optional(),
  keywords: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[^<>\r\n]+$/),
    )
    .max(100)
    .optional(),
  prompt: z.string().max(10000).optional(),
  timestamps: z.enum(["word", "sentence"]).optional(),
  diarize: z.boolean().optional(),
  response_format: z.literal("json").optional(),
});
export type AudioTranscriptionRequest = z.infer<typeof AudioTranscriptionRequestSchema>;
export const AudioWordSchema = z
  .object({
    text: z.string(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    speaker: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((word) => word.endMs >= word.startMs, "timestamp end precedes start");
export const AudioTranscriptionResultSchema = z.object({
  text: z.string(),
  languages: z.array(z.object({ code: z.string() })).optional(),
  requestId: z.string().optional(),
  words: z.array(AudioWordSchema).optional(),
  segments: z
    .array(AudioWordSchema.safeExtend({ words: z.array(AudioWordSchema).optional() }))
    .optional(),
  usage: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("duration"),
        seconds: z.number().nonnegative(),
        channels: z.number().int().positive().optional(),
      }),
      z.object({
        type: z.literal("tokens"),
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        total_tokens: z.number().nonnegative(),
        input_token_details: z
          .object({
            audio_tokens: z.number().nonnegative().optional(),
            text_tokens: z.number().nonnegative().optional(),
          })
          .optional(),
      }),
    ])
    .optional(),
});
export type AudioTranscriptionResult = z.infer<typeof AudioTranscriptionResultSchema>;
