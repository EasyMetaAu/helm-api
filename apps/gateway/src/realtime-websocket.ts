import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { type RealtimeSidebandTarget, runtimeMemoryBudget } from "@helm/core";
import WebSocket, { WebSocketServer } from "ws";
import { codexWebSocketAgent } from "./codex-responses-websocket.js";
import type { RealtimeCallRegistry } from "./realtime-call-registry.js";
import { type BodyMemoryAdmission, createBodyMemoryAdmission } from "./runtime/memory-admission.js";

const DEFAULT_MAX_REALTIME_CONNECTIONS = 128;
const DEFAULT_REALTIME_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface RealtimeWebSocketBridge {
  close(): Promise<void>;
}

export interface RealtimeWebSocketUpgradeServer {
  on(event: "upgrade", listener: UpgradeListener): unknown;
  off(event: "upgrade", listener: UpgradeListener): unknown;
}

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface RealtimeWebSocketBridgeOptions {
  server: RealtimeWebSocketUpgradeServer;
  registry: RealtimeCallRegistry;
  resolveKey(credential: string | null): Promise<string | null>;
  memoryAdmission?: BodyMemoryAdmission;
  /** Optional test/embedding limit for bytes retained by `ws` before `message`. */
  maxPayloadBytes?: number;
  /** Optional test/embedding limit for active plus preflight realtime sessions. */
  maxConnections?: number;
  /** Optional test/embedding limit for an inactive realtime websocket session. */
  idleSessionTimeoutMs?: number;
}

interface PendingUpstream {
  socket: WebSocket;
  pending: Array<{ data: WebSocket.RawData; isBinary: boolean }>;
  stopQueue(): void;
}

class UpstreamUpgradeError extends Error {
  constructor(readonly status: number) {
    super(`realtime upstream websocket rejected the upgrade (${status})`);
  }
}

function callIdFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, "http://helm.internal");
    if (url.pathname === "/v1/realtime") return url.searchParams.get("call_id");
    const live = /^\/v1\/live\/([^/]+)$/.exec(url.pathname);
    return live ? decodeURIComponent(live[1] ?? "") : null;
  } catch {
    return null;
  }
}

export function isRealtimeWebSocketPath(raw: string | undefined): boolean {
  return callIdFromUrl(raw) !== null;
}

function bearer(request: IncomingMessage): string | null {
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? (/^Bearer\s+(.+)$/.exec(value)?.[1] ?? null) : null;
}

async function rejectUpgrade(socket: Duplex, status: number, message: string): Promise<void> {
  const body = JSON.stringify({ error: { type: "invalid_request_error", message } });
  const response = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
  await new Promise<void>((resolve) => socket.end(response, resolve));
}

function rawBytes(data: WebSocket.RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}

function forwardedCloseCode(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

async function openUpstream(
  target: RealtimeSidebandTarget,
  maxPayload: number,
): Promise<PendingUpstream> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const headers = await target.headers();
      return await new Promise<PendingUpstream>((resolve, reject) => {
        const pending: PendingUpstream["pending"] = [];
        let pendingBytes = 0;
        const socket = new WebSocket(target.url, {
          headers,
          agent: codexWebSocketAgent(target.proxy),
          perMessageDeflate: false,
          maxPayload,
          handshakeTimeout: 60_000,
        });
        const queue = (data: WebSocket.RawData, isBinary: boolean) => {
          pendingBytes += rawBytes(data);
          if (maxPayload > 0 && pendingBytes > maxPayload) {
            socket.close(1009, "pending response too large");
            return;
          }
          pending.push({ data, isBinary });
        };
        socket.on("message", queue);
        socket.once("open", () =>
          resolve({
            socket,
            pending,
            stopQueue: () => socket.off("message", queue),
          }),
        );
        socket.once("unexpected-response", (request, response) => {
          response.resume();
          request.socket?.destroy();
          reject(new UpstreamUpgradeError(response.statusCode ?? 502));
        });
        socket.once("error", reject);
      });
    } catch (cause) {
      if (
        attempt === 0 &&
        cause instanceof UpstreamUpgradeError &&
        cause.status === 401 &&
        target.onUnauthorized
      ) {
        target.onUnauthorized();
        continue;
      }
      if (cause instanceof UpstreamUpgradeError && cause.status === 401) {
        target.onCredentialFailure?.(401);
      }
      throw cause;
    }
  }
}

export function installRealtimeWebSocketBridge(
  options: RealtimeWebSocketBridgeOptions,
): RealtimeWebSocketBridge {
  const memoryBudget = runtimeMemoryBudget();
  const admission =
    options.memoryAdmission ??
    createBodyMemoryAdmission({
      activeRequestBytes: memoryBudget.websocketIngressBytes,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
    });
  const websocketMaxPayloadBytes = Math.max(
    1,
    Math.floor(options.maxPayloadBytes ?? memoryBudget.responseCaptureBytes),
  );
  const websocketMaxConnections = Math.max(
    1,
    Math.floor(options.maxConnections ?? DEFAULT_MAX_REALTIME_CONNECTIONS),
  );
  const websocketIdleSessionTimeoutMs = Math.max(
    1,
    Math.floor(options.idleSessionTimeoutMs ?? DEFAULT_REALTIME_IDLE_TIMEOUT_MS),
  );
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: websocketMaxPayloadBytes,
  });
  const upstreams = new Set<WebSocket>();
  const preflightControllers = new Set<AbortController>();
  let closed = false;

  const bind = (client: WebSocket, pending: PendingUpstream) => {
    const upstream = pending.socket;
    pending.stopQueue();
    upstreams.add(upstream);
    let closing = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const closeBoth = (code: number, reason: string) => {
      if (closing) return;
      closing = true;
      clearIdleTimer();
      const forwardedCode = forwardedCloseCode(code);
      if (client.readyState === WebSocket.OPEN) client.close(forwardedCode, reason);
      else if (client.readyState !== WebSocket.CLOSED) client.terminate();
      if (upstream.readyState === WebSocket.OPEN) upstream.close(forwardedCode, reason);
      else if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        closeBoth(1001, "realtime websocket session idle timeout");
      }, websocketIdleSessionTimeoutMs);
      idleTimer.unref?.();
    };
    const relay = (destination: WebSocket, data: WebSocket.RawData, isBinary: boolean) => {
      // Size/capacity checks are disabled; maintenance pause remains.
      const acquired = admission.acquire(rawBytes(data));
      if (!acquired.ok) {
        closeBoth(1013, "database maintenance in progress");
        return;
      }
      if (destination.readyState !== WebSocket.OPEN) {
        acquired.lease.release();
        closeBoth(1011, "realtime peer closed");
        return;
      }
      destination.send(data, { binary: isBinary }, (error) => {
        acquired.lease.release();
        if (error) closeBoth(1011, "realtime relay failed");
      });
    };
    client.on("message", (data, isBinary) => {
      armIdleTimer();
      relay(upstream, data, isBinary);
    });
    upstream.on("message", (data, isBinary) => {
      armIdleTimer();
      relay(client, data, isBinary);
    });
    client.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    client.on("error", () => closeBoth(1011, "realtime client error"));
    upstream.on("error", () => closeBoth(1011, "realtime upstream error"));
    upstream.on("close", () => {
      clearIdleTimer();
      upstreams.delete(upstream);
    });
    armIdleTimer();
    for (const frame of pending.pending) relay(client, frame.data, frame.isBinary);
  };

  const onUpgrade: UpgradeListener = (request, socket, head) => {
    const callId = callIdFromUrl(request.url);
    if (callId === null) return;
    if (websocketServer.clients.size + preflightControllers.size >= websocketMaxConnections) {
      const onRejectedSocketError = () => socket.destroy();
      socket.once("error", onRejectedSocketError);
      void rejectUpgrade(socket, 503, "realtime websocket capacity is temporarily exhausted")
        .catch(() => socket.destroy())
        .finally(() => socket.off("error", onRejectedSocketError));
      return;
    }
    const preflightController = new AbortController();
    preflightControllers.add(preflightController);
    const onSocketError = () => {
      preflightController.abort();
      socket.destroy();
    };
    const onSocketClose = () => preflightController.abort();
    socket.on("error", onSocketError);
    socket.on("close", onSocketClose);
    void (async () => {
      const keyId = await options.resolveKey(bearer(request));
      if (!keyId) {
        await rejectUpgrade(socket, 401, "missing or invalid API key");
        return;
      }
      const call = options.registry.take(callId, keyId);
      if (!call.ok) {
        await rejectUpgrade(socket, 404, "realtime call not found");
        return;
      }
      let upstream: PendingUpstream;
      try {
        upstream = await openUpstream(call.target, websocketMaxPayloadBytes);
      } catch (cause) {
        options.registry.put(callId, keyId, call.target);
        throw cause;
      }
      if (closed || socket.destroyed) {
        upstream.socket.terminate();
        options.registry.put(callId, keyId, call.target);
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        websocketServer.emit("connection", client, request);
        bind(client, upstream);
      });
    })()
      .catch(async (cause: unknown) => {
        if (socket.destroyed) return;
        const message = cause instanceof Error ? cause.message : "realtime websocket failed";
        await rejectUpgrade(socket, 502, message).catch(() => socket.destroy());
      })
      .finally(() => {
        preflightControllers.delete(preflightController);
        socket.off("error", onSocketError);
        socket.off("close", onSocketClose);
      });
  };
  options.server.on("upgrade", onUpgrade);

  return {
    async close() {
      if (closed) return;
      closed = true;
      options.server.off("upgrade", onUpgrade);
      for (const controller of preflightControllers) controller.abort();
      for (const socket of websocketServer.clients) socket.terminate();
      for (const socket of upstreams) socket.terminate();
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    },
  };
}
