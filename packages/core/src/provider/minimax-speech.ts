import {
  MediaSpeechRequestSchema,
  type MediaSpeechTimestamp,
  type MediaSpeechUsage,
  MediaSpeechUsageSchema,
} from "@helm/shared";
import { z } from "zod";
import { readSSE } from "../protocol/streaming.js";
import {
  accumulateSpeechUsage,
  decodeSpeechHex,
  type SpeechClient,
  type SpeechEvent,
  SpeechParameterError,
  speechMime,
} from "./media-speech.js";
import {
  createMiniMaxSpeechSession,
  type MiniMaxSpeechTransport,
} from "./minimax-speech-session.js";
import { MiniMaxSubtitleSchema, minimaxTimestamp } from "./minimax-subtitle.js";
import {
  type OpenAIClientDeps,
  type ProviderCallOptions,
  readUpstreamJsonWithinBudget,
  UpstreamError,
} from "./openai.js";

const Packet = z.object({
  base_resp: z.object({ status_code: z.number() }),
  data: z
    .object({
      audio: z.string().optional(),
      status: z.number().optional(),
      subtitle: MiniMaxSubtitleSchema.optional(),
    })
    .optional(),
  extra_info: MediaSpeechUsageSchema.optional(),
});
export function createMiniMaxSpeechClient(
  deps: OpenAIClientDeps,
  transport?: MiniMaxSpeechTransport,
): SpeechClient {
  async function request(
    raw: Record<string, unknown>,
    stream: boolean,
    opts?: ProviderCallOptions,
  ) {
    const req = MediaSpeechRequestSchema.parse(raw);
    if (![8000, 16000, 22050, 24000, 32000, 44100].includes(req.sample_rate))
      throw new SpeechParameterError("unsupported MiniMax sample_rate");
    const body = JSON.stringify({
      model: req.model,
      text: req.input,
      stream,
      output_format: "hex",
      ...(req.timestamps ? { subtitle_enable: true, subtitle_type: req.timestamps } : {}),
      voice_setting: { voice_id: req.voice, speed: req.speed },
      audio_setting: { format: req.response_format, sample_rate: req.sample_rate },
      ...(stream ? { stream_options: { exclude_aggregated_audio: true } } : {}),
    });
    opts?.captureUpstream?.(body);
    const base = deps.config.resolveBaseUrl
      ? await deps.config.resolveBaseUrl()
      : deps.config.baseUrl;
    const auth = deps.config.getAuthHeader
      ? await deps.config.getAuthHeader()
      : `Bearer ${deps.config.apiKey ?? ""}`;
    const signal = AbortSignal.any([
      AbortSignal.timeout(deps.config.timeoutMs ?? 60_000),
      ...(opts?.signal ? [opts.signal] : []),
    ]);
    const response = await (deps.fetch ?? globalThis.fetch)(
      `${base.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/t2a_v2`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          ...deps.config.extraHeaders?.(),
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body,
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(
        "upstream_error",
        "speech upstream rejected request",
        null,
        response.status,
      );
    }
    return { req, response };
  }
  function packet(raw: unknown) {
    const parsed = Packet.safeParse(raw);
    if (!parsed.success) throw new UpstreamError("upstream_error", "invalid speech response");
    if (parsed.data.base_resp.status_code !== 0)
      throw new UpstreamError(
        "upstream_error",
        `speech upstream business error ${parsed.data.base_resp.status_code}`,
      );
    return parsed.data;
  }
  const client: SpeechClient = {
    ...(transport
      ? {
          openSpeechSession: async (
            req: Parameters<NonNullable<SpeechClient["openSpeechSession"]>>[0],
            opts?: ProviderCallOptions,
          ) => {
            const signal = AbortSignal.any([
              AbortSignal.timeout(deps.config.timeoutMs ?? 120_000),
              ...(opts?.signal ? [opts.signal] : []),
            ]);
            const auth = deps.config.getAuthHeader
              ? await deps.config.getAuthHeader()
              : `Bearer ${deps.config.apiKey ?? ""}`;
            return createMiniMaxSpeechSession(req, {
              ...transport,
              headers: { ...deps.config.extraHeaders?.(), Authorization: auth },
              signal,
            });
          },
        }
      : {}),
    async ttsSpeech(raw, opts) {
      if (raw.timestamps) {
        const chunks: Uint8Array[] = [];
        const timestamps: MediaSpeechTimestamp[] = [];
        let size = 0;
        let usage: MediaSpeechUsage | undefined;
        for await (const event of client.streamSpeech(raw, opts)) {
          if (event.type === "audio") {
            size += event.audio.length;
            if (size > 16 * 1024 * 1024) throw new Error("speech response exceeds limit");
            chunks.push(event.audio);
          }
          if (event.type === "timestamp") timestamps.push(event.timestamp);
          if (event.type === "usage") usage = accumulateSpeechUsage(usage, event.usage);
        }
        return {
          audio: new Uint8Array(Buffer.concat(chunks)),
          contentType: speechMime(MediaSpeechRequestSchema.parse(raw).response_format),
          usage,
          ...(usage?.audio_length !== undefined ? { durationMs: usage.audio_length } : {}),
          ...(timestamps.length ? { timestamps } : {}),
        };
      }
      const { req, response } = await request(raw, false, opts);
      const result = packet(
        await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission),
      );
      return {
        audio: decodeSpeechHex(result.data?.audio ?? ""),
        contentType: speechMime(req.response_format),
        usage: result.extra_info,
        ...(result.extra_info?.audio_length !== undefined
          ? { durationMs: result.extra_info.audio_length }
          : {}),
      };
    },
    async *streamSpeech(raw, opts) {
      const { req, response } = await request(raw, true, opts);
      if (!response.body) throw new UpstreamError("upstream_error", "speech response missing body");
      try {
        let sequence = 0;
        yield {
          type: "started",
          sequence: sequence++,
          format: req.response_format,
          sampleRate: req.sample_rate,
        };
        let sawAudio = false;
        let cumulativeUsage: MediaSpeechUsage = {};
        for await (const frame of readSSE(
          response.body,
          4 * 1024 * 1024,
          deps.responseWorkAdmission,
        )) {
          if (!frame.data || frame.data === "[DONE]") continue;
          const result = packet(JSON.parse(frame.data));
          // The documented final status=2 audio is a complete aggregate. Never replay it.
          if (result.data?.audio && !(result.data.status === 2 && sawAudio)) {
            const audio = decodeSpeechHex(result.data.audio);
            sawAudio = true;
            yield { type: "audio", sequence: sequence++, audio } satisfies SpeechEvent;
          }
          if (result.data?.subtitle)
            yield {
              type: "timestamp",
              sequence: sequence++,
              timestamp: minimaxTimestamp(result.data.subtitle),
            };
          if (result.extra_info) {
            const usage: MediaSpeechUsage = {};
            for (const key of ["usage_characters", "usage_voice_count", "audio_length"] as const) {
              const value = result.extra_info[key];
              if (value !== undefined) {
                const previous = cumulativeUsage[key] ?? 0;
                if (value < previous) throw new Error("speech cumulative usage decreased");
                usage[key] = value - previous;
              }
            }
            cumulativeUsage = { ...cumulativeUsage, ...result.extra_info };
            yield { type: "usage", sequence: sequence++, usage } satisfies SpeechEvent;
          }
          if (result.data?.status === 2) {
            if (!sawAudio)
              throw new UpstreamError("upstream_error", "speech completed without audio");
            yield { type: "completed", sequence: sequence++ };
            return;
          }
        }
        throw new UpstreamError("upstream_error", "speech stream ended before completion");
      } finally {
        await response.body.cancel().catch(() => {});
      }
    },
  };
  return client;
}
