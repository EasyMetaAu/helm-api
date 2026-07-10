import type { Agent as HttpAgent, IncomingMessage } from "node:http";
import {
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnection,
  type CodexResponsesWebSocketConnector,
  type ProxyConfig,
  proxyConfigToUrl,
} from "@helm/core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from "ws";

export interface CodexResponsesWebSocketConnectorOptions {
  proxy?: ProxyConfig;
  timeoutMs?: number;
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

class WsCodexConnection implements CodexResponsesWebSocketConnection {
  readonly responseHeaders: Headers;
  private readonly pending: Array<string | null | Error> = [];
  private readonly waiters: Array<{
    resolve: (value: string | null) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    private readonly socket: WebSocket,
    headers: Headers,
  ) {
    this.responseHeaders = headers;
    socket.on("message", (data) => this.enqueue(data.toString()));
    socket.on("close", () => this.enqueue(null));
    socket.on("error", (error) => this.enqueue(error));
  }

  private enqueue(value: string | null | Error): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (value instanceof Error) waiter.reject(value);
      else waiter.resolve(value);
      return;
    }
    this.pending.push(value);
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
    const next = this.pending.shift();
    if (next !== undefined) {
      if (next instanceof Error) throw next;
      return next;
    }
    return await new Promise<string | null>((resolve, reject) => {
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

async function unexpectedResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createCodexResponsesWebSocketConnector(
  options: CodexResponsesWebSocketConnectorOptions = {},
): CodexResponsesWebSocketConnector {
  const agent = codexWebSocketAgent(options.proxy);
  const timeoutMs = options.timeoutMs ?? 60_000;

  return async ({ url, headers, signal }) =>
    await new Promise<CodexResponsesWebSocketConnection>((resolve, reject) => {
      let settled = false;
      let upgradeHeaders = new Headers();
      const socket = new WebSocket(url, {
        headers,
        agent,
        perMessageDeflate: true,
        handshakeTimeout: timeoutMs,
        maxPayload: 64 * 1024 * 1024,
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
        resolve(new WsCodexConnection(socket, upgradeHeaders));
      });
      socket.once("unexpected-response", (_request, response) => {
        void unexpectedResponseBody(response)
          .then((body) => {
            fail(
              new CodexResponsesWebSocketConnectError(
                `Codex Responses websocket returned HTTP ${response.statusCode ?? 0}`,
                {
                  status: response.statusCode ?? null,
                  headers: responseHeaders(response),
                  body,
                },
              ),
            );
          })
          .catch((error) => fail(error));
      });
      socket.once("error", (error) => {
        fail(
          new CodexResponsesWebSocketConnectError("Codex Responses websocket connection failed", {
            cause: error,
          }),
        );
      });
    });
}
