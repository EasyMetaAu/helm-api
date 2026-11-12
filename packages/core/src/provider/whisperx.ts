import { AudioTranscriptionRequestSchema, AudioTranscriptionResultSchema } from "@helm/shared";
import { z } from "zod";
import { type AudioTranscriptionClient, AudioTranscriptionError } from "./audio-transcription.js";
import { SpeechParameterError } from "./media-speech.js";
import { type OpenAIClientDeps, readUpstreamJsonWithinBudget } from "./openai.js";

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
export function createWhisperXClient(deps: OpenAIClientDeps): AudioTranscriptionClient {
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
      let response: Response;
      try {
        response = await (deps.fetch ?? globalThis.fetch)(
          `${deps.config.baseUrl.replace(/\/$/, "")}/transcribe`,
          {
            method: "POST",
            redirect: "error",
            headers: { Authorization: `Bearer ${deps.config.apiKey ?? ""}` },
            body,
            signal,
          },
        );
      } catch {
        throw new AudioTranscriptionError("outcome_unknown");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AudioTranscriptionError(
          response.status >= 500 || response.status === 408
            ? "outcome_unknown"
            : "upstream_rejected",
          response.status >= 500 ? 502 : response.status,
        );
      }
      let data: unknown;
      try {
        data = await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission);
      } catch {
        throw new AudioTranscriptionError("outcome_unknown");
      }
      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success) throw new AudioTranscriptionError("outcome_unknown");
      const result = parsed.data.result;
      const words = result.word_segments?.flatMap((word) =>
        word.start !== undefined && word.end !== undefined
          ? [{ text: word.word, startMs: word.start * 1000, endMs: word.end * 1000 }]
          : [],
      );
      return AudioTranscriptionResultSchema.parse({
        text: result.segments.map((segment) => segment.text).join(""),
        languages: result.language ? [{ code: result.language }] : undefined,
        durationMs: result.audio_duration === undefined ? undefined : result.audio_duration * 1000,
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
