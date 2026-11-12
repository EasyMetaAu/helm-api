import {
  type AudioTranscriptionClient,
  AudioTranscriptionError,
  consumeResponseBytesWithinBudget,
  createBlockedModelMatcher,
  ResponseBodyTooLargeError,
  SpeechParameterError,
} from "@helm/core";
import { AudioTranscriptionRequestSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { requestSignal } from "../middleware/limits.js";
import {
  type AudioSpeechRouteDeps,
  acquireSpeechLease,
  admitSpeechIdentity,
  SpeechAdmissionError,
} from "./audio-speech.js";
import type { MessagesIdentity } from "./messages.js";
export interface TranscriptionSelection {
  client: AudioTranscriptionClient;
  model: string;
  alias: string;
  lane: string;
  customModel: boolean;
}
export interface AudioTranscriptionsRouteDeps
  extends Omit<AudioSpeechRouteDeps, "resolve" | "record"> {
  resolve(
    model: string,
    identity: MessagesIdentity,
  ): TranscriptionSelection | null | Promise<TranscriptionSelection | null>;
  record?: (input: {
    identity: MessagesIdentity;
    selection: TranscriptionSelection;
    traceId: string;
    status: "completed" | "error";
    result?: Awaited<ReturnType<AudioTranscriptionClient["transcribe"]>>;
    errorCode?: string;
  }) => Promise<void>;
}
export function registerAudioTranscriptionsRoute(
  app: Hono<AppEnv>,
  deps: AudioTranscriptionsRouteDeps,
): void {
  app.post("/v1/audio/transcriptions", async (c) => {
    let lease: Awaited<ReturnType<typeof acquireSpeechLease>> | undefined;
    // Admission uses only auth/budget/rate/concurrency; resolution is specific to this media kind.
    const admission = deps;
    try {
      const identity = await admitSpeechIdentity(
        admission,
        /^Bearer\s+(.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? null,
        c.req.header("user-agent") ?? null,
      );
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.startsWith("multipart/form-data;"))
        throw new SpeechAdmissionError(400, "invalid_request", "multipart/form-data is required");
      lease = await acquireSpeechLease(
        admission,
        identity,
        AbortSignal.any([requestSignal(c), AbortSignal.timeout(120000)]),
      );
      const bytes = await consumeResponseBytesWithinBudget(
        new Response(c.req.raw.body, { headers: c.req.raw.headers }),
        26 * 1024 * 1024,
      );
      let form: FormData;
      try {
        form = await new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch {
        throw new SpeechAdmissionError(400, "invalid_request", "invalid multipart body");
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024)
        throw new SpeechAdmissionError(400, "invalid_request", "file must contain 1 to 25 MiB");
      const raw: Record<string, unknown> = {};
      for (const [key, value] of form) {
        if (key === "file") continue;
        if (key === "languages[]" || key === "keywords[]") raw[key.slice(0, -2)] = form.getAll(key);
        else if (key in raw)
          throw new SpeechAdmissionError(400, "invalid_request", "duplicate field");
        else
          raw[key] =
            key === "diarize"
              ? value === "true"
                ? true
                : value === "false"
                  ? false
                  : value
              : value;
      }
      const parsed = AudioTranscriptionRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new SpeechAdmissionError(400, "invalid_request", "invalid transcription parameters");
      const req = parsed.data;
      const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
      if (blocked?.matches(req.model))
        throw new SpeechAdmissionError(403, "model_not_allowed", "transcription model is blocked");
      const selection = await deps.resolve(req.model, identity);
      if (!selection)
        throw new SpeechAdmissionError(
          503,
          "provider_unavailable",
          "transcription lane is unavailable",
        );
      if (
        [selection.alias, selection.model, selection.lane].some((value) =>
          blocked?.matches(value),
        ) ||
        (selection.customModel && identity.caps?.allowCustomModel !== true)
      )
        throw new SpeechAdmissionError(
          403,
          "model_not_allowed",
          "transcription model is not allowed",
        );
      if (identity.caps?.allowedLanes && !identity.caps.allowedLanes.includes(selection.lane))
        throw new SpeechAdmissionError(
          403,
          "lane_not_allowed",
          "transcription lane is not allowed",
        );
      const traceId = c.get("trace_id") ?? crypto.randomUUID();
      let result: Awaited<ReturnType<AudioTranscriptionClient["transcribe"]>> | undefined;
      let errorCode: string | undefined;
      try {
        result = await selection.client.transcribe({ ...req, model: selection.model }, file, {
          signal: lease.signal,
        });
        return c.json(result, 200, { "cache-control": "no-store" });
      } catch (error) {
        errorCode = error instanceof AudioTranscriptionError ? error.code : "outcome_unknown";
        throw error;
      } finally {
        try {
          if (identity.caps?.budget && deps.settleBudget)
            await deps.settleBudget(
              identity.keyId,
              identity.caps.budget,
              {
                requests: 1,
                tokens: result?.usage?.type === "tokens" ? result.usage.total_tokens : 0,
                costUsd: null,
              },
              Date.now(),
            );
          await deps.record?.({
            identity,
            selection,
            traceId,
            status: result ? "completed" : "error",
            result,
            errorCode,
          });
        } catch {
          c.get("logger")?.log("error", "media.transcription_accounting_failed", {
            trace_id: traceId,
          });
        }
      }
    } catch (error) {
      const status =
        error instanceof SpeechAdmissionError
          ? error.status
          : error instanceof SpeechParameterError
            ? 422
            : error instanceof ResponseBodyTooLargeError
              ? 413
              : error instanceof AudioTranscriptionError &&
                  error.status >= 400 &&
                  error.status < 500
                ? error.status
                : 502;
      const code =
        error instanceof SpeechAdmissionError
          ? error.code
          : error instanceof SpeechParameterError
            ? "unsupported_parameter"
            : error instanceof ResponseBodyTooLargeError
              ? "request_too_large"
              : error instanceof AudioTranscriptionError
                ? error.code
                : "upstream_error";
      return c.json(
        {
          error: {
            code,
            message: code,
            type: status < 500 ? "invalid_request_error" : "upstream_error",
          },
        },
        status as ContentfulStatusCode,
      );
    } finally {
      await lease?.release();
    }
  });
}
