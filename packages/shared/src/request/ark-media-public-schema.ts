import { z } from "zod";
import { ArkMediaUrlSchema } from "./ark-media-schema.js";

/** Helm-owned task IDs and normalized lifecycle; artifact expiration is Unix milliseconds. */
export const ArkPublicTaskResultSchema = z.strictObject({
  request_id: z.string().min(1),
  status: z.enum(["queued", "in_progress", "done", "failed", "cancelled", "expired"]),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  video: z.strictObject({ url: ArkMediaUrlSchema }).optional(),
  file: z
    .strictObject({
      url: ArkMediaUrlSchema,
      format: z.literal("zip"),
      model_format: z.literal("glb"),
    })
    .optional(),
  artifact_expires_at: z.number().int().nonnegative().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});
export type ArkPublicTaskResult = z.infer<typeof ArkPublicTaskResultSchema>;
