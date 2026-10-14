import { randomUUID } from "node:crypto";
import { createBlockedModelMatcher, type ResponsesRegistryRecord } from "@helm/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { requestSignal } from "../middleware/limits.js";
import {
  decodeMediaTaskBinding,
  encodeMediaTaskBinding,
  MEDIA_TASK_RETENTION_MS,
  type MediaTaskBinding,
  MediaTaskBindingSchema,
} from "./media-task-binding.js";
import type { MessagesIdentity } from "./messages.js";
import type { VideoCreateTarget, VideosRouteDeps } from "./videos.js";

const ResultSchema = z.strictObject({
  status: z.enum(["queued", "in_progress", "done", "failed", "cancelled", "expired"]),
  video: z.strictObject({ url: z.url() }).optional(),
  transcription: z.record(z.string(), z.unknown()).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  error: z.strictObject({ code: z.string().min(1), message: z.string().optional() }).optional(),
  artifact_expires_at: z.number().int().nonnegative().optional(),
});
export interface NativeMediaTaskProfile {
  profile: "bailian" | "minimax";
  endpointIdentity: string;
  queryTtlMs: number;
  validate(body: Record<string, unknown>, model: string): Record<string, unknown>;
  parseCreated(body: Record<string, unknown>): string | null;
  normalize(
    body: Record<string, unknown>,
    upstreamId: string,
    model: string,
  ): Record<string, unknown> | null;
}
function error(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: string,
  operationId?: string,
): Response {
  return c.json(
    {
      error: {
        type: "upstream_error",
        code,
        message: code.replaceAll("_", " "),
        ...(operationId ? { operation_id: operationId } : {}),
      },
    },
    status,
  );
}
const OperationSchema = z.strictObject({
  state: z.enum(["dispatching", "accepted", "rejected", "not_sent", "outcome_unknown"]),
  upstreamId: z.string().max(1024).nullable(),
  binding: MediaTaskBindingSchema.optional(),
});
function operationStatus(
  state: string,
  upstreamId: string | null,
  binding?: MediaTaskBinding,
): string {
  return `helm-media-create:v1:${JSON.stringify({ state, upstreamId, binding })}`;
}
function parseOperation(record: ResponsesRegistryRecord) {
  const prefix = "helm-media-create:v1:";
  if (!record.status.startsWith(prefix) || record.status.length > 16384) return null;
  try {
    return OperationSchema.parse(JSON.parse(record.status.slice(prefix.length)));
  } catch {
    return null;
  }
}
export function readNativeMediaOperation(record: ResponsesRegistryRecord) {
  const value = parseOperation(record);
  if (!value) return null;
  return {
    state: value.state === "dispatching" ? "outcome_unknown" : value.state,
    upstream_task_known: value.upstreamId !== null,
  };
}
/** Recover only a durably known upstream ID; this operation never issues a paid POST. */
export async function recoverNativeMediaOperation(
  record: ResponsesRegistryRecord,
  deps: VideosRouteDeps,
): Promise<string | null> {
  const value = parseOperation(record);
  if (!value?.binding || !value.upstreamId || ["not_sent", "rejected"].includes(value.state))
    return null;
  const binding = { ...value.binding, upstreamId: value.upstreamId };
  if (record.responseId !== `${binding.kind}-create:${binding.operationId}`) return null;
  const recovered = {
    ...record,
    responseId: `${binding.kind}:${binding.publicId}`,
    status: encodeMediaTaskBinding(binding),
  };
  if (!decodeMediaTaskBinding(recovered)) return null;
  if (await deps.registry.putIfAbsent(recovered)) return binding.publicId;
  const existing = await deps.registry.get(recovered.responseId, {
    keyId: record.keyId,
    accountId: record.accountId,
  });
  return existing &&
    existing.keyId === record.keyId &&
    existing.accountId === record.accountId &&
    decodeMediaTaskBinding(existing)?.operationId === binding.operationId
    ? binding.publicId
    : null;
}
export async function createNativeMediaTask(
  c: Context<AppEnv>,
  deps: VideosRouteDeps,
  target: VideoCreateTarget,
  body: Record<string, unknown>,
  identity: MessagesIdentity,
  kind: "video" | "transcription",
  recordStart: (
    status: "ok" | "error",
    errorClass: string | null,
    upstream: Record<string, unknown> | null,
  ) => Promise<void>,
): Promise<Response> {
  const profile = target.nativeTask;
  if (
    !profile ||
    !target.providerAccount ||
    !Number.isSafeInteger(profile.queryTtlMs) ||
    profile.queryTtlMs <= 0 ||
    profile.queryTtlMs > MEDIA_TASK_RETENTION_MS
  )
    return error(c, 503, "media_profile_unavailable");
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const operationId = randomUUID();
  const publicId = randomUUID();
  const binding: MediaTaskBinding = {
    version: 1,
    kind,
    publicId,
    operationId,
    providerAlias: target.providerAlias,
    providerName: target.providerName,
    providerModel: target.providerModel,
    providerAccount: target.providerAccount,
    laneName: target.laneName ?? null,
    profile: profile.profile,
    endpointIdentity: profile.endpointIdentity,
    upstreamId: "pending",
    state: "queued",
    queryExpiresAt: startedAt + profile.queryTtlMs,
    artifactExpiresAt: null,
  };
  const reservation: ResponsesRegistryRecord = {
    responseId: `${kind}-create:${operationId}`,
    accountId: identity.accountId,
    keyId: identity.keyId,
    providerAlias: target.providerAlias,
    providerName: target.providerName,
    providerModel: target.providerModel,
    providerProtocol: null,
    providerAccount: target.providerAccount,
    selectedLane: kind,
    createdAt: startedAt,
    expiresAt: startedAt + MEDIA_TASK_RETENTION_MS,
    status: operationStatus("dispatching", null, binding),
  };
  try {
    if (!(await deps.registry.putIfAbsent(reservation)))
      return error(c, 503, "registry_unavailable");
  } catch {
    return error(c, 503, "registry_unavailable");
  }
  let upstreamId: string | null = null;
  try {
    const raw = await target.client.create(
      { ...body, model: target.providerModel },
      requestSignal(c),
    );
    upstreamId = profile.parseCreated(raw);
    if (!upstreamId || upstreamId.length > 1024) throw new Error("invalid accepted task");
    binding.upstreamId = upstreamId;
    await deps.registry.put({
      ...reservation,
      status: operationStatus("accepted", upstreamId, binding),
    });
    const mapped = await deps.registry.putIfAbsent({
      ...reservation,
      responseId: `${kind}:${publicId}`,
      status: encodeMediaTaskBinding(binding),
    });
    if (!mapped) throw new Error("task binding unavailable");
    await recordStart("ok", null, raw);
    if (deps.settleBudget && identity.caps?.budget) {
      try {
        await deps.settleBudget(
          identity.keyId,
          identity.caps.budget,
          { requests: 1, tokens: 0, costUsd: null },
          now(),
        );
      } catch {
        /* A post-create accounting error cannot replay the paid write. */
      }
    }
    return c.json({ request_id: publicId, status: "queued" });
  } catch (cause) {
    const evidence = z
      .object({
        providerRaw: z.object({
          response: z.object({
            task_id: z.string().min(1).max(1024).optional(),
            output: z.object({ task_id: z.string().min(1).max(1024) }).optional(),
          }),
        }),
      })
      .safeParse(cause);
    if (upstreamId === null && evidence.success)
      upstreamId =
        evidence.data.providerRaw.response.output?.task_id ??
        evidence.data.providerRaw.response.task_id ??
        null;
    const rejected =
      cause !== null &&
      typeof cause === "object" &&
      "outcome" in cause &&
      cause.outcome === "rejected";
    const notSent =
      cause !== null &&
      typeof cause === "object" &&
      "outcome" in cause &&
      cause.outcome === "not_sent";
    try {
      await deps.registry.put({
        ...reservation,
        status: operationStatus(
          rejected ? "rejected" : notSent ? "not_sent" : "outcome_unknown",
          upstreamId,
          binding,
        ),
      });
    } catch {
      /* The pre-dispatch durable reservation remains for reconciliation. */
    }
    await recordStart(
      "error",
      rejected ? "upstream_rejected" : notSent ? "not_sent" : "outcome_unknown",
      null,
    );
    return error(
      c,
      rejected ? 400 : 503,
      rejected ? "upstream_rejected" : notSent ? "upstream_not_sent" : "outcome_unknown",
      operationId,
    );
  }
}
export async function pollNativeMediaTask(
  c: Context<AppEnv>,
  deps: VideosRouteDeps,
  record: ResponsesRegistryRecord,
  identity: MessagesIdentity,
  kind: "video" | "transcription",
  requestId: string,
): Promise<Response> {
  const binding = decodeMediaTaskBinding(record);
  if (!binding || binding.kind !== kind || binding.publicId !== requestId)
    return error(c, 502, "invalid_task_binding");
  const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
  if (
    blocked &&
    [binding.providerAlias, binding.providerModel, binding.laneName].some(
      (v) => v !== null && blocked.matches(v),
    )
  )
    return error(c, 403, "model_blocked");
  if (
    binding.laneName !== null &&
    identity.caps?.allowedLanes != null &&
    !identity.caps.allowedLanes.includes(binding.laneName)
  )
    return error(c, 403, "lane_not_allowed");
  if (binding.laneName === null && identity.caps?.allowCustomModel !== true)
    return error(c, 403, "model_not_found");
  const now = (deps.now ?? Date.now)();
  if (now >= binding.queryExpiresAt) return error(c, 410, "task_query_expired");
  const client = await deps.resolver.poll(record);
  if (!client?.nativeTask) return error(c, 503, "provider_unavailable");
  if (
    client.nativeTask.endpointIdentity !== binding.endpointIdentity ||
    client.nativeTask.profile !== binding.profile
  )
    return error(c, 409, "task_provider_changed");
  try {
    const raw = await client.retrieve(binding.upstreamId, requestSignal(c));
    const normalized = client.nativeTask.normalize(raw, binding.upstreamId, binding.providerModel);
    const parsed = ResultSchema.safeParse(normalized);
    if (!parsed.success) return error(c, 502, "invalid_task_result");
    const result = parsed.data;
    if (result.status === "done" && (kind === "video" ? !result.video : !result.transcription))
      return error(c, 502, "missing_task_artifact");
    if (result.video && new URL(result.video.url).protocol !== "https:")
      return error(c, 502, "invalid_artifact_url");
    try {
      await deps.registry.put({
        ...record,
        status: encodeMediaTaskBinding({
          ...binding,
          state: result.status,
          artifactExpiresAt: result.artifact_expires_at ?? null,
        }),
      });
    } catch {
      deps.log?.("media.task_state_update_failed", { request_id: requestId });
    }
    return c.json({ request_id: requestId, ...result });
  } catch {
    return error(c, 502, "task_query_failed");
  }
}
