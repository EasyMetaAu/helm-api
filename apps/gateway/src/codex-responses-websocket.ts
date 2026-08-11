import type { Agent as HttpAgent, IncomingMessage } from "node:http";
import {
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnection,
  type CodexResponsesWebSocketConnector,
  type CodexResponsesWebSocketReceivedMessage,
  type ProxyConfig,
  proxyConfigToUrl,
  type ResponseWorkAdmission,
  runtimeMemoryBudget,
  runtimeResponseWorkAdmission,
} from "@helm/core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket, { type RawData } from "ws";

export interface CodexResponsesWebSocketConnectorOptions {
  proxy?: ProxyConfig;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxPendingBytes?: number;
  responseWorkAdmission?: ResponseWorkAdmission;
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

export function codexWebSocketAgent(proxy: ProxyConfig | undefined): HttpAgent | undefined {
  if (!proxy) return undefined;
  const proxyUrl = proxyConfigToUrl(proxy);
  return proxy.type === "socks5"
    ? (new SocksProxyAgent(proxyUrl) as HttpAgent)
    : (new HttpsProxyAgent(proxyUrl) as HttpAgent);
}

export function codexWebSocketConnectTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(60_000, Math.max(1, Math.floor(timeoutMs ?? 60_000)));
}

class WsCodexConnection implements CodexResponsesWebSocketConnection {
  readonly responseHeaders: Headers;
  private readonly pending: Array<CodexResponsesWebSocketReceivedMessage & { bytes: number }> = [];
  private pendingBytes = 0;
  private readonly waiters: Array<{
    resolve: (value: CodexResponsesWebSocketReceivedMessage | null) => void;
    reject: (error: Error) => void;
  }> = [];
  private terminal: Error | null | undefined;

  constructor(
    private readonly socket: WebSocket,
    headers: Headers,
    private readonly maxPendingBytes: number,
    private readonly responseWorkAdmission: ResponseWorkAdmission,
  ) {
    this.responseHeaders = headers;
    socket.on("message", (data) => this.enqueueMessage(data));
    socket.on("close", () => this.terminate(null));
    socket.on("error", (error) => this.terminate(error));
  }

  private terminate(value: Error | null): void {
    if (this.terminal !== undefined) return;
    this.terminal = value;
    for (const pending of this.pending.splice(0)) pending.release();
    this.pendingBytes = 0;
    for (const waiter of this.waiters.splice(0)) {
      if (value instanceof Error) waiter.reject(value);
      else waiter.resolve(value);
    }
  }

  private capacityError(): Error {
    return Object.assign(new Error("Codex websocket pending response capacity exceeded"), {
      name: "QueueTimeoutError",
      queueTimeout: true as const,
    });
  }

  private failCapacity(currentRelease?: () => void): void {
    currentRelease?.();
    const error = this.capacityError();
    this.terminate(error);
    this.socket.close(1013, "response capacity exceeded");
  }

  private enqueueMessage(data: RawData): void {
    if (this.terminal !== undefined) return;
    const bytes = Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
      : data.byteLength;
    const acquired = this.responseWorkAdmission.acquire(bytes);
    if (!acquired.ok) {
      this.failCapacity();
      return;
    }
    let text: string;
    try {
      text = Array.isArray(data)
        ? Buffer.concat(data, bytes).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
    } catch (error) {
      acquired.lease.release();
      this.terminate(error instanceof Error ? error : new Error("invalid websocket message"));
      return;
    }
    const message = { text, bytes, release: () => acquired.lease.release() };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    if (this.maxPendingBytes > 0 && this.pendingBytes + bytes > this.maxPendingBytes) {
      this.failCapacity(message.release);
      return;
    }
    this.pending.push(message);
    this.pendingBytes += bytes;
  }

  async send(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Codex Responses websocket is closed"));
        return;
      }
      this.socket.send(text, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async receive(): Promise<string | null> {
    const message = await this.receiveWithWork();
    if (message === null) return null;
    try {
      return message.text;
    } finally {
      message.release();
    }
  }

  async receiveWithWork(): Promise<CodexResponsesWebSocketReceivedMessage | null> {
    const next = this.pending.shift();
    if (next !== undefined) {
      this.pendingBytes -= next.bytes;
      return next;
    }
    if (this.terminal instanceof Error) throw this.terminal;
    if (this.terminal === null) return null;
    return await new Promise<CodexResponsesWebSocketReceivedMessage | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      timer.unref?.();
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else this.socket.close(1000);
    });
  }
}

class UnexpectedResponseBodyError extends Error {
  constructor(
    readonly reason: "too_large" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "UnexpectedResponseBodyError";
  }
}

async function unexpectedResponseBody(
  response: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeoutError = new UnexpectedResponseBodyError(
    "timeout",
    `Codex Responses websocket unexpected response body timed out after ${timeoutMs} ms`,
  );
  const timer = setTimeout(() => response.destroy(timeoutError), timeoutMs);
  timer.unref?.();
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (maxBytes > 0 && bytes > maxBytes) {
        const error = new UnexpectedResponseBodyError(
          "too_large",
          `Codex Responses websocket unexpected response body exceeded ${maxBytes} bytes`,
        );
        response.destroy(error);
        throw error;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export function createCodexResponsesWebSocketConnector(
  options: CodexResponsesWebSocketConnectorOptions = {},
): CodexResponsesWebSocketConnector {
  const agent = codexWebSocketAgent(options.proxy);
  const connectTimeoutMs = codexWebSocketConnectTimeoutMs(options.timeoutMs);
  const maxPayloadBytes = Math.max(
    1,
    Math.floor(options.maxPayloadBytes ?? runtimeMemoryBudget().responseCaptureBytes),
  );
  const maxPendingBytes = Math.max(1, Math.floor(options.maxPendingBytes ?? maxPayloadBytes));
  const responseWorkAdmission = options.responseWorkAdmission ?? runtimeResponseWorkAdmission();

  return async ({ url, headers, signal }) =>
    await new Promise<CodexResponsesWebSocketConnection>((resolve, reject) => {
      let settled = false;
      let readingUnexpectedResponse = false;
      let upgradeHeaders = new Headers();
      const socket = new WebSocket(url, {
        headers,
        agent,
        perMessageDeflate: false,
        handshakeTimeout: connectTimeoutMs,
        maxPayload: maxPayloadBytes,
      });

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.on("error", () => {});
        socket.terminate();
        reject(
          error instanceof Error
            ? error
            : new CodexResponsesWebSocketConnectError(
                "Codex Responses websocket connection failed",
              ),
        );
      };
      const onAbort = () => fail(signal?.reason ?? new Error("client aborted"));
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("upgrade", (response) => {
        upgradeHeaders = responseHeaders(response);
      });
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(
          new WsCodexConnection(socket, upgradeHeaders, maxPendingBytes, responseWorkAdmission),
        );
      });
      socket.once("unexpected-response", (request, response) => {
        readingUnexpectedResponse = true;
        request.setTimeout(0);
        const status = response.statusCode ?? null;
        const headers = responseHeaders(response);
        void unexpectedResponseBody(response, maxPayloadBytes, connectTimeoutMs)
          .then((body) => {
            fail(
              new CodexResponsesWebSocketConnectError(
                `Codex Responses websocket returned HTTP ${status ?? 0}`,
                {
                  status,
                  headers,
                  body,
                },
              ),
            );
          })
          .catch((error) => {
            fail(
              new CodexResponsesWebSocketConnectError(
                error instanceof UnexpectedResponseBodyError
                  ? error.message
                  : "Codex Responses websocket unexpected response body failed",
                { status, headers, cause: error },
              ),
            );
          });
      });
      socket.once("error", (error) => {
        if (readingUnexpectedResponse) return;
        fail(
          new CodexResponsesWebSocketConnectError("Codex Responses websocket connection failed", {
            cause: error,
          }),
        );
      });
    });
}
