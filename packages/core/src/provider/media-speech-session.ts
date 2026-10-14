import type { MediaSpeechRequest } from "../../../shared/src/request/media-speech-schema.js";
import type { SpeechEvent, SpeechEventData, SpeechSession, SpeechSocket } from "./media-speech.js";

/** One-consumer queue; overflow stops the producer instead of retaining audio. */
export function speechQueue<T>(maxFrames: number, maxBytes: number, onOverflow: () => void) {
  const items: { value: T; bytes: number }[] = [];
  let bytes = 0,
    ended = false,
    failure: Error | undefined,
    wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(value: T) {
      if (ended) return;
      const size =
        value instanceof Uint8Array
          ? value.byteLength
          : Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
      if (items.length >= maxFrames || bytes + size > maxBytes) {
        this.end(new Error("speech consumer backpressure limit"));
        onOverflow();
        return;
      }
      items.push({ value, bytes: size });
      bytes += size;
      notify();
    },
    end(error?: Error) {
      if (ended) return;
      ended = true;
      failure = error;
      if (error) {
        items.length = 0;
        bytes = 0;
      }
      notify();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (failure) throw failure;
        const item = items.shift();
        if (item) {
          bytes -= item.bytes;
          yield item.value;
        } else if (ended) return;
        else
          await new Promise<void>((r) => {
            wake = r;
          });
      }
    },
  };
}
export interface SpeechSessionEngine {
  socket: SpeechSocket;
  request: Omit<MediaSpeechRequest, "input" | "stream">;
  signal: AbortSignal;
  capabilities: { flush: boolean; cancel: boolean };
  start(): Promise<void>;
  command(type: "append" | "flush" | "cancel" | "finish", text?: string): Promise<void>;
  receive(
    data: string | Uint8Array,
    emit: (event: SpeechEventData) => void,
  ): Promise<"started" | "completed" | undefined>;
}
export async function runSpeechSession(engine: SpeechSessionEngine): Promise<SpeechSession> {
  let sequence = 0,
    started = false,
    terminal = false,
    finishing = false;
  let readyResolve: () => void = () => {},
    readyReject: (err: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const queue = speechQueue<SpeechEvent>(128, 4 * 1024 * 1024, () =>
    stop(new Error("speech consumer backpressure limit")),
  );
  const stop = (error?: Error) => {
    if (terminal) return;
    terminal = true;
    engine.signal.removeEventListener("abort", abort);
    engine.socket.close();
    queue.end(error);
    if (!started) readyReject(error ?? new Error("speech closed before start"));
  };
  const abort = () => stop(new Error("speech aborted"));
  const emit = (event: SpeechEventData) => queue.push({ ...event, sequence: sequence++ });
  engine.signal.addEventListener("abort", abort, { once: true });
  if (engine.signal.aborted) abort();
  void (async () => {
    try {
      if (terminal) return;
      await engine.start();
      for await (const data of engine.socket.messages) {
        if (terminal) break;
        const state = await engine.receive(data, emit);
        if (state === "started") {
          if (started) throw new Error("duplicate speech start");
          started = true;
          emit({
            type: "started",
            format: engine.request.response_format,
            sampleRate: engine.request.sample_rate,
          });
          readyResolve();
        }
        if (state === "completed") {
          if (!started) throw new Error("speech completed before start");
          emit({ type: "completed" });
          stop();
          return;
        }
      }
      if (!terminal) stop(new Error("speech socket closed before task completion"));
    } catch (error) {
      stop(error instanceof Error ? error : new Error("speech session failed"));
    }
  })();
  await ready;
  async function command(type: "append" | "flush" | "cancel" | "finish", text?: string) {
    if (terminal || finishing) throw new Error("speech session is finished");
    if ((type === "flush" || type === "cancel") && !engine.capabilities[type])
      throw new Error(`${type} unsupported for speech profile`);
    if (type === "append" && (!text || text.length > 10_000))
      throw new Error("invalid speech text length");
    if (type === "finish") finishing = true;
    try {
      await engine.command(type, text);
    } catch (error) {
      stop(error instanceof Error ? error : new Error("speech send failed"));
      throw error;
    }
  }
  return {
    events: queue,
    capabilities: engine.capabilities,
    append: (text) => command("append", text),
    flush: () => command("flush"),
    cancel: () => command("cancel"),
    finish: () => command("finish"),
    close: () => stop(new Error("speech closed")),
  };
}
