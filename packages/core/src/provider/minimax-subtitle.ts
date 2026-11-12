import { MediaSpeechTimestampSchema } from "@helm/shared";
import { z } from "zod";
export const MiniMaxSubtitleSchema = z.object({
  text: z.string(),
  text_begin: z.number().int().nonnegative(),
  text_end: z.number().int().nonnegative(),
  time_begin: z.number().nonnegative(),
  time_end: z.number().nonnegative(),
  timestamped_words: z
    .array(
      z.object({
        word: z.string(),
        time_begin: z.number().nonnegative(),
        time_end: z.number().nonnegative(),
      }),
    )
    .nullish(),
});
export function minimaxTimestamp(value: z.infer<typeof MiniMaxSubtitleSchema>) {
  return MediaSpeechTimestampSchema.parse({
    text: value.text,
    textBegin: value.text_begin,
    textEnd: value.text_end,
    startMs: value.time_begin,
    endMs: value.time_end,
    ...(value.timestamped_words
      ? {
          words: value.timestamped_words.map((word) => ({
            text: word.word,
            startMs: word.time_begin,
            endMs: word.time_end,
          })),
        }
      : {}),
  });
}
