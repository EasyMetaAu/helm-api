import { z } from "zod";

export const RealtimeSessionSchema = z.looseObject({
  model: z.string().min(1),
});

export type RealtimeSession = z.infer<typeof RealtimeSessionSchema>;
