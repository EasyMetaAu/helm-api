import {
  type AudioTranscriptionRequest,
  AudioTranscriptionRequestSchema,
  type AudioTranscriptionResult,
  AudioTranscriptionResultSchema,
} from "@helm/shared";
import { z } from "zod";
import { SpeechParameterError } from "./media-speech.js";
import {
  type OpenAIClientDeps,
  type ProviderCallOptions,
  readUpstreamJsonWithinBudget,
} from "./openai.js";

export class AudioTranscriptionError extends Error {
  constructor(
    readonly code: "outcome_unknown" | "upstream_rejected" | "upstream_invalid_response",
    readonly status = 502,
  ) {
    super(code);
  }
}
export interface AudioTranscriptionClient {
  transcribe(
    request: AudioTranscriptionRequest,
    file: File,
    opts?: ProviderCallOptions,
  ): Promise<AudioTranscriptionResult>;
}
const Word = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.number().int().nonnegative().optional(),
});
const DeepgramResult = z.object({
  metadata: z.object({
    request_id: z.string(),
    duration: z.number().nonnegative(),
    channels: z.number().int().positive(),
  }),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(z.object({ transcript: z.string(), words: z.array(Word).optional() }))
            .min(1),
        }),
      )
      .length(1),
    utterances: z
      .array(
        z.object({
          transcript: z.string(),
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          speaker: z.number().int().nonnegative().optional(),
          words: z.array(Word).optional(),
        }),
      )
      .optional(),
  }),
});
const word = (value: z.infer<typeof Word>) => ({
  text: value.word,
  startMs: value.start * 1000,
  endMs: value.end * 1000,
  ...(value.speaker !== undefined ? { speaker: value.speaker } : {}),
  ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
});
export function createAudioTranscriptionClient(
  kind: "openai" | "deepgram",
  deps: OpenAIClientDeps,
): AudioTranscriptionClient {
  return {
    async transcribe(raw, file, opts) {
      const req = AudioTranscriptionRequestSchema.parse(raw);
      if (!(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024)
        throw new SpeechParameterError("audio file must contain 1 to 25 MiB");
      if (kind === "openai" && (req.timestamps || req.diarize))
        throw new SpeechParameterError("gpt-transcribe timestamps and diarization are unsupported");
      if (kind === "deepgram" && (req.prompt || (req.languages?.length ?? 0) > 1))
        throw new SpeechParameterError("Deepgram accepts one language and no prompt");
      const base = deps.config.resolveBaseUrl
        ? await deps.config.resolveBaseUrl()
        : deps.config.baseUrl;
      const auth = deps.config.getAuthHeader
        ? await deps.config.getAuthHeader()
        : `${kind === "deepgram" ? "Token" : "Bearer"} ${deps.config.apiKey ?? ""}`;
      const signal = AbortSignal.any([
        AbortSignal.timeout(deps.config.timeoutMs ?? 120000),
        ...(opts?.signal ? [opts.signal] : []),
      ]);
      signal.throwIfAborted();
      let body: FormData | File;
      const url = new URL(
        `${base.replace(/\/$/, "")}/${kind === "openai" ? "audio/transcriptions" : "listen"}`,
      );
      const headers: Record<string, string> = {
        ...deps.config.extraHeaders?.(),
        Authorization: auth,
      };
      if (kind === "openai") {
        body = new FormData();
        body.set("file", file, file.name);
        body.set("model", req.model);
        body.set("response_format", "json");
        for (const language of req.languages ?? []) body.append("languages[]", language);
        for (const keyword of req.keywords ?? []) body.append("keywords[]", keyword);
        if (req.prompt) body.set("prompt", req.prompt);
      } else {
        body = file;
        headers["Content-Type"] = file.type || "application/octet-stream";
        url.searchParams.set("model", req.model);
        url.searchParams.set("language", req.languages?.[0] ?? "en");
        url.searchParams.set("smart_format", "true");
        if (req.timestamps === "sentence") url.searchParams.set("utterances", "true");
        if (req.diarize) url.searchParams.set("diarize_model", "v2");
        for (const keyword of req.keywords ?? []) url.searchParams.append("keyterm", keyword);
      }
      let response: Response;
      try {
        response = await (deps.fetch ?? globalThis.fetch)(url.toString(), {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal,
        });
      } catch {
        throw new AudioTranscriptionError("outcome_unknown");
      }
      if (!response.ok) {
        await response.body?.cancel();
        // A provider 5xx cannot prove that the paid operation did not execute.
        throw new AudioTranscriptionError(
          response.status >= 500 || response.status === 408
            ? "outcome_unknown"
            : "upstream_rejected",
          response.status >= 500 ? 502 : response.status,
        );
      }
      let result: unknown;
      try {
        result = await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission);
      } catch {
        throw new AudioTranscriptionError("outcome_unknown");
      }
      if (kind === "openai") {
        const parsed = AudioTranscriptionResultSchema.safeParse(result);
        if (!parsed.success) throw new AudioTranscriptionError("upstream_invalid_response");
        return parsed.data;
      }
      const parsed = DeepgramResult.safeParse(result);
      if (!parsed.success) throw new AudioTranscriptionError("upstream_invalid_response");
      const { metadata, results } = parsed.data;
      const alternative = results.channels[0]?.alternatives[0];
      return AudioTranscriptionResultSchema.parse({
        text: alternative?.transcript,
        requestId: metadata.request_id,
        ...(alternative?.words ? { words: alternative.words.map(word) } : {}),
        ...(results.utterances
          ? {
              segments: results.utterances.map((segment) => ({
                text: segment.transcript,
                startMs: segment.start * 1000,
                endMs: segment.end * 1000,
                speaker: segment.speaker,
                words: segment.words?.map(word),
              })),
            }
          : {}),
        usage: { type: "duration", seconds: metadata.duration, channels: metadata.channels },
      });
    },
  };
}
