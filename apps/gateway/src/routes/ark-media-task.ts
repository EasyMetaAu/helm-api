import { Buffer } from "node:buffer";
import { type ResponsesRegistryRecord, UpstreamError } from "@helm/core";
import {
  ArkTaskCreateResponseSchema,
  ArkThreeDGenerationRequestSchema,
  ArkThreeDRetrieveResponseSchema,
  ArkVideoGenerationRequestSchema,
  ArkVideoRetrieveResponseSchema,
  type ProviderAttempt,
} from "@helm/shared";
import { z } from "zod";

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

// Transport errors already scrub the actual credential. Only protocol identifiers
// may leave that boundary: raw messages/headers can still contain signed asset URLs.
const DiagnosticCode = z
  .string()
  .max(128)
  .regex(/^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*\.?$/);
const DiagnosticRequestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const DiagnosticParam = z
  .string()
  .max(128)
  .regex(
    /^(?:model|duration|ratio|resolution|generate_audio|watermark|output_format|omni_reference_task_type|file_format|subdivision_level|content(?:\[\d{1,2}\]|\.\d{1,2})?(?:\.(?:type|text|role|(?:image|video|audio)_url(?:\.url)?))?)$/,
  );
const DiagnosticBody = z.object({
  error: z
    .object({
      code: z.unknown().optional(),
      param: z.unknown().optional(),
      message: z.unknown().optional(),
    })
    .optional(),
  request_id: z.unknown().optional(),
});

export function arkMediaErrorDetail(failure: unknown): ProviderAttempt["error_detail"] {
  if (!(failure instanceof UpstreamError)) return null;
  const parsed = DiagnosticBody.safeParse(failure.providerRaw);
  const body = parsed.success ? parsed.data : undefined;
  const code = DiagnosticCode.safeParse(body?.error?.code);
  const param = DiagnosticParam.safeParse(body?.error?.param);
  const message = body?.error?.message;
  // Ark also documents a trailing "Request id: ..." in its error message.
  // Extract that identifier alone; never retain any of the surrounding text.
  const messageId =
    typeof message === "string"
      ? /\bRequest[ _-]?id:\s*([A-Za-z0-9_-]{1,128})\.?\s*$/i.exec(message)?.[1]
      : undefined;
  const requestId = [
    failure.upstreamHeaders?.["x-request-id"],
    failure.upstreamHeaders?.["x-tt-logid"],
    body?.request_id,
    messageId,
  ]
    .map((value) => DiagnosticRequestId.safeParse(value))
    .find((result) => result.success);
  return {
    upstream_status: failure.upstreamStatus,
    message: "Ark media request failed",
    provider_raw: {
      ...(code.success || param.success
        ? {
            error: {
              ...(code.success ? { code: code.data } : {}),
              ...(param.success ? { param: param.data } : {}),
            },
          }
        : {}),
      ...(requestId?.success ? { request_id: requestId.data } : {}),
    },
  };
}

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
    const knownCodes = new Set([
      "SetLimitExceeded",
      "InvalidParameter.TaskTypeConstraint",
      "InvalidParameter.TaskTypeMismatch",
    ]);
    const code = task.error && knownCodes.has(task.error.code) ? task.error.code : "task_failed";
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
