import { z } from "zod";
import {
  MediaSpeechRequestSchema,
  MediaSpeechUsageSchema,
} from "../../../shared/src/request/media-speech-schema.js";
import { readSSE } from "../protocol/streaming.js";
import {
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
import {
  type OpenAIClientDeps,
  type ProviderCallOptions,
  readUpstreamJsonWithinBudget,
  UpstreamError,
} from "./openai.js";

const Packet = z.object({
  base_resp: z.object({ status_code: z.number() }),
  data: z.object({ audio: z.string().optional(), status: z.number().optional() }).optional(),
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
  return {
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
      const { req, response } = await request(raw, false, opts);
      const result = packet(
        await readUpstreamJsonWithinBudget(response, deps.responseWorkAdmission),
      );
      return {
        audio: decodeSpeechHex(result.data?.audio ?? ""),
        contentType: speechMime(req.response_format),
        usage: result.extra_info,
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
          if (result.extra_info)
            yield {
              type: "usage",
              sequence: sequence++,
              usage: result.extra_info,
            } satisfies SpeechEvent;
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
}
