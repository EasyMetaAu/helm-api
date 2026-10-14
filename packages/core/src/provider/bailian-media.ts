import {
  BailianImageResponseSchema,
  BailianTaskResponseSchema,
  parseBailianImageRequest,
  parseBailianTranscriptionRequest,
  parseBailianVideoRequest,
} from "@helm/shared";
import { fetchPublicResultJson } from "./gemini.js";
import { createMediaHttpTransport, mediaTaskPath, parseMediaInput } from "./media-http.js";
import type { OpenAIClientDeps, ProviderCallOptions } from "./openai.js";

export { parseBailianImageRequest, parseBailianTranscriptionRequest, parseBailianVideoRequest };
export const BAILIAN_VIDEO_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BAILIAN_VIDEO_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export function parseBailianTask(
  value: unknown,
  kind: "video" | "transcription",
  expectedId?: string,
  expectedModel?: string,
) {
  const raw = BailianTaskResponseSchema.parse(value);
  if (expectedId !== undefined && raw.output.task_id !== expectedId)
    throw new Error("Task ID mismatch");
  if (
    expectedModel !== undefined &&
    ((raw.model !== undefined && raw.model !== expectedModel) ||
      (raw.output.model !== undefined && raw.output.model !== expectedModel))
  )
    throw new Error("Task model mismatch");
  if (raw.output.task_status === "SUCCEEDED") {
    if (kind === "video" && !raw.output.video_url) throw new Error("Missing video result");
    if (kind === "transcription") {
      if (raw.output.result !== undefined && raw.output.results !== undefined)
        throw new Error("Ambiguous transcription shape");
      const results = raw.output.results ?? (raw.output.result ? [raw.output.result] : []);
      if (!results.length) throw new Error("Missing transcription results");
      for (const result of results) {
        if (raw.output.results && !result.subtask_status)
          throw new Error("Missing per-file status");
        if (
          (!result.subtask_status || result.subtask_status === "SUCCEEDED") &&
          !result.transcription_url
        )
          throw new Error("Missing transcription URL");
        if (result.subtask_status && !["SUCCEEDED", "FAILED"].includes(result.subtask_status))
          throw new Error("Unfinished file in completed task");
      }
    }
  }
  return raw;
}

export function normalizeBailianTask(
  value: unknown,
  kind: "video" | "transcription",
  expectedId?: string,
  expectedModel?: string,
) {
  const raw = parseBailianTask(value, kind, expectedId, expectedModel);
  const output = raw.output;
  const results = output.results ?? (output.result ? [output.result] : undefined);
  const failures = results?.filter((result) => result.subtask_status === "FAILED").length ?? 0;
  const status =
    output.task_status === "SUCCEEDED" && failures > 0
      ? failures === results?.length
        ? "failed"
        : "partial"
      : (
          {
            PENDING: "queued",
            RUNNING: "in_progress",
            SUCCEEDED: "succeeded",
            FAILED: "failed",
            CANCELED: "cancelled",
            UNKNOWN: "unknown",
          } as const
        )[output.task_status];
  return {
    id: output.task_id,
    status,
    url: output.video_url,
    results,
    usage: raw.usage,
    error: output.code ? { code: output.code, message: output.message } : undefined,
  };
}

/** Gateway-facing helpers use the frozen upstream model, never a newly resolved lane. */
export const validateBailianImage = (body: Record<string, unknown>, wireModel: string) =>
  parseBailianImageRequest({ ...body, model: wireModel });
export const validateBailianVideo = (body: Record<string, unknown>, wireModel: string) =>
  parseBailianVideoRequest({ ...body, model: wireModel });
export const validateBailianTranscription = (body: Record<string, unknown>, wireModel: string) =>
  parseBailianTranscriptionRequest({ ...body, model: wireModel });
export function parseBailianCreated(value: unknown): string | null {
  const result = BailianTaskResponseSchema.safeParse(value);
  return result.success ? result.data.output.task_id : null;
}
export function normalizeBailianVideo(value: unknown, upstreamId: string, wireModel: string) {
  try {
    const task = normalizeBailianTask(value, "video", upstreamId, wireModel);
    if (task.status === "unknown") return null;
    return {
      status:
        task.status === "succeeded"
          ? ("done" as const)
          : task.status === "partial"
            ? ("failed" as const)
            : task.status,
      video: task.url ? { url: task.url } : undefined,
      usage: task.usage,
      error: task.error,
    };
  } catch {
    return null;
  }
}
export function normalizeBailianTranscription(
  value: unknown,
  upstreamId: string,
  wireModel: string,
) {
  try {
    const task = normalizeBailianTask(value, "transcription", upstreamId, wireModel);
    if (task.status === "unknown") return null;
    return {
      status:
        task.status === "succeeded" || task.status === "partial" ? ("done" as const) : task.status,
      transcription: {
        results: task.results,
        partial_failure: task.status === "partial",
        upstream_status: task.status,
      },
      usage: task.usage,
      error: task.error,
    };
  } catch {
    return null;
  }
}

export function createBailianMediaClient(deps: OpenAIClientDeps) {
  const call = createMediaHttpTransport(deps, "bailian");
  const isRejection = (raw: Record<string, unknown>) =>
    raw.error !== undefined || typeof raw.code === "string";
  const create = (
    kind: "video" | "transcription",
    body: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ) => {
    const parsed = parseMediaInput(() =>
      kind === "video" ? parseBailianVideoRequest(body) : parseBailianTranscriptionRequest(body),
    );
    return call(
      {
        path:
          kind === "video"
            ? "/services/aigc/video-generation/video-synthesis"
            : "/services/audio/asr/transcription",
        body: parsed,
        asyncTask: true,
        isRejection,
        parse: (value) => parseBailianTask(value, kind, undefined, parsed.model),
      },
      opts,
    );
  };
  const retrieve = (kind: "video" | "transcription", id: string, opts?: ProviderCallOptions) =>
    call(
      {
        path: `/tasks/${mediaTaskPath(id)}`,
        isRejection,
        parse: (value) => parseBailianTask(value, kind, id),
      },
      opts,
    );
  return {
    async imageGeneration(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      const parsed = parseMediaInput(() => parseBailianImageRequest(body));
      return call(
        {
          path: "/images/generations",
          sdkImage: true,
          body: parsed,
          isRejection,
          parse: (value) => BailianImageResponseSchema.parse(value),
        },
        opts,
      );
    },
    async videoGeneration(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      return create("video", body, opts);
    },
    async videoRetrieve(id: string, opts?: ProviderCallOptions) {
      return retrieve("video", id, opts);
    },
    async transcriptionCreate(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      return create("transcription", body, opts);
    },
    async transcriptionRetrieve(id: string, opts?: ProviderCallOptions) {
      return retrieve("transcription", id, opts);
    },
  };
}

/** Result downloads never carry provider Authorization and reuse DNS-pinned HTTPS. */
export async function materializeBailianTranscription(
  value: Record<string, unknown>,
  signal?: AbortSignal,
  download: typeof import("./gemini.js").fetchPublicResultJson = fetchPublicResultJson,
) {
  const raw = parseBailianTask(value, "transcription");
  if (raw.output.task_status !== "SUCCEEDED") return raw;
  const results = raw.output.results ?? (raw.output.result ? [raw.output.result] : []);
  if (results.length > 100) throw new Error("too many transcription results");
  for (const result of results) {
    if (result.subtask_status === "FAILED" || !result.transcription_url) continue;
    const transcript = await download(result.transcription_url, { signal });
    if (!transcript || typeof transcript !== "object" || Array.isArray(transcript))
      throw new Error("invalid transcription result JSON");
    result.transcript = transcript;
  }
  return raw;
}
