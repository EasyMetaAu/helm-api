import {
  type MediaSpeechRequest,
  MediaSpeechRequestSchema,
  type MediaSpeechUsage,
  MediaSpeechUsageSchema,
} from "@helm/shared";
import { z } from "zod";
import { decodeSpeechHex, type SpeechSocketConnector } from "./media-speech.js";
import { runSpeechSession } from "./media-speech-session.js";

const Packet = z.object({
  event: z.string().optional(),
  is_final: z.boolean().optional(),
  base_resp: z.object({ status_code: z.number() }).optional(),
  data: z.object({ audio: z.string().optional() }).optional(),
  extra_info: MediaSpeechUsageSchema.optional(),
});
export interface MiniMaxSpeechTransport {
  url: string;
  connect: SpeechSocketConnector;
  profile: "minimax-bidi" | "minimax-unidirectional";
}
export async function createMiniMaxSpeechSession(
  req: Omit<MediaSpeechRequest, "input" | "stream">,
  options: MiniMaxSpeechTransport & { headers: Record<string, string>; signal: AbortSignal },
) {
  req = MediaSpeechRequestSchema.parse({ ...req, input: "session" });
  if (![8000, 16000, 22050, 24000, 32000, 44100].includes(req.sample_rate))
    throw new Error("unsupported MiniMax sample_rate");
  const socket = await options.connect(options);
  let started = false,
    pending: { text: string; accepted: boolean }[] = [],
    retries = 0;
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    socket.send(JSON.stringify({ event, ...extra }));
  let requestUsage: MediaSpeechUsage | undefined;
  let retryPending: Promise<void> | undefined;
  const bidi = options.profile === "minimax-bidi";
  return runSpeechSession({
    socket,
    request: req,
    signal: options.signal,
    capabilities: { flush: bidi, cancel: bidi },
    start: async () => {},
    async command(type, text) {
      await retryPending;
      options.signal.throwIfAborted();
      if (type === "append") {
        if (pending.length >= 32) throw new Error("speech pending text limit");
        pending.push({ text: text ?? "", accepted: false });
      }
      await send(
        {
          append: "task_continue",
          flush: "task_flush",
          cancel: "task_cancel",
          finish: "task_finish",
        }[type],
        type === "append" ? { text } : {},
      );
    },
    async receive(data, emit) {
      if (typeof data !== "string") throw new Error("unexpected MiniMax binary frame");
      const packet = Packet.parse(JSON.parse(data));
      const code = packet.base_resp?.status_code ?? 0;
      if (code === 2205) {
        // The protocol has no request ID. Retry only an unambiguous rejected input.
        if (pending.length !== 1 || pending[0]?.accepted || retries >= 2)
          throw new Error("speech backpressure: rejected input cannot safely be replayed");
        retries++;
        const rejectedText = pending[0]?.text;
        retryPending = (async () => {
          await new Promise((r) => setTimeout(r, 200 * retries));
          options.signal.throwIfAborted();
          await send("task_continue", { text: rejectedText });
        })();
        try {
          await retryPending;
        } finally {
          retryPending = undefined;
        }
        return;
      }
      if (code !== 0) throw new Error(`MiniMax speech business error ${code}`);
      if (packet.event === "connected_success") {
        await send("task_start", {
          model: req.model,
          voice_setting: { voice_id: req.voice, speed: req.speed },
          audio_setting: { format: req.response_format, sample_rate: req.sample_rate },
        });
        return;
      }
      if (packet.event === "task_started") {
        started = true;
        return "started";
      }
      if (!started) throw new Error("speech event before task_started");
      if (packet.data?.audio) {
        for (const input of pending) input.accepted = true;
        emit({ type: "audio", audio: decodeSpeechHex(packet.data.audio) });
      }
      if (packet.extra_info) requestUsage = { ...requestUsage, ...packet.extra_info };
      if (packet.is_final) {
        if (requestUsage) emit({ type: "usage", usage: requestUsage });
        requestUsage = undefined;
        pending.shift();
        retries = 0;
        emit({ type: "request_final" });
      }
      if (packet.event === "sentence_end") emit({ type: "sentence_end" });
      if (packet.event === "task_flushed") emit({ type: "flushed" });
      if (packet.event === "task_canceled") {
        if (requestUsage) emit({ type: "usage", usage: requestUsage });
        requestUsage = undefined;
        pending = [];
        retries = 0;
        emit({ type: "canceled" });
      }
      if (packet.event === "task_finished") {
        if (requestUsage) emit({ type: "usage", usage: requestUsage });
        return "completed";
      }
    },
  });
}
