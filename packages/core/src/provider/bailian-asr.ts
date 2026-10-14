import { z } from "zod";
import { BailianShortAsrRequestSchema } from "../../../shared/src/request/bailian-media.js";
import {
  createMediaHttpTransport,
  MediaHttpError,
  mediaBaseUrl,
  parseMediaInput,
} from "./media-http.js";
import { createOpenAIClient, type OpenAIClientDeps, type ProviderCallOptions } from "./openai.js";

export const BAILIAN_SHORT_ASR_PROFILE = "qwen3-asr-flash-chat";
export const parseBailianShortAsrRequest = (value: unknown) =>
  BailianShortAsrRequestSchema.parse(value);
/** Native Chat only. Lane isolation / no ordinary text fallback remains the gateway's responsibility. */
export function createBailianAsrClient(deps: OpenAIClientDeps) {
  const unary = createMediaHttpTransport(deps, "bailian");
  const compatibleBase = (value: string) =>
    `${mediaBaseUrl(value, "bailian").origin}/compatible-mode/v1`;
  const baseUrl = compatibleBase(deps.config.baseUrl);
  const resolve = deps.config.resolveBaseUrl;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const chat = createOpenAIClient({
    ...deps,
    fetch: async (url, init) => {
      const response = await doFetch(url, { ...init, redirect: "manual" });
      // The generic Chat transport retries overloads independently of connectRetries.
      // A paid ASR call has no idempotency guarantee; stop that policy at its fetch seam.
      if (response.status === 503 || response.status === 529) {
        await response.body?.cancel().catch(() => {});
        throw new MediaHttpError(
          "unknown",
          "upstream_error",
          "ASR upstream overloaded",
          { error: { code: "upstream_overloaded" } },
          response.status,
        );
      }
      return response;
    },
    config: {
      ...deps.config,
      baseUrl,
      connectRetries: 0,
      onUnauthorized: undefined,
      resolveBaseUrl: resolve ? async () => compatibleBase(await resolve()) : undefined,
    },
  });
  return {
    async chatCompletion(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      const parsed = parseMediaInput(() => parseBailianShortAsrRequest({ ...body, stream: false }));
      return unary(
        {
          path: "/chat/completions",
          compatible: true,
          body: parsed,
          isRejection: (raw) => raw.error !== undefined,
          parse: (value) =>
            z
              .object({ choices: z.array(z.record(z.string(), z.unknown())).min(1) })
              .passthrough()
              .parse(value),
        },
        opts,
      );
    },
    async *chatCompletionStream(body: Record<string, unknown>, opts?: ProviderCallOptions) {
      const parsed = parseMediaInput(() => parseBailianShortAsrRequest({ ...body, stream: true }));
      yield* chat.chatCompletionStream(parsed, { ...opts, overloadRetry: undefined });
    },
  };
}
