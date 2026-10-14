import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type {
  SpeechSession,
  SpeechSocketConnector,
} from "../../../packages/core/src/provider/media-speech.js";
import { speechQueue } from "../../../packages/core/src/provider/media-speech-session.js";
import {
  MediaSpeechCommandSchema,
  type MediaSpeechUsage,
} from "../../../packages/shared/src/request/media-speech-schema.js";
import { codexWebSocketAgent } from "./codex-responses-websocket.js";
import type { RealtimeWebSocketUpgradeServer } from "./realtime-websocket.js";
import {
  type AudioSpeechRouteDeps,
  acquireSpeechLease,
  admitSpeechIdentity,
  resolveSpeechSelection,
  SpeechAdmissionError,
  type SpeechSelection,
} from "./routes/audio-speech.js";

const MAX_BYTES = 1024 * 1024;
async function send(socket: WebSocket, text: string): Promise<void> {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + Buffer.byteLength(text) > MAX_BYTES
  )
    throw new Error("speech socket backpressure");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("speech slow consumer")), 10_000);
    timer.unref();
    socket.send(text, (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
/** Reuses ws plus the gateway's configured proxy; does not pool authenticated connections. */
export function createSpeechSocketConnector(
  proxy?: Parameters<typeof codexWebSocketAgent>[0],
): SpeechSocketConnector {
  return async ({ url, headers, signal }) => {
    if (new URL(url).protocol !== "wss:") throw new Error("speech upstream must use wss");
    signal.throwIfAborted();
    const ws = new WebSocket(url, {
      headers,
      agent: codexWebSocketAgent(proxy),
      maxPayload: MAX_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    const queue = speechQueue<string | Uint8Array>(64, 4 * MAX_BYTES, () => ws.terminate());
    const close = () => {
      signal.removeEventListener("abort", abort);
      queue.end();
      ws.terminate();
    };
    const abort = () => {
      queue.end(new Error("speech aborted"));
      ws.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    ws.on("message", (data, binary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      queue.push(binary ? new Uint8Array(buffer) : buffer.toString("utf8"));
    });
    ws.on("error", () => queue.end(new Error("speech upstream socket failed")));
    ws.on("close", () => {
      signal.removeEventListener("abort", abort);
      queue.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", () => reject(new Error("speech upstream connection failed")));
        ws.once("close", () => reject(new Error("speech upstream closed during handshake")));
        ws.once("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          reject(new Error(`speech upstream rejected handshake (${response.statusCode ?? 502})`));
        });
      });
    } catch (error) {
      close();
      throw error;
    }
    return { messages: queue, send: (text) => send(ws, text), close };
  };
}
export interface AudioTtsWebSocketOptions {
  server: RealtimeWebSocketUpgradeServer;
  deps: AudioSpeechRouteDeps;
  maxConnections?: number;
  idleTimeoutMs?: number;
  sessionTimeoutMs?: number;
}
export function isAudioTtsWebSocketPath(raw: string | undefined): boolean {
  try {
    return new URL(raw ?? "", "http://helm.internal").pathname === "/v1/audio/tts";
  } catch {
    return false;
  }
}
function reject(socket: Duplex, status: number) {
  const body = JSON.stringify({
    error: { code: "speech_admission_failed", message: "speech websocket admission failed" },
  });
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
export function mountAudioTtsWebSocket({
  server,
  deps,
  maxConnections = 128,
  idleTimeoutMs = 30_000,
  sessionTimeoutMs = 120_000,
}: AudioTtsWebSocketOptions) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const active = new Set<AbortController>();
  let closing = false;
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isAudioTtsWebSocketPath(request.url)) return;
    if (closing || active.size >= maxConnections) {
      reject(socket, 503);
      return;
    }
    const abort = new AbortController();
    active.add(abort);
    const earlyClose = () => abort.abort();
    socket.once("close", earlyClose);
    void (async () => {
      let lease: Awaited<ReturnType<typeof acquireSpeechLease>> | undefined,
        ws: WebSocket | undefined,
        session: SpeechSession | undefined,
        selection: SpeechSelection | undefined,
        usage: MediaSpeechUsage | undefined;
      let done = false,
        started = false;
      const traceId = crypto.randomUUID();
      let identity: Awaited<ReturnType<typeof admitSpeechIdentity>> | undefined;
      const timer = setTimeout(() => abort.abort(), sessionTimeoutMs);
      timer.unref();
      let idle: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => abort.abort(), idleTimeoutMs);
        idle.unref();
      };
      const end = async (status: "completed" | "error" | "canceled") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(idle);
        active.delete(abort);
        socket.off("close", earlyClose);
        abort.abort();
        session?.close();
        if (ws?.readyState === WebSocket.OPEN) {
          const closingSocket = ws;
          closingSocket.close(status === "completed" ? 1000 : 1011);
          const forceClose = setTimeout(() => closingSocket.terminate(), 1000);
          forceClose.unref();
          closingSocket.once("close", () => clearTimeout(forceClose));
        } else if (!ws) socket.destroy();
        try {
          if (identity && selection) {
            if (identity.caps?.budget && deps.settleBudget)
              await deps.settleBudget(
                identity.keyId,
                identity.caps.budget,
                { requests: 1, tokens: 0, costUsd: null },
                Date.now(),
              );
            await deps.record?.({ identity, selection, usage, status, traceId });
          }
        } finally {
          await lease?.release();
        }
      };
      abort.signal.addEventListener(
        "abort",
        () => {
          void end("canceled").catch(() => {});
        },
        { once: true },
      );
      try {
        const header = request.headers.authorization;
        identity = await admitSpeechIdentity(
          deps,
          /^Bearer\s+(.+)$/.exec(header ?? "")?.[1] ?? null,
          request.headers["user-agent"] ?? null,
        );
        abort.signal.throwIfAborted();
        lease = await acquireSpeechLease(deps, identity, abort.signal);
        if (done || abort.signal.aborted) {
          await lease.release();
          return;
        }
        lease.signal.addEventListener("abort", () => abort.abort(), { once: true });
        ws = await new Promise<WebSocket>((resolve, rejectUpgrade) => {
          try {
            wss.handleUpgrade(request, socket, head, resolve);
          } catch (error) {
            rejectUpgrade(error);
          }
        });
        const client = ws;
        const account = identity;
        resetIdle();
        const commands = speechQueue<string>(32, 128 * 1024, () => abort.abort());
        client.on("message", (data, binary) => {
          resetIdle();
          if (binary) {
            void end("error").catch(() => {});
            return;
          }
          commands.push(data.toString());
        });
        client.on("close", () => {
          commands.end();
          void end("canceled").catch(() => {});
        });
        client.on("error", () => {
          commands.end();
          void end("error").catch(() => {});
        });
        for await (const raw of commands) {
          if (done) break;
          const parsed = MediaSpeechCommandSchema.safeParse(JSON.parse(raw));
          if (!parsed.success)
            throw new SpeechAdmissionError(400, "invalid_command", "invalid speech command");
          const command = parsed.data;
          if (command.type === "start") {
            if (started)
              throw new SpeechAdmissionError(
                400,
                "invalid_order",
                "speech session already started",
              );
            started = true;
            selection = await resolveSpeechSelection(deps, command.request.model, account);
            if (!selection.client.openSpeechSession)
              throw new SpeechAdmissionError(
                422,
                "unsupported_profile",
                "speech sessions are unavailable",
              );
            session = await selection.client.openSpeechSession(
              { ...command.request, model: selection.model },
              { signal: lease.signal },
            );
            if (done) {
              session.close();
              break;
            }
            const current = session;
            void (async () => {
              try {
                for await (const event of current.events) {
                  if (done) break;
                  resetIdle();
                  if (event.type === "usage")
                    usage = {
                      usage_characters:
                        event.usage.usage_characters === undefined
                          ? usage?.usage_characters
                          : (usage?.usage_characters ?? 0) + event.usage.usage_characters,
                      usage_voice_count:
                        event.usage.usage_voice_count === undefined
                          ? usage?.usage_voice_count
                          : (usage?.usage_voice_count ?? 0) + event.usage.usage_voice_count,
                    };
                  await send(
                    client,
                    JSON.stringify(
                      event.type === "audio"
                        ? { ...event, audio: Buffer.from(event.audio).toString("base64") }
                        : event,
                    ),
                  );
                  if (event.type === "error") {
                    await end("error");
                    return;
                  }
                  if (event.type === "completed") {
                    await end("completed");
                    return;
                  }
                }
                if (!done) await end("error");
              } catch {
                if (!done) {
                  await send(
                    client,
                    JSON.stringify({
                      type: "error",
                      code: "upstream_error",
                      message: "speech session failed",
                    }),
                  ).catch(() => {});
                  await end("error");
                }
              }
            })().catch(() => {});
          } else {
            if (!session)
              throw new SpeechAdmissionError(
                400,
                "invalid_order",
                "start the speech session first",
              );
            if (
              (command.type === "flush" || command.type === "cancel") &&
              !session.capabilities[command.type]
            ) {
              await send(
                client,
                JSON.stringify({
                  type: "error",
                  code: "unsupported_command",
                  message: `${command.type} is unsupported for this speech profile`,
                }),
              );
              continue;
            }
            if (command.type === "append") await session.append(command.text);
            else await session[command.type]();
          }
        }
      } catch (error) {
        if (!ws && !socket.destroyed)
          reject(socket, error instanceof SpeechAdmissionError ? error.status : 503);
        if (ws?.readyState === WebSocket.OPEN)
          await send(
            ws,
            JSON.stringify({
              type: "error",
              code: error instanceof SpeechAdmissionError ? error.code : "speech_failed",
              message:
                error instanceof SpeechAdmissionError ? error.message : "speech session failed",
            }),
          ).catch(() => {});
        await end("error");
      }
    })().catch(() => {
      abort.abort();
      socket.destroy();
    });
  };
  server.on("upgrade", upgrade);
  return {
    async close() {
      closing = true;
      server.off("upgrade", upgrade);
      for (const controller of active) controller.abort();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
