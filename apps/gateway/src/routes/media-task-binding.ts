import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ResponsesRegistryRecord } from "@helm/core";
import { z } from "zod";

export const MEDIA_TASK_RETENTION_MS = 7 * 86400000;
const PREFIX = "helm-media-task:v1:";
export const MediaTaskBindingSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["video", "transcription"]),
  publicId: z.uuid(),
  operationId: z.uuid(),
  providerAlias: z.string().min(1),
  providerName: z.string().min(1),
  providerModel: z.string().min(1),
  providerAccount: z.string().min(1),
  laneName: z.string().min(1).nullable(),
  profile: z.enum(["bailian", "minimax"]),
  endpointIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamId: z.string().min(1).max(1024),
  state: z.enum(["queued", "in_progress", "done", "failed", "cancelled", "expired"]),
  queryExpiresAt: z.number().int().nonnegative(),
  artifactExpiresAt: z.number().int().nonnegative().nullable(),
});
export type MediaTaskBinding = z.infer<typeof MediaTaskBindingSchema>;

/** Conservative binding: credential rotation requires explicit task recovery, never an account switch. */
export function mediaEndpointIdentity(
  baseUrl: string,
  accountId: string,
  credential: string,
): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return createHash("sha256")
    .update(
      JSON.stringify([
        url.toString(),
        accountId,
        createHash("sha256").update(credential).digest("hex"),
      ]),
    )
    .digest("hex");
}
export function encodeMediaTaskBinding(binding: MediaTaskBinding): string {
  return (
    PREFIX +
    Buffer.from(JSON.stringify(MediaTaskBindingSchema.parse(binding))).toString("base64url")
  );
}
export function isNativeMediaTaskRecord(record: ResponsesRegistryRecord): boolean {
  return record.status.startsWith(PREFIX);
}
export function decodeMediaTaskBinding(record: ResponsesRegistryRecord): MediaTaskBinding | null {
  if (!isNativeMediaTaskRecord(record) || record.status.length > 16384) return null;
  try {
    const value = MediaTaskBindingSchema.parse(
      JSON.parse(Buffer.from(record.status.slice(PREFIX.length), "base64url").toString()),
    );
    if (
      record.responseId !== `${value.kind}:${value.publicId}` ||
      record.selectedLane !== value.kind ||
      record.providerAlias !== value.providerAlias ||
      record.providerName !== value.providerName ||
      record.providerModel !== value.providerModel ||
      record.providerAccount !== value.providerAccount
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function mediaTaskQueryAllowed(
  binding: MediaTaskBinding,
  endpointIdentity: string,
  nowMs: number,
): boolean {
  return binding.endpointIdentity === endpointIdentity && nowMs < binding.queryExpiresAt;
}
