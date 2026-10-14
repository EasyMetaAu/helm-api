import { MediaSpeechRequestSchema } from "@helm/shared";
import { z } from "zod";
import {
  type SpeechClient,
  SpeechParameterError,
  type SpeechSocketConnector,
  speechMime,
} from "./media-speech.js";
import { runSpeechSession } from "./media-speech-session.js";
import type { OpenAIClientDeps } from "./openai.js";

const Control = z.object({
  header: z.object({ event: z.string(), task_id: z.string().optional() }),
});
export interface BailianSpeechTransport {
  url: string;
  connect: SpeechSocketConnector;
}
export function createBailianSpeechClient(
  deps: OpenAIClientDeps,
  transport: BailianSpeechTransport,
): SpeechClient & Required<Pick<SpeechClient, "openSpeechSession">> {
  const client: SpeechClient & Required<Pick<SpeechClient, "openSpeechSession">> = {
    async openSpeechSession(request, opts) {
      const req = MediaSpeechRequestSchema.parse({ ...request, input: "session" });
      if (!["mp3", "wav", "pcm"].includes(req.response_format))
        throw new SpeechParameterError("unsupported Bailian speech format");
      const taskId = crypto.randomUUID();
      const signal = AbortSignal.any([
        AbortSignal.timeout(deps.config.timeoutMs ?? 60_000),
        ...(opts?.signal ? [opts.signal] : []),
      ]);
      const auth = deps.config.getAuthHeader
        ? await deps.config.getAuthHeader()
        : `Bearer ${deps.config.apiKey ?? ""}`;
      const socket = await transport.connect({
        url: transport.url,
        headers: { ...deps.config.extraHeaders?.(), Authorization: auth },
        signal,
      });
      let started = false;
      const send = (action: string, payload: Record<string, unknown>) =>
        socket.send(
          JSON.stringify({ header: { action, task_id: taskId, streaming: "duplex" }, payload }),
        );
      return runSpeechSession({
        socket,
        request: req,
        signal,
        capabilities: { flush: false, cancel: false },
        start: () =>
          send("run-task", {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model: req.model,
            parameters: {
              text_type: "PlainText",
              voice: req.voice,
              format: req.response_format,
              sample_rate: req.sample_rate,
              rate: req.speed,
            },
            input: {},
          }),
        command: (type, text) =>
          send(type === "append" ? "continue-task" : "finish-task", {
            input: type === "append" ? { text } : {},
          }),
        async receive(data, emit) {
          if (data instanceof Uint8Array) {
            if (!started) throw new Error("speech audio before task-started");
            emit({ type: "audio", audio: data });
            return;
          }
          const { header } = Control.parse(JSON.parse(data));
          if (header.task_id !== taskId) throw new Error("speech task identity mismatch");
          if (header.event === "task-failed") throw new Error("Bailian speech task failed");
          if (header.event === "task-started") {
            started = true;
            return "started";
          }
          if (header.event === "task-finished") return "completed";
        },
      });
    },
    async *streamSpeech(raw, opts) {
      const req = MediaSpeechRequestSchema.parse(raw);
      const session = await client.openSpeechSession(req, opts);
      try {
        await session.append(req.input);
        await session.finish();
        yield* session.events;
      } finally {
        session.close();
      }
    },
    async ttsSpeech(raw, opts) {
      const req = MediaSpeechRequestSchema.parse(raw);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const event of client.streamSpeech(req, opts)) {
        if (event.type === "audio") {
          size += event.audio.length;
          if (size > 16 * 1024 * 1024) throw new Error("speech response exceeds limit");
          chunks.push(event.audio);
        }
      }
      if (size === 0) throw new Error("speech completed without audio");
      return {
        audio: new Uint8Array(Buffer.concat(chunks)),
        contentType: speechMime(req.response_format),
      };
    },
  };
  return client;
}
