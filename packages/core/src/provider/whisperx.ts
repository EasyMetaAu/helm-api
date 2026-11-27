import { AudioTranscriptionRequestSchema, AudioTranscriptionResultSchema } from "@helm/shared";
import { z } from "zod";
import { pcmWavDurationSeconds } from "../budget/transcription-accounting.js";
import { type AudioTranscriptionClient, AudioTranscriptionError } from "./audio-transcription.js";
import { SpeechParameterError } from "./media-speech.js";
import {
  type OpenAIClientDeps,
  providerErrorScrubber,
  readUpstreamErrorBody,
  readUpstreamJsonWithinBudget,
  safeUpstreamHeaders,
} from "./openai.js";

const Timed = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() });
const Word = z.object({
  word: z.string(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
});
const ResponseSchema = z.object({
  status: z.literal("success"),
  result: z.object({
    language: z.string().optional(),
    audio_duration: z.number().nonnegative().optional(),
    segments: z.array(Timed.extend({ text: z.string() })),
    word_segments: z.array(Word).optional(),
  }),
});
/** Verified legacy standalone /transcribe protocol, usable behind an operator-owned authenticated HTTPS proxy. */
export function createWhisperXClient(
  deps: OpenAIClientDeps & { maxAudioSeconds?: number },
): AudioTranscriptionClient {
  return {
    async transcribe(raw, file, opts) {
      const req = AudioTranscriptionRequestSchema.parse(raw);
      if (
        req.model !== "whisperx" ||
        req.diarize ||
        req.prompt ||
        req.keywords?.length ||
        (req.languages?.length ?? 0) > 1
      )
        throw new SpeechParameterError("unsupported WhisperX request options");
      if (!file.size || file.size > 25 * 1024 * 1024)
        throw new SpeechParameterError("audio file must contain 1 to 25 MiB");
      if (deps.maxAudioSeconds !== undefined) {
        const duration = pcmWavDurationSeconds(new Uint8Array(await file.arrayBuffer()));
        if (duration === null || duration > deps.maxAudioSeconds) {
          throw new SpeechParameterError(
            "WhisperX duration limit requires complete mono PCM16 WAV within the configured time limit",
          );
        }
      }
      const body = new FormData();
      body.set("file", file, file.name);
      body.set("language", req.languages?.[0] ?? "auto");
      body.set("sync_mode", "true");
      // The legacy cache key excludes language/options; bypass reads so another request's cache is not reused.
      body.set("skip_cache", "true");
      const signal = AbortSignal.any([
        AbortSignal.timeout(deps.config.timeoutMs ?? 120000),
        ...(opts?.signal ? [opts.signal] : []),
      ]);
      signal.throwIfAborted();
      const scrub = providerErrorScrubber(deps.config);
      let response: Response;
      try {
        response = await (deps.fetch ?? globalThis.fetch)(
          `${deps.config.baseUrl.replace(/\/$/, "")}/transcribe`,
          {
            method: "POST",
            redirect: "error",
            headers: deps.config.apiKey ? { Authorization: `Bearer ${deps.config.apiKey}` } : {},
            body,
            signal,
          },
        );
      } catch (cause) {
        throw new AudioTranscriptionError("outcome_unknown", 502, undefined, {
          cause: scrub(cause),
        });
      }
      if (!response.ok) {
        const diagnostic = {
          raw: await readUpstreamErrorBody(response, scrub, deps.responseWorkAdmission),
          status: response.status,
          headers: scrub(safeUpstreamHeaders(response.headers)) as Record<string, string>,
        };
        if (
          response.status === 429 &&
          /\/helm\/?$/.test(new URL(deps.config.baseUrl).pathname) &&
          response.headers.get("X-ASR-Admission") === "gpu-busy"
        ) {
          const retry = response.headers.get("Retry-After") ?? "";
          const retryAfter = /^\d{1,2}$/.test(retry) && Number(retry) > 0 ? Number(retry) : 5;
          throw new AudioTranscriptionError(
            "transcription_capacity_exhausted",
            429,
            retryAfter,
            diagnostic,
          );
        }
        throw new AudioTranscriptionError(
          response.status >= 500 || response.status === 408
            ? "outcome_unknown"
            : "upstream_rejected",
          response.status >= 500 ? 502 : response.status,
          undefined,
          diagnostic,
        );
      }
      let data: unknown;
      try {
        data = await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission);
      } catch (cause) {
        throw new AudioTranscriptionError("outcome_unknown", 502, undefined, {
          cause: scrub(cause),
        });
      }
      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success)
        throw new AudioTranscriptionError("outcome_unknown", 502, undefined, {
          raw: scrub(data),
          status: response.status,
        });
      const result = parsed.data.result;
      const durationSeconds = result.audio_duration;
      const words = result.word_segments?.flatMap((word) =>
        word.start !== undefined && word.end !== undefined
          ? [{ text: word.word, startMs: word.start * 1000, endMs: word.end * 1000 }]
          : [],
      );
      return AudioTranscriptionResultSchema.parse({
        text: result.segments.map((segment) => segment.text).join(""),
        languages: result.language ? [{ code: result.language }] : undefined,
        durationMs: durationSeconds === undefined ? undefined : durationSeconds * 1000,
        // This is provider-reported input audio duration, not GPU time.
        ...(durationSeconds !== undefined && durationSeconds > 0
          ? { usage: { type: "duration", seconds: durationSeconds } }
          : {}),
        segments: result.segments.map((segment) => ({
          text: segment.text,
          startMs: segment.start * 1000,
          endMs: segment.end * 1000,
        })),
        ...(words?.length ? { words } : {}),
      });
    },
  };
}
