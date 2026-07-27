import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRealtimeCallRegistry } from "./realtime-call-registry.js";
import {
  installRealtimeWebSocketBridge,
  isRealtimeWebSocketPath,
  type RealtimeWebSocketBridge,
} from "./realtime-websocket.js";
import { createBodyMemoryAdmission } from "./runtime/memory-admission.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listeningServer() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: address.port };
}

describe("Realtime websocket bridge", () => {
  it.each(["/v1/realtime?call_id=rtc_1", "/v1/live/rtc_1"])("matches %s", (path) =>
    expect(isRealtimeWebSocketPath(path)).toBe(true));

  it("relays immediate upstream events plus text and binary frames", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ server: upstreamHttp.server, perMessageDeflate: false });
    upstream.on("connection", (socket) => {
      socket.send('{"type":"session.started"}');
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of upstream.clients) socket.terminate();
          upstream.close(() => resolve());
        }),
    );

    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    registry.put("rtc_1", "key-1", {
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime?call_id=rtc_1`,
      headers: async () => ({ Authorization: "Bearer upstream" }),
    });
    const bridge: RealtimeWebSocketBridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async (credential) => (credential === "helm-key" ? "key-1" : null),
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    const firstMessage = once(client, "message");
    await once(client, "open");
    const [started] = (await firstMessage) as [WebSocket.RawData, boolean];
    expect(started.toString()).toContain("session.started");

    const textMessage = once(client, "message");
    client.send("hello");
    const [text] = (await textMessage) as [WebSocket.RawData, boolean];
    expect(text.toString()).toBe("hello");
    const binaryMessage = once(client, "message");
    client.send(new Uint8Array([1, 2, 3]));
    const [binary, isBinary] = (await binaryMessage) as [WebSocket.RawData, boolean];
    expect(isBinary).toBe(true);
    expect([...new Uint8Array(binary as Buffer)]).toEqual([1, 2, 3]);
    const closed = once(client, "close");
    client.close();
    await closed;
  });

  it("rejects a call created by another Helm key", async () => {
    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    registry.put("rtc_1", "key-1", {
      url: "ws://127.0.0.1:1/v1/realtime?call_id=rtc_1",
      headers: async () => ({}),
    });
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-2",
    });
    closers.push(() => bridge.close());
    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer another-key" },
    });
    const [, response] = (await once(client, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(404);
  });

  it("closes an oversized client frame with 1009 before relaying it", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ server: upstreamHttp.server, perMessageDeflate: false });
    upstream.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of upstream.clients) socket.terminate();
          upstream.close(() => resolve());
        }),
    );

    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    registry.put("rtc_1", "key-1", {
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime?call_id=rtc_1`,
      headers: async () => ({}),
    });
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-1",
      memoryAdmission: createBodyMemoryAdmission({
        activeRequestBytes: 100,
        maxWireBytes: 4,
        jsonAmplification: 1,
      }),
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(client, "open");
    const closed = once(client, "close");
    client.send("12345");
    const [code] = (await closed) as [number];
    expect(code).toBe(1009);
  });

  it("refreshes OAuth once when the upstream sideband rejects with 401", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    let upgrades = 0;
    let refreshed = 0;
    let rejectedSocketEnded = Promise.resolve(false);
    const authHeaders: Array<string | undefined> = [];
    upstreamHttp.server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      authHeaders.push(request.headers.authorization);
      if (upgrades === 1) {
        rejectedSocketEnded = once(socket, "end").then(() => true);
        closers.push(async () => {
          socket.destroy();
        });
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      upstream.handleUpgrade(request, socket, head, (websocket) => {
        websocket.send("ready");
        upstream.emit("connection", websocket, request);
      });
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of upstream.clients) socket.terminate();
          upstream.close(() => resolve());
        }),
    );

    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    registry.put("rtc_1", "key-1", {
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime?call_id=rtc_1`,
      headers: async () => ({ Authorization: `Bearer token-${refreshed + 1}` }),
      onUnauthorized: () => {
        refreshed += 1;
      },
    });
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-1",
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    const ready = once(client, "message");
    await once(client, "open");
    expect(((await ready) as [WebSocket.RawData])[0].toString()).toBe("ready");
    expect(upgrades).toBe(2);
    expect(refreshed).toBe(1);
    expect(authHeaders).toEqual(["Bearer token-1", "Bearer token-2"]);
    client.terminate();
    expect(await Promise.race([rejectedSocketEnded, delay(500, false)])).toBe(true);
  });

  it("reports a second upstream sideband 401 as a permanent credential failure", async () => {
    const upstreamHttp = await listeningServer();
    let upgrades = 0;
    upstreamHttp.server.on("upgrade", (_request, socket) => {
      upgrades += 1;
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });

    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    const failures: number[] = [];
    registry.put("rtc_1", "key-1", {
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime?call_id=rtc_1`,
      headers: async () => ({ Authorization: "Bearer token" }),
      onUnauthorized: () => {},
      onCredentialFailure: (status) => failures.push(status),
    });
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-1",
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    const [, response] = (await once(client, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];

    expect(response.statusCode).toBe(502);
    expect(upgrades).toBe(2);
    expect(failures).toEqual([401]);
  });
});
