import {
  MediaSpeechRequestSchema,
  type MediaSpeechTimestamp,
  MediaSpeechTimestampSchema,
  type MediaSpeechUsage,
} from "@helm/shared";
import { z } from "zod";
import { readSSE } from "../protocol/streaming.js";
import { MediaHttpError } from "./media-http.js";
import {
  type SpeechClient,
  type SpeechEvent,
  SpeechParameterError,
  speechMime,
} from "./media-speech.js";
import { speechQueue } from "./media-speech-session.js";
import type { OpenAIClientDeps } from "./openai.js";

const Packet = z.object({
  code: z.number(),
  data: z.string().nullable().optional(),
  sentence: z
    .object({
      text: z.string(),
      words: z.array(
        z.object({
          word: z.string(),
          startTime: z.number().nonnegative(),
          endTime: z.number().nonnegative(),
        }),
      ),
    })
    .optional(),
  usage: z.object({ text_words: z.number().nonnegative() }).optional(),
});
export function createDoubaoSpeechClient(deps: OpenAIClientDeps): SpeechClient {
  const client: SpeechClient = {
    async *streamSpeech(raw, opts) {
      const req = MediaSpeechRequestSchema.parse(raw);
      if (
        req.model !== "seed-tts-2.0" ||
        !["mp3", "pcm", "opus"].includes(req.response_format) ||
        ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(req.sample_rate)
      )
        throw new SpeechParameterError("unsupported Doubao 2.0 model or audio format/sample rate");
      const signal = AbortSignal.any([
        AbortSignal.timeout(deps.config.timeoutMs ?? 120000),
        ...(opts?.signal ? [opts.signal] : []),
      ]);
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const body = JSON.stringify({
        user: { uid: id },
        req_params: {
          text: req.input,
          speaker: req.voice,
          audio_params: {
            format: req.response_format === "opus" ? "ogg_opus" : req.response_format,
            sample_rate: req.sample_rate,
            speech_rate: Math.round((req.speed - 1) * 100),
            ...(req.timestamps ? { enable_subtitle: true } : {}),
          },
        },
      });
      let response: Response;
      try {
        response = await (deps.fetch ?? globalThis.fetch)(
          `${deps.config.baseUrl.replace(/\/$/, "")}/api/v3/tts/unidirectional/sse`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "X-Api-Key": deps.config.apiKey ?? "",
              "X-Api-Resource-Id": "seed-tts-2.0",
              "X-Api-Request-Id": id,
              "X-Control-Require-Usage-Tokens-Return": "text_words",
            },
            body,
            signal,
          },
        );
      } catch {
        throw new MediaHttpError("unknown", "upstream_error", "speech outcome unknown");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new MediaHttpError(
          response.status < 500 ? "rejected" : "unknown",
          "upstream_error",
          "speech upstream rejected request",
          null,
          response.status,
        );
      }
      let sequence = 0,
        sawAudio = false;
      try {
        yield {
          type: "started",
          sequence: sequence++,
          format: req.response_format,
          sampleRate: req.sample_rate,
        };
        for await (const frame of readSSE(
          response.body,
          4 * 1024 * 1024,
          deps.responseWorkAdmission,
        )) {
          if (!frame.data) continue;
          const packet = Packet.parse(JSON.parse(frame.data));
          if (packet.code !== 0 && packet.code !== 20000000)
            throw new MediaHttpError("unknown", "upstream_error", "Doubao speech business error");
          if (packet.data) {
            if (
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.data)
            )
              throw new Error("invalid speech base64");
            sawAudio = true;
            yield {
              type: "audio",
              sequence: sequence++,
              audio: new Uint8Array(Buffer.from(packet.data, "base64")),
            };
          }
          if (packet.sentence?.words.length) {
            const words = packet.sentence.words.map((word) => ({
              text: word.word,
              startMs: word.startTime * 1000,
              endMs: word.endTime * 1000,
            }));
            yield {
              type: "timestamp",
              sequence: sequence++,
              timestamp: MediaSpeechTimestampSchema.parse({
                text: packet.sentence.text,
                startMs: words[0]?.startMs,
                endMs: words.at(-1)?.endMs,
                words,
              }),
            };
          }
          if (packet.code === 20000000) {
            if (!sawAudio) throw new Error("speech completed without audio");
            if (packet.usage)
              yield {
                type: "usage",
                sequence: sequence++,
                usage: {
                  text_words: packet.usage.text_words,
                  usage_characters: packet.usage.text_words,
                },
              };
            yield { type: "completed", sequence: sequence++ };
            return;
          }
        }
        throw new MediaHttpError(
          "unknown",
          "upstream_error",
          "speech stream ended before completion",
        );
      } finally {
        await response.body.cancel().catch(() => {});
      }
    },
    async ttsSpeech(raw, opts) {
      const req = MediaSpeechRequestSchema.parse(raw),
        chunks: Uint8Array[] = [],
        timestamps: MediaSpeechTimestamp[] = [];
      let size = 0,
        usage: MediaSpeechUsage | undefined;
      for await (const event of client.streamSpeech(req, opts)) {
        if (event.type === "audio") {
          size += event.audio.length;
          if (size > 16 * 1024 * 1024) throw new Error("speech response exceeds limit");
          chunks.push(event.audio);
        }
        if (event.type === "timestamp") timestamps.push(event.timestamp);
        if (event.type === "usage") usage = event.usage;
      }
      return {
        audio: new Uint8Array(Buffer.concat(chunks)),
        contentType: speechMime(req.response_format),
        usage,
        ...(timestamps.length ? { timestamps } : {}),
      };
    },
    async openSpeechSession(request, opts) {
      const req = MediaSpeechRequestSchema.parse({ ...request, input: "session" });
      const abort = new AbortController();
      const events = speechQueue<SpeechEvent>(128, 4 * 1024 * 1024, () => abort.abort());
      const signal = opts?.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal;
      let input = "",
        finished = false,
        closed = false;
      // This is a buffered session over Doubao's one-input HTTP API. Only finish dispatches.
      return {
        events,
        capabilities: { flush: false, cancel: false },
        async append(text) {
          if (finished || closed) throw new SpeechParameterError("speech session ended");
          if (input.length + text.length > 10000)
            throw new SpeechParameterError("speech input exceeds limit");
          input += text;
        },
        async flush() {
          throw new SpeechParameterError("flush unsupported");
        },
        async cancel() {
          throw new SpeechParameterError("cancel unsupported; close the session");
        },
        async finish() {
          if (finished || closed) throw new SpeechParameterError("speech session ended");
          finished = true;
          void (async () => {
            try {
              for await (const event of client.streamSpeech({ ...req, input }, { ...opts, signal }))
                events.push(event);
              events.end();
            } catch {
              events.end(new Error("Doubao speech outcome unknown"));
            }
          })();
        },
        close() {
          closed = true;
          abort.abort();
          events.end();
        },
      };
    },
  };
  return client;
}
