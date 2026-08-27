import { randomUUID } from "node:crypto";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  isCodexResponsesRecoverableDisconnectCode,
  type ResponseWorkAdmission,
  readSSE,
  runtimeMemoryBudget,
  runtimeResponseWorkAdmission,
} from "@helm/core";
import WebSocket, { WebSocketServer } from "ws";
import { normalizeOpenAICodexClientVersion } from "./oauth/codex-client-version.js";
import {
  CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER,
  CODEX_RESPONSES_WEBSOCKET_RECOVERY_PROOF_HEADER,
  markResponsesWebSocketRequestParsed,
  trackResponsesWebSocketRequest,
} from "./responses-websocket-internal.js";
import {
  type BodyMemoryAdmission,
  createBodyMemoryAdmission,
  RequestAdmissionError,
  requestAdmissionError,
} from "./runtime/memory-admission.js";

const RESPONSES_WEBSOCKET_PATHS = new Set(["/v1/responses", "/responses", "/openai/v1/responses"]);
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 6_000;
const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_PREFLIGHT_REQUESTS = 128;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const ERROR_RESPONSE_HEADERS = new Set([
  "openai-model",
  "retry-after",
  "x-models-etag",
  "x-openai-model",
  "x-request-id",
]);

type AppFetch = (request: Request) => Response | Promise<Response>;

export interface ResponsesWebSocketBridge {
  close(): Promise<void>;
}

let responsesPreflightPending = 0;

export function responsesWebSocketPreflightPending(): number {
  return responsesPreflightPending;
}

export interface ResponsesWebSocketBridgeOptions {
  server: ResponsesWebSocketUpgradeServer;
  fetch: AppFetch;
  closeSession?: (sessionId: string) => void | Promise<void>;
  sessionProof?: string;
  memoryAdmission?: BodyMemoryAdmission;
  /** Optional test/embedding override for bytes retained by `ws` before `message`. */
  ingressAdmission?: BodyMemoryAdmission;
  responseWorkAdmission?: ResponseWorkAdmission;
  /** Optional test/embedding limit for bytes retained by `ws` before `message`. */
  maxPayloadBytes?: number;
  /** Optional test/embedding limit for pending authenticated upgrades. */
  maxPreflightRequests?: number;
  /** Optional test/embedding limit for one upstream SSE frame. */
  maxSseFrameBytes?: number;
  preflightTimeoutMs?: number;
  /** Optional test/embedding limit for an inactive Responses websocket session. */
  idleSessionTimeoutMs?: number;
}

export interface ResponsesWebSocketUpgradeServer {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  off(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

interface UpgradeMetadata {
  modelsEtag: string | null;
  reasoningIncluded: boolean;
}

class WebSocketRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isResponsesWebSocketPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return RESPONSES_WEBSOCKET_PATHS.has(new URL(url, "http://localhost").pathname);
  } catch {
    return false;
  }
}

function fetchHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function requestUrl(request: IncomingMessage, pathname?: string): URL {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const scheme =
    typeof forwardedProto === "string" && forwardedProto.split(",")[0]?.trim() === "https"
      ? "https"
      : "http";
  const host = request.headers.host ?? "helm.internal";
  return new URL(pathname ?? request.url ?? "/v1/responses", `${scheme}://${host}`);
}

function codexClientVersion(request: IncomingMessage): string | null {
  let raw: string | null = null;
  for (const name of ["version", "x-codex-client-version"] as const) {
    const value = request.headers[name];
    const explicit = Array.isArray(value) ? value[0] : value;
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      raw = explicit.trim();
      break;
    }
  }
  if (raw === null) {
    const userAgent = request.headers["user-agent"];
    if (typeof userAgent !== "string") return null;
    const match = /\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|\(|$)/.exec(userAgent);
    raw = match?.[1] ?? null;
  }
  if (raw === null) return null;
  const normalized = normalizeOpenAICodexClientVersion(raw);
  if (normalized === null) {
    throw new WebSocketRequestError(
      400,
      "invalid_client_version",
      "version must be a valid semantic version",
    );
  }
  return normalized;
}

function normalizedFetchHeaders(request: IncomingMessage): Headers {
  const headers = fetchHeaders(request);
  headers.delete("version");
  headers.delete("x-codex-client-version");
  const clientVersion = codexClientVersion(request);
  if (clientVersion !== null) headers.set("version", clientVersion);
  return headers;
}

function websocketRequestBody(data: WebSocket.RawData): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    throw new WebSocketRequestError(400, "invalid_websocket_request", "malformed JSON message");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { type?: unknown }).type !== "response.create"
  ) {
    throw new WebSocketRequestError(
      400,
      "invalid_websocket_request",
      "expected a response.create websocket message",
    );
  }
  const body = { ...(parsed as Record<string, unknown>) };
  delete body.type;
  body.stream = true;
  return body;
}

function selectedResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      ERROR_RESPONSE_HEADERS.has(lower) ||
      lower.startsWith("x-codex-") ||
      lower.startsWith("x-ratelimit-")
    ) {
      selected[lower] = value;
    }
  });
  return selected;
}

function errorShape(body: unknown, fallback: string): Record<string, unknown> {
  const records: Record<string, unknown>[] = [];
  let current = body;
  while (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    records.push(record);
    current = record.error;
  }
  const stringField = (name: "type" | "code" | "message"): string | null => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const value = records[index]?.[name];
      if (typeof value === "string" && value.length > 0) {
        if (name !== "type" || value !== "error") return value;
      }
    }
    return null;
  };
  return {
    type: stringField("type") ?? "upstream_error",
    code: stringField("code") ?? "upstream_error",
    message: stringField("message") ?? fallback,
  };
}

async function responseErrorEnvelope(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = errorShape(body, `HTTP ${response.status}`);
  const recoverableCode = recoverableDisconnectCode(body);
  if (recoverableCode !== null) error.code = recoverableCode;
  return {
    type: "error",
    status: response.status,
    status_code: response.status,
    error,
    headers: selectedResponseHeaders(response.headers),
  };
}

function localErrorEnvelope(error: unknown): Record<string, unknown> {
  if (error instanceof RequestAdmissionError) {
    return {
      type: "error",
      status: error.status,
      status_code: error.status,
      error: {
        type: "server_error",
        code: error.code,
        message: error.message,
      },
      headers: { "retry-after": "1" },
    };
  }
  if (error instanceof WebSocketRequestError) {
    return {
      type: "error",
      status: error.status,
      status_code: error.status,
      error: {
        type: "invalid_request_error",
        code: error.code,
        message: error.message,
      },
      headers: {},
    };
  }
  return {
    type: "error",
    status: 500,
    status_code: 500,
    error: {
      type: "internal_error",
      code: "websocket_bridge_error",
      message: error instanceof Error ? error.message : "websocket bridge failed",
    },
    headers: {},
  };
}

function sendText(socket: WebSocket, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("websocket connection is closed"));
      return;
    }
    socket.send(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sendEnvelope(socket: WebSocket, envelope: Record<string, unknown>): Promise<void> {
  await sendText(socket, JSON.stringify(envelope));
}

function recoverableDisconnectCode(value: unknown): string | null {
  let current = value;
  while (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    if (isCodexResponsesRecoverableDisconnectCode(record.code)) return record.code as string;
    current =
      record.error !== undefined
        ? record.error
        : record.provider_raw !== undefined
          ? record.provider_raw
          : null;
  }
  return null;
}

function closeForFullHistoryRecovery(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.close(1012, "upstream response stream disconnected");
}

function websocketPayload(event: string | undefined, data: string): string | null {
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  if (event === undefined) return data;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), type: event });
    }
  } catch {
    return data;
  }
  return data;
}

async function forwardResponse(
  socket: WebSocket,
  request: IncomingMessage,
  fetch: AppFetch,
  data: WebSocket.RawData,
  signal: AbortSignal,
  sessionId: string,
  sessionProof: string | undefined,
  materialized: () => void,
  maxSseFrameBytes: number,
  responseWorkAdmission: ResponseWorkAdmission,
): Promise<boolean> {
  const headers = normalizedFetchHeaders(request);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set(CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER, sessionId);
  if (sessionProof !== undefined) {
    headers.set(CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER, sessionProof);
  }
  const requestBody = websocketRequestBody(data);
  const internalRequest = new Request(requestUrl(request), {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal,
  });
  trackResponsesWebSocketRequest(internalRequest, materialized);
  let response: Response;
  try {
    response = await fetch(internalRequest);
  } finally {
    markResponsesWebSocketRequestParsed(internalRequest);
  }
  const trustedRecovery =
    sessionProof !== undefined &&
    response.headers.get(CODEX_RESPONSES_WEBSOCKET_RECOVERY_PROOF_HEADER) === sessionProof;
  if (!response.ok) {
    const envelope = await responseErrorEnvelope(response);
    if (trustedRecovery && recoverableDisconnectCode(envelope) !== null) {
      closeForFullHistoryRecovery(socket);
      return true;
    }
    await sendEnvelope(socket, envelope);
    return true;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = response.body;
  if (body === null || !contentType.includes("text/event-stream")) {
    if (body !== null) void body.cancel().catch(() => {});
    throw new Error("Responses websocket bridge expected a text/event-stream response");
  }

  let terminalType: unknown;
  for await (const frame of readSSE(body, maxSseFrameBytes, responseWorkAdmission)) {
    const payload = websocketPayload(frame.event, frame.data);
    if (payload === null) continue;
    let type: unknown;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown };
      type = parsed.type;
      if (trustedRecovery && recoverableDisconnectCode(parsed) !== null) {
        void body.cancel().catch(() => {});
        closeForFullHistoryRecovery(socket);
        return true;
      }
    } catch {
      type = undefined;
    }
    await sendText(socket, payload);
    if (
      type === "response.completed" ||
      type === "response.cancelled" ||
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "error"
    ) {
      terminalType = type;
      break;
    }
  }
  if (terminalType !== undefined) {
    void body.cancel().catch(() => {});
    return terminalType !== "response.completed" && terminalType !== "response.incomplete";
  }
  if (!signal.aborted) {
    throw new Error("Responses stream ended before a terminal event");
  }
  return false;
}

function signalsReasoningIncluded(value: string | null): boolean {
  if (value === null) return false;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

function fetchResponseUntilAbort(fetch: AppFetch, request: Request): Promise<Response> {
  const pending = Promise.resolve().then(() => {
    request.signal.throwIfAborted();
    return fetch(request);
  });
  const cancelBody = (response: Response) => {
    if (response.body !== null) void response.body.cancel().catch(() => {});
  };
  if (request.signal.aborted) {
    void pending.then(cancelBody, () => {});
    return Promise.reject(request.signal.reason);
  }
  return new Promise<Response>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(request.signal.reason);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (response) => {
        request.signal.removeEventListener("abort", onAbort);
        if (aborted) cancelBody(response);
        else resolve(response);
      },
      (error: unknown) => {
        request.signal.removeEventListener("abort", onAbort);
        if (!aborted) reject(error);
      },
    );
  });
}

async function preflightUpgrade(
  request: IncomingMessage,
  fetch: AppFetch,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ response: Response; metadata: UpgradeMetadata | null }> {
  const modelsUrl = requestUrl(request, "/v1/models");
  const clientVersion = codexClientVersion(request);
  if (clientVersion !== null) modelsUrl.searchParams.set("client_version", clientVersion);
  const requestModels = (url: URL, requestSignal: AbortSignal) =>
    fetchResponseUntilAbort(
      fetch,
      new Request(url, {
        method: "GET",
        headers: normalizedFetchHeaders(request),
        signal: requestSignal,
      }),
    );
  const deadline = AbortSignal.timeout(timeoutMs);
  const versionedSignal = AbortSignal.any([signal, deadline]);
  const requestFallback = () =>
    requestModels(
      requestUrl(request, "/v1/models"),
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
  let response: Response;
  try {
    response = await requestModels(modelsUrl, versionedSignal);
  } catch (error) {
    if (signal.aborted || !deadline.aborted || clientVersion === null) throw error;
    response = await requestFallback();
  }
  if (response.status === 504 && clientVersion !== null && !signal.aborted) {
    if (response.body !== null) await response.body.cancel().catch(() => {});
    response = await requestFallback();
  }
  if (!response.ok) return { response, metadata: null };
  const metadata = {
    modelsEtag: response.headers.get("etag"),
    reasoningIncluded: signalsReasoningIncluded(response.headers.get("x-reasoning-included")),
  };
  if (response.body !== null) await response.body.cancel().catch(() => {});
  return { response, metadata };
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const payload =
    body.length > 0 ? body : JSON.stringify({ error: { message: "upgrade rejected" } });
  const statusText = STATUS_CODES[response.status] ?? "Error";
  const retryAfter = response.headers.get("retry-after");
  socket.end(
    [
      `HTTP/1.1 ${response.status} ${statusText}`,
      "Connection: close",
      "Content-Type: application/json",
      ...(retryAfter === null ? [] : [`Retry-After: ${retryAfter}`]),
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "",
      payload,
    ].join("\r\n"),
  );
}

export function installResponsesWebSocketBridge({
  server,
  fetch,
  closeSession,
  sessionProof,
  memoryAdmission,
  ingressAdmission,
  responseWorkAdmission,
  maxPayloadBytes,
  maxPreflightRequests,
  maxSseFrameBytes,
  preflightTimeoutMs,
  idleSessionTimeoutMs,
}: ResponsesWebSocketBridgeOptions): ResponsesWebSocketBridge {
  const memoryBudget = runtimeMemoryBudget();
  const admission =
    memoryAdmission ??
    createBodyMemoryAdmission({
      activeRequestBytes: memoryBudget.activeRequestBytes,
      jsonAmplification: memoryBudget.jsonAmplification,
    });
  const ingress =
    ingressAdmission ??
    createBodyMemoryAdmission({
      activeRequestBytes: memoryBudget.websocketIngressBytes,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
    });
  const responseWork = responseWorkAdmission ?? runtimeResponseWorkAdmission();
  const websocketMaxPayloadBytes = Math.max(
    1,
    Math.floor(maxPayloadBytes ?? memoryBudget.responseCaptureBytes),
  );
  const websocketMaxPreflightRequests = Math.max(
    1,
    Math.floor(maxPreflightRequests ?? DEFAULT_MAX_PREFLIGHT_REQUESTS),
  );
  const websocketMaxSseFrameBytes = Math.max(
    1,
    Math.floor(maxSseFrameBytes ?? memoryBudget.responseCaptureBytes),
  );
  const websocketIdleSessionTimeoutMs = Math.max(
    1,
    Math.floor(idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS),
  );
  const metadataByRequest = new WeakMap<IncomingMessage, UpgradeMetadata>();
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: websocketMaxPayloadBytes,
  });
  let closed = false;
  const preflightControllers = new Set<AbortController>();

  websocketServer.on("headers", (headers, request) => {
    const metadata = metadataByRequest.get(request);
    if (metadata?.reasoningIncluded) headers.push("x-reasoning-included: true");
    if (metadata?.modelsEtag) headers.push(`x-models-etag: ${metadata.modelsEtag}`);
  });

  websocketServer.on("connection", (socket, request) => {
    const controller = new AbortController();
    const sessionId = randomUUID();
    let sessionClosed = false;
    let processing = false;
    let activeTurnController: AbortController | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const closeUpstreamSession = async () => {
      if (sessionClosed) return;
      sessionClosed = true;
      await Promise.resolve()
        .then(() => closeSession?.(sessionId))
        .catch(() => {});
    };
    const abort = () => {
      clearIdleTimer();
      controller.abort();
      activeTurnController?.abort();
      void closeUpstreamSession();
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (processing) return;
        abort();
        if (socket.readyState === WebSocket.OPEN)
          socket.close(1001, "websocket session idle timeout");
      }, websocketIdleSessionTimeoutMs);
      idleTimer.unref?.();
    };
    socket.on("close", abort);
    socket.on("error", abort);
    armIdleTimer();
    socket.on("message", (data) => {
      if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
      if (processing) {
        abort();
        socket.close(1008, "one active response per connection");
        return;
      }
      const bytes = Array.isArray(data)
        ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
        : data.byteLength;
      // Size/capacity checks are disabled. Admission remains only so database
      // maintenance can pause new work and drain active leases.
      const ingressAcquired = ingress.acquire(bytes);
      if (!ingressAcquired.ok) {
        const error = requestAdmissionError(ingressAcquired.admission);
        void sendEnvelope(socket, localErrorEnvelope(error)).catch(() => {});
        return;
      }
      const acquired = admission.acquire(bytes);
      if (!acquired.ok) {
        ingressAcquired.lease.release();
        const error = requestAdmissionError(acquired.admission);
        void sendEnvelope(socket, localErrorEnvelope(error)).catch(() => {});
        return;
      }
      processing = true;
      // A previous failed turn may have torn down the provider session. The
      // downstream WebSocket remains reusable, so the next turn gets a fresh
      // upstream-session cleanup lifecycle.
      sessionClosed = false;
      clearIdleTimer();
      const turnController = new AbortController();
      activeTurnController = turnController;
      const abortTurn = () => turnController.abort();
      controller.signal.addEventListener("abort", abortTurn, { once: true });
      void (async () => {
        try {
          const invalidatesSession = await forwardResponse(
            socket,
            request,
            fetch,
            data,
            turnController.signal,
            sessionId,
            sessionProof,
            acquired.lease.materialized,
            websocketMaxSseFrameBytes,
            responseWork,
          );
          if (invalidatesSession) {
            void closeUpstreamSession();
          }
        } catch (error) {
          if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
          await sendEnvelope(socket, localErrorEnvelope(error)).catch(() => {});
          void closeUpstreamSession();
        } finally {
          turnController.abort();
          controller.signal.removeEventListener("abort", abortTurn);
          if (activeTurnController === turnController) activeTurnController = null;
          processing = false;
          acquired.lease.release();
          ingressAcquired.lease.release();
          if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) armIdleTimer();
        }
      })();
    });
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isResponsesWebSocketPath(request.url)) return;
    if (websocketServer.clients.size + preflightControllers.size >= websocketMaxPreflightRequests) {
      const onRejectedSocketError = () => socket.destroy();
      socket.once("error", onRejectedSocketError);
      void rejectUpgrade(
        socket,
        new Response(
          JSON.stringify({
            type: "error",
            status: 503,
            status_code: 503,
            error: {
              type: "server_error",
              code: "websocket_preflight_capacity_exceeded",
              message: "websocket upgrade capacity is temporarily exhausted",
            },
            headers: { "retry-after": "1" },
          }),
          { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } },
        ),
      ).catch(() => socket.destroy());
      return;
    }
    const preflightController = new AbortController();
    preflightControllers.add(preflightController);
    responsesPreflightPending += 1;
    const onPreflightSocketError = () => {
      preflightController.abort();
      socket.destroy();
    };
    const onPreflightSocketClose = () => preflightController.abort();
    socket.on("error", onPreflightSocketError);
    socket.on("close", onPreflightSocketClose);
    void preflightUpgrade(
      request,
      fetch,
      preflightController.signal,
      Math.max(1, preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS),
    )
      .then(async ({ response, metadata }) => {
        if (closed || socket.destroyed) {
          socket.destroy();
          return;
        }
        if (metadata === null) {
          await rejectUpgrade(socket, response);
          return;
        }
        metadataByRequest.set(request, metadata);
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          websocketServer.emit("connection", websocket, request);
        });
      })
      .catch(async (error: unknown) => {
        if (socket.destroyed) return;
        const envelope = localErrorEnvelope(error);
        const status =
          typeof envelope.status === "number" && Number.isInteger(envelope.status)
            ? envelope.status
            : 500;
        await rejectUpgrade(
          socket,
          new Response(JSON.stringify(envelope), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      })
      .finally(() => {
        preflightControllers.delete(preflightController);
        responsesPreflightPending -= 1;
        socket.off("error", onPreflightSocketError);
        socket.off("close", onPreflightSocketClose);
      });
  };
  server.on("upgrade", onUpgrade);

  return {
    async close() {
      if (closed) return;
      closed = true;
      server.off("upgrade", onUpgrade);
      for (const controller of preflightControllers) controller.abort();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => {
        websocketServer.close(() => resolve());
      });
    },
  };
}
