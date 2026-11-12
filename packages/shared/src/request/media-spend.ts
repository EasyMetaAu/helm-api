import { z } from "zod";
export const MediaSpendRecordSchema = z.object({
  id: z.string().min(1).max(128),
  keyId: z.string().min(1),
  alias: z.string().min(1),
  providerModel: z.string().min(1),
  state: z.enum(["reserved", "outcome_unknown", "settled"]),
  reservedUsd: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  capacity: z.number().positive().nullable(),
  windowMs: z.number().positive(),
  admittedAtMs: z.number().nonnegative(),
  anchorMs: z.number().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
});
export type MediaSpendRecord = z.infer<typeof MediaSpendRecordSchema>;
