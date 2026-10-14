import {
  MiniMaxVideoCreateResponseSchema,
  MiniMaxVideoTaskResponseSchema,
  parseMiniMaxVideoRequest,
} from "@helm/shared";
import { createMediaHttpTransport, mediaTaskPath, parseMediaInput } from "./media-http.js";
import type { OpenAIClientDeps, ProviderCallOptions } from "./openai.js";

export { parseMiniMaxVideoRequest };
export const MINIMAX_VIDEO_QUERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Artifact expiration is unknown. Re-query the same task for refreshed URLs; never recreate it.
export function parseMiniMaxVideoTask(value: unknown, expectedId?: string, expectedModel?: string) {
  const raw = MiniMaxVideoTaskResponseSchema.parse(value);
  if (expectedId !== undefined && raw.task.id !== expectedId) throw new Error("Task ID mismatch");
  if (expectedModel !== undefined && raw.task.model !== expectedModel)
    throw new Error("Task model mismatch");
  return raw;
}
export function normalizeMiniMaxVideoTask(
  value: unknown,
  expectedId?: string,
  expectedModel?: string,
) {
  const { task } = parseMiniMaxVideoTask(value, expectedId, expectedModel);
  return {
    id: task.id,
    status: task.status,
    url: task.content?.url,
    usage: task.usage,
    error: task.error,
  };
}
export const validateMiniMaxVideo = (body: Record<string, unknown>, wireModel: string) =>
  parseMiniMaxVideoRequest({ ...body, model: wireModel });
export function parseMiniMaxVideoCreated(value: unknown): string | null {
  const result = MiniMaxVideoCreateResponseSchema.safeParse(value);
  return result.success ? result.data.task_id : null;
}
export function normalizeMiniMaxVideo(value: unknown, upstreamId: string, wireModel: string) {
  try {
    const task = normalizeMiniMaxVideoTask(value, upstreamId, wireModel);
    return {
      status:
        task.status === "succeeded"
          ? ("done" as const)
          : task.status === "running"
            ? ("in_progress" as const)
            : task.status,
      video: task.url ? { url: task.url } : undefined,
      usage: task.usage,
      error: task.error,
    };
  } catch {
    return null;
  }
}
export function createMiniMaxVideoClient(deps: OpenAIClientDeps) {
  const call = createMediaHttpTransport(deps, "minimax");
  const isRejection = (raw: Record<string, unknown>) => raw.error !== undefined;
  return {
    async videoGeneration(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      const parsed = parseMediaInput(() => parseMiniMaxVideoRequest(body));
      return call(
        {
          path: "/v2/video_generation",
          body: parsed,
          isRejection,
          parse: (raw) => MiniMaxVideoCreateResponseSchema.parse(raw),
        },
        opts,
      );
    },
    async videoRetrieve(id: string, opts?: ProviderCallOptions) {
      return call(
        {
          path: `/v2/query/video_generation/${mediaTaskPath(id)}`,
          isRejection,
          parse: (raw) => parseMiniMaxVideoTask(raw, id),
        },
        opts,
      );
    },
  };
}
