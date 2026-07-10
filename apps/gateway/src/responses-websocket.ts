import { randomUUID } from "node:crypto";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER, readSSE } from "@helm/core";
import WebSocket, { WebSocketServer } from "ws";
import { normalizeOpenAICodexClientVersion } from "./oauth/codex-client-version.js";
import { CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER } from "./responses-websocket-internal.js";

const RESPONSES_WEBSOCKET_PATHS = new Set(["/v1/responses", "/responses", "/openai/v1/responses"]);

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

export interface ResponsesWebSocketBridgeOptions {
  server: ResponsesWebSocketUpgradeServer;
  fetch: AppFetch;
  closeSession?: (sessionId: string) => void | Promise<void>;
  sessionProof?: string;
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
  return {
    type: "error",
    status: response.status,
    status_code: response.status,
    error: errorShape(body, `HTTP ${response.status}`),
    headers: selectedResponseHeaders(response.headers),
  };
}

function localErrorEnvelope(error: unknown): Record<string, unknown> {
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
): Promise<boolean> {
  const headers = normalizedFetchHeaders(request);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set(CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER, sessionId);
  if (sessionProof !== undefined) {
    headers.set(CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER, sessionProof);
  }
  const response = await fetch(
    new Request(requestUrl(request), {
      method: "POST",
      headers,
      body: JSON.stringify(websocketRequestBody(data)),
      signal,
    }),
  );
  if (!response.ok) {
    await sendEnvelope(socket, await responseErrorEnvelope(response));
    return true;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = response.body;
  if (body === null || !contentType.includes("text/event-stream")) {
    throw new Error("Responses websocket bridge expected a text/event-stream response");
  }

  let terminalType: unknown;
  for await (const frame of readSSE(body)) {
    const payload = websocketPayload(frame.event, frame.data);
    if (payload === null) continue;
    await sendText(socket, payload);
    let type: unknown;
    try {
      type = (JSON.parse(payload) as { type?: unknown }).type;
    } catch {
      type = undefined;
    }
    if (
      type === "response.completed" ||
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
    return terminalType !== "response.completed";
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

async function preflightUpgrade(
  request: IncomingMessage,
  fetch: AppFetch,
): Promise<{ response: Response; metadata: UpgradeMetadata | null }> {
  const modelsUrl = requestUrl(request, "/v1/models");
  const clientVersion = codexClientVersion(request);
  if (clientVersion !== null) modelsUrl.searchParams.set("client_version", clientVersion);
  const response = await fetch(
    new Request(modelsUrl, {
      method: "GET",
      headers: normalizedFetchHeaders(request),
    }),
  );
  if (!response.ok) return { response, metadata: null };
  return {
    response,
    metadata: {
      modelsEtag: response.headers.get("etag"),
      reasoningIncluded: signalsReasoningIncluded(response.headers.get("x-reasoning-included")),
    },
  };
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
  socket.end(
    [
      `HTTP/1.1 ${response.status} ${statusText}`,
      "Connection: close",
      "Content-Type: application/json",
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
}: ResponsesWebSocketBridgeOptions): ResponsesWebSocketBridge {
  const metadataByRequest = new WeakMap<IncomingMessage, UpgradeMetadata>();
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    maxPayload: 64 * 1024 * 1024,
  });
  let closed = false;

  websocketServer.on("headers", (headers, request) => {
    const metadata = metadataByRequest.get(request);
    if (metadata?.reasoningIncluded) headers.push("x-reasoning-included: true");
    if (metadata?.modelsEtag) headers.push(`x-models-etag: ${metadata.modelsEtag}`);
  });

  websocketServer.on("connection", (socket, request) => {
    const controller = new AbortController();
    const sessionId = randomUUID();
    let sessionClosed = false;
    let pending = Promise.resolve();
    const closeUpstreamSession = async () => {
      await Promise.resolve(closeSession?.(sessionId)).catch(() => {});
    };
    const abort = () => {
      controller.abort();
      if (sessionClosed) return;
      sessionClosed = true;
      void closeUpstreamSession();
    };
    socket.on("close", abort);
    socket.on("error", abort);
    socket.on("message", (data) => {
      pending = pending
        .then(async () => {
          const invalidatesSession = await forwardResponse(
            socket,
            request,
            fetch,
            data,
            controller.signal,
            sessionId,
            sessionProof,
          );
          if (invalidatesSession) await closeUpstreamSession();
        })
        .catch(async (error: unknown) => {
          if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
          await sendEnvelope(socket, localErrorEnvelope(error));
          await closeUpstreamSession();
        });
    });
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isResponsesWebSocketPath(request.url)) {
      socket.destroy();
      return;
    }
    const onPreflightSocketError = () => {
      socket.destroy();
    };
    socket.on("error", onPreflightSocketError);
    void preflightUpgrade(request, fetch)
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
        socket.off("error", onPreflightSocketError);
      });
  };
  server.on("upgrade", onUpgrade);

  return {
    async close() {
      if (closed) return;
      closed = true;
      server.off("upgrade", onUpgrade);
      for (const client of websocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => {
        websocketServer.close(() => resolve());
      });
    },
  };
}
