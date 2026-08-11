import { once } from "node:events";
import { createServer } from "node:http";
import {
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnector,
  createResponseWorkAdmission,
} from "@helm/core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  codexWebSocketAgent,
  codexWebSocketConnectTimeoutMs,
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

async function settlePromptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("receive did not settle promptly")), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("createCodexResponsesWebSocketConnector", () => {
  it("caps handshake and unexpected-response body waits without shortening smaller timeouts", () => {
    expect(codexWebSocketConnectTimeoutMs(900_000)).toBe(60_000);
    expect(codexWebSocketConnectTimeoutMs(25)).toBe(25);
  });

  it("connects with Codex headers and relays multiple text events", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      expect(request.headers.authorization).toBe("Bearer subscription-token");
      expect(request.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
      expect(request.headers["sec-websocket-extensions"]).toBeUndefined();
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

  it("keeps close terminal state stable for current and future receivers", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    const serverConnection = once(websocketServer, "connection");
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({ timeoutMs: 2_000 });
    const connection = await connector({
      url: `ws://127.0.0.1:${port}/responses`,
      headers: {},
    });
    connections.push(connection);
    const [serverSocket] = (await serverConnection) as [WebSocket];
    const currentReceiveA = connection.receive();
    const currentReceiveB = connection.receive();

    serverSocket.close(1000);

    expect(await settlePromptly(currentReceiveA)).toBeNull();
    expect(await settlePromptly(currentReceiveB)).toBeNull();
    expect(await settlePromptly(connection.receive())).toBeNull();
    expect(await settlePromptly(connection.receive())).toBeNull();
  });

  it("keeps error terminal state stable for current and future receivers", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    const serverConnection = once(websocketServer, "connection");
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({ timeoutMs: 2_000 });
    const connection = await connector({
      url: `ws://127.0.0.1:${port}/responses`,
      headers: {},
    });
    connections.push(connection);
    const [serverSocket] = (await serverConnection) as [WebSocket];
    const currentReceiveA = connection.receive();
    const currentReceiveB = connection.receive();
    const rawSocket = (
      serverSocket as WebSocket & {
        _socket: { write(data: Buffer): boolean };
      }
    )._socket;

    rawSocket.write(Buffer.from([0xa1, 0x00]));

    await expect(settlePromptly(currentReceiveA)).rejects.toThrow(Error);
    await expect(settlePromptly(currentReceiveB)).rejects.toThrow(Error);
    await expect(settlePromptly(connection.receive())).rejects.toThrow(Error);
    await expect(settlePromptly(connection.receive())).rejects.toThrow(Error);
  });

  it("closes an upstream connection when unread messages exceed the dynamic pending budget", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      socket.send("0123456789");
      socket.send("abcdefghij");
    });
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
      maxPayloadBytes: 100,
      maxPendingBytes: 15,
    });
    const connection = await connector({
      url: `ws://127.0.0.1:${port}/responses`,
      headers: {},
    });
    connections.push(connection);
    await new Promise<void>((resolve) => setImmediate(resolve));

    let caught: unknown;
    try {
      await connection.receive();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ queueTimeout: true });
  });

  it("rejects an oversized upstream websocket frame before queueing it", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => socket.send("01234567890"));
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
      maxPayloadBytes: 10,
    });
    const connection = await connector({ url: `ws://127.0.0.1:${port}/responses`, headers: {} });
    connections.push(connection);

    await expect(settlePromptly(connection.receive())).rejects.toThrow(/payload|frame/i);
  });

  it("holds one shared response-work lease through receive and rejects another session when full", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => socket.send("0123456789"));
    const port = await listen(server);
    const responseWorkAdmission = createResponseWorkAdmission({
      capacityBytes: 15,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
      maxPayloadBytes: 100,
      maxPendingBytes: 100,
      responseWorkAdmission,
    });
    const first = await connector({ url: `ws://127.0.0.1:${port}/responses`, headers: {} });
    connections.push(first);
    const firstMessage = await settlePromptly(first.receiveWithWork?.() ?? Promise.resolve(null));
    expect(firstMessage?.text).toBe("0123456789");
    expect(responseWorkAdmission.reservedBytes).toBe(10);

    const second = await connector({ url: `ws://127.0.0.1:${port}/responses`, headers: {} });
    connections.push(second);
    await expect(settlePromptly(second.receive())).rejects.toMatchObject({ queueTimeout: true });
    expect(responseWorkAdmission.reservedBytes).toBe(10);

    firstMessage?.release();
    expect(responseWorkAdmission.reservedBytes).toBe(0);
  });

  it("releases shared response-work held by unread messages when the connection closes", async () => {
    const server = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => socket.send("0123456789"));
    const port = await listen(server);
    const responseWorkAdmission = createResponseWorkAdmission({
      capacityBytes: 20,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
      maxPayloadBytes: 100,
      responseWorkAdmission,
    });
    const connection = await connector({
      url: `ws://127.0.0.1:${port}/responses`,
      headers: {},
    });
    connections.push(connection);
    for (let attempt = 0; attempt < 20 && responseWorkAdmission.reservedBytes === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(responseWorkAdmission.reservedBytes).toBe(10);

    await connection.close();

    expect(responseWorkAdmission.reservedBytes).toBe(0);
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

  it("destroys an unexpected response whose body exceeds the dynamic websocket limit", async () => {
    let responseClosed = false;
    const server = createServer((_request, response) => {
      response.on("close", () => {
        responseClosed = true;
      });
      response.writeHead(429, { "content-type": "application/json" });
      response.write("12345678");
      setImmediate(() => {
        response.write("abcdefgh");
        response.end();
      });
    });
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 2_000,
      maxPayloadBytes: 10,
    });

    let caught: unknown;
    try {
      await connector({ url: `ws://127.0.0.1:${port}/responses`, headers: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexResponsesWebSocketConnectError);
    expect(caught).toMatchObject({ status: 429 });
    expect((caught as Error).message).toContain("exceeded");
    expect(responseClosed).toBe(true);
  });

  it("destroys an unexpected response whose body does not finish within the handshake timeout", async () => {
    let responseClosed = false;
    const server = createServer((_request, response) => {
      response.on("close", () => {
        responseClosed = true;
      });
      response.writeHead(503, { "content-type": "text/plain" });
      response.write("still waiting");
      setTimeout(() => response.end(), 100).unref?.();
    });
    const port = await listen(server);
    const connector = createCodexResponsesWebSocketConnector({
      timeoutMs: 25,
      maxPayloadBytes: 100,
    });

    let caught: unknown;
    try {
      await settlePromptly(connector({ url: `ws://127.0.0.1:${port}/responses`, headers: {} }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexResponsesWebSocketConnectError);
    expect(caught).toMatchObject({ status: 503 });
    expect((caught as Error).message).toContain("timed out");
    for (let attempt = 0; attempt < 20 && !responseClosed; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(responseClosed).toBe(true);
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
