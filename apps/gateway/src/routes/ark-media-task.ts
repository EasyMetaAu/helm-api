import { Buffer } from "node:buffer";
import type { ResponsesRegistryRecord } from "@helm/core";
import { z } from "zod";
import {
  ArkTaskCreateResponseSchema,
  ArkThreeDGenerationRequestSchema,
  ArkThreeDRetrieveResponseSchema,
  ArkVideoGenerationRequestSchema,
  ArkVideoRetrieveResponseSchema,
} from "../../../../packages/shared/src/request/ark-media-schema.js";

export type ArkTaskKind = "video" | "three-d";
export const ARK_TASK_TTL_MS = 7 * 86400000;
const ARTIFACT_TTL_MS = 86400000;
const PREFIX = "ark-media-task:v1:";
const BindingSchema = z.strictObject({
  kind: z.enum(["video", "three-d"]),
  publicId: z.uuid(),
  providerAlias: z.string().min(1),
  providerAccount: z.string().nullable(),
  laneName: z.string().min(1).nullable(),
  upstreamId: z.string().min(1).max(1024),
  providerName: z.string().min(1),
  providerModel: z.string().min(1),
  state: z.string(),
});
type Binding = z.infer<typeof BindingSchema>;
export const ARK_VIDEO_MODELS = new Set([
  "ark/seedance-2.5",
  "seedance-video",
  "doubao-seedance-2-5-260628",
]);
export const ARK_THREE_D_MODELS = new Set(["ark/seed3d-2.0", "seed3d", "doubao-seed3d-2-0-260328"]);

export function parseArkTaskCreate(raw: unknown): string | null {
  const parsed = ArkTaskCreateResponseSchema.safeParse(raw);
  return parsed.success && parsed.data.id.length <= 1024 ? parsed.data.id : null;
}
export function parseArkTaskRequest(
  kind: ArkTaskKind,
  raw: Record<string, unknown>,
  model: string,
) {
  return (
    kind === "video" ? ArkVideoGenerationRequestSchema : ArkThreeDGenerationRequestSchema
  ).safeParse({ ...raw, model });
}
export function encodeArkTaskBinding(binding: Binding): string {
  return PREFIX + Buffer.from(JSON.stringify(BindingSchema.parse(binding))).toString("base64url");
}
export function decodeArkTaskBinding(
  record: ResponsesRegistryRecord,
  kind: ArkTaskKind,
): Binding | null {
  if (!record.status.startsWith(PREFIX) || record.status.length > 8192) return null;
  try {
    const binding = BindingSchema.parse(
      JSON.parse(Buffer.from(record.status.slice(PREFIX.length), "base64url").toString()),
    );
    if (
      binding.kind !== kind ||
      record.responseId !== `${kind}:${binding.publicId}` ||
      binding.providerAlias !== record.providerAlias ||
      binding.providerAccount !== (record.providerAccount ?? null) ||
      binding.providerName !== record.providerName ||
      binding.providerModel !== record.providerModel ||
      record.selectedLane !== kind
    )
      return null;
    return binding;
  } catch {
    return null;
  }
}
export function isArkTaskRecord(record: ResponsesRegistryRecord): boolean {
  return record.status.startsWith(PREFIX);
}
export function updateArkTaskState(
  record: ResponsesRegistryRecord,
  kind: ArkTaskKind,
  state: string,
) {
  const binding = decodeArkTaskBinding(record, kind);
  if (!binding) throw new Error("invalid persisted Ark task binding");
  return { ...record, status: encodeArkTaskBinding({ ...binding, state }) };
}

/** Validate association BEFORE interpreting lifecycle or returning artifacts. */
export function normalizeArkTaskResult(
  kind: ArkTaskKind,
  raw: Record<string, unknown>,
  record: ResponsesRegistryRecord,
  publicId: string,
  nowMs: number,
): Record<string, unknown> | null {
  const binding = decodeArkTaskBinding(record, kind);
  if (!binding || raw.id !== binding.upstreamId || raw.model !== binding.providerModel) return null;
  // Ark failed/cancelled responses legitimately use null for absent content/usage.
  // Normalize only those known optional values before the strict T01 contract.
  const clean = { ...raw };
  for (const key of ["content", "usage"] as const) if (clean[key] === null) delete clean[key];
  // Expired 3D tasks have the same absent-artifact contract as cancellation.
  // T01's older 3D enum omits expired; validate all other fields unchanged.
  if (kind === "three-d" && clean.status === "expired") clean.status = "cancelled";
  const parsed = (
    kind === "video" ? ArkVideoRetrieveResponseSchema : ArkThreeDRetrieveResponseSchema
  ).safeParse(clean);
  if (!parsed.success) return null;
  const task = parsed.data;
  if (kind === "three-d" && raw.status === "expired")
    return { request_id: publicId, status: "expired" };
  const base: Record<string, unknown> = {
    request_id: publicId,
    status:
      task.status === "succeeded"
        ? "done"
        : task.status === "running"
          ? "in_progress"
          : task.status,
  };
  if (task.status === "failed") {
    const code = task.error?.code === "SetLimitExceeded" ? "SetLimitExceeded" : "task_failed";
    base.error = {
      code,
      message:
        code === "SetLimitExceeded"
          ? "provider generation limit exceeded"
          : "media generation failed",
    };
  }
  if (task.status !== "succeeded") return base;
  const completedAt = task.updated_at === undefined ? record.createdAt : task.updated_at * 1000;
  // A future timestamp is untrusted. Expired links are never exposed as usable.
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt > nowMs ||
    nowMs - completedAt >= ARTIFACT_TTL_MS
  ) {
    return {
      request_id: publicId,
      status: "expired",
      error: {
        code: "artifact_expired",
        message: "media artifact link has expired or its validity cannot be verified",
      },
    };
  }
  const content = task.content as Record<string, unknown> | undefined;
  if (kind === "video") base.video = { url: content?.video_url };
  else base.file = { url: content?.file_url, format: "zip", model_format: "glb" };
  base.artifact_expires_at = completedAt + ARTIFACT_TTL_MS;
  if (task.usage) base.usage = task.usage;
  return base;
}
