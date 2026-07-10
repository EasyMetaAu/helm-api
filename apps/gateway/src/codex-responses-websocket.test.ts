import { once } from "node:events";
import { createServer } from "node:http";
import {
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnector,
} from "@helm/core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  codexWebSocketAgent,
  createCodexResponsesWebSocketConnector,
} from "./codex-responses-websocket.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const connections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, "close");
  }
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

describe("createCodexResponsesWebSocketConnector", () => {
  it("connects with Codex headers and relays multiple text events", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      expect(request.headers.authorization).toBe("Bearer subscription-token");
      expect(request.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send('{"type":"response.created","response":{"id":"resp-1"}}');
        socket.send(
          '{"type":"response.completed","response":{"id":"resp-1","status":"completed"}}',
        );
      });
    });
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({ timeoutMs: 2_000 });
    const connection = await connector({
      url: `ws://127.0.0.1:${port}/responses`,
      headers: {
        authorization: "Bearer subscription-token",
        "openai-beta": "responses_websockets=2026-02-06",
      },
    });
    connections.push(connection);

    await connection.send('{"type":"response.create"}');
    expect(await connection.receive()).toContain("response.created");
    expect(await connection.receive()).toContain("response.completed");
  });

  it("captures a non-101 response for account-scoped error mapping", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "17",
        "x-codex-primary-used-percent": "100",
      });
      response.end(JSON.stringify({ error: { message: "quota exhausted" } }));
    });
    const port = await listen(server);
    const connector: CodexResponsesWebSocketConnector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
    });

    let caught: unknown;
    try {
      await connector({
        url: `ws://127.0.0.1:${port}/responses`,
        headers: {},
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexResponsesWebSocketConnectError);
    expect((caught as CodexResponsesWebSocketConnectError).status).toBe(429);
    expect((caught as CodexResponsesWebSocketConnectError).headers.get("retry-after")).toBe("17");
    expect((caught as CodexResponsesWebSocketConnectError).body).toContain("quota exhausted");
  });

  it("builds proxy-aware agents for HTTP, HTTPS, and SOCKS5 accounts", () => {
    expect(codexWebSocketAgent({ type: "http", host: "127.0.0.1", port: 8080 })).toBeInstanceOf(
      HttpsProxyAgent,
    );
    expect(codexWebSocketAgent({ type: "https", host: "127.0.0.1", port: 8443 })).toBeInstanceOf(
      HttpsProxyAgent,
    );
    expect(codexWebSocketAgent({ type: "socks5", host: "127.0.0.1", port: 1080 })).toBeInstanceOf(
      SocksProxyAgent,
    );
  });
});
