import { z } from "zod";

// xAI TTS request. Unknown provider options intentionally pass through.
export const TtsSpeechRequestSchema = z.looseObject({
  text: z.string().trim().min(1).max(15_000),
  voice_id: z.string().trim().min(1).max(128).optional(),
  language: z.string().trim().min(1).max(32).optional(),
});

export type TtsSpeechRequest = z.infer<typeof TtsSpeechRequestSchema>;
