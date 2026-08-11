import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("relays a client frame larger than the former admission limit", async () => {
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
        jsonAmplification: 1,
      }),
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(client, "open");
    const echoed = once(client, "message");
    client.send("12345");
    const [data] = (await echoed) as [WebSocket.RawData, boolean];
    expect(data.toString()).toBe("12345");
  });

  it("rejects an oversized client frame before it reaches the upstream relay", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ server: upstreamHttp.server, perMessageDeflate: false });
    let relayed = false;
    upstream.on("connection", (socket) => socket.on("message", () => (relayed = true)));
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
      maxPayloadBytes: 10,
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(client, "open");
    const closed = once(client, "close");
    client.send("01234567890");

    const [code] = await closed;
    expect(code).toBe(1009);
    expect(relayed).toBe(false);
  });

  it("rejects the connection over the active cap and admits one after close", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ server: upstreamHttp.server, perMessageDeflate: false });
    upstream.on("connection", () => {});
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of upstream.clients) socket.terminate();
          upstream.close(() => resolve());
        }),
    );

    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    const target = {
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime`,
      headers: async () => ({}),
    };
    registry.put("rtc_1", "key-1", target);
    registry.put("rtc_2", "key-1", target);
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-1",
      maxConnections: 1,
      idleSessionTimeoutMs: 5_000,
    });
    closers.push(() => bridge.close());

    const first = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(first, "open");
    const rejected = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_2`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    const [, response] = (await once(rejected, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(503);

    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;

    const second = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_2`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(second, "open");
    second.terminate();
  });

  it("counts a pending upgrade against the connection cap", async () => {
    const gateway = await listeningServer();
    const registry = createRealtimeCallRegistry();
    let releaseKey!: (keyId: string | null) => void;
    const pendingKey = new Promise<string | null>((resolve) => {
      releaseKey = resolve;
    });
    let resolveCalls = 0;
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => {
        resolveCalls += 1;
        return resolveCalls === 1 ? pendingKey : "key-1";
      },
      maxConnections: 1,
    });
    closers.push(() => bridge.close());

    const first = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`);
    await vi.waitFor(() => expect(resolveCalls).toBe(1));
    const second = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_2`);
    const [, secondResponse] = (await once(second, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(secondResponse.statusCode).toBe(503);

    const firstRejected = once(first, "unexpected-response");
    releaseKey("key-1");
    const [, firstResponse] = (await firstRejected) as [unknown, { statusCode: number }];
    expect(firstResponse.statusCode).toBe(404);
  });

  it("closes an idle realtime connection and its upstream", async () => {
    const upstreamHttp = await listeningServer();
    const upstream = new WebSocketServer({ server: upstreamHttp.server, perMessageDeflate: false });
    let upstreamClosed = false;
    upstream.on("connection", (socket) => {
      socket.once("close", () => {
        upstreamClosed = true;
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
      url: `ws://127.0.0.1:${upstreamHttp.port}/v1/realtime`,
      headers: async () => ({}),
    });
    const bridge = installRealtimeWebSocketBridge({
      server: gateway.server,
      registry,
      resolveKey: async () => "key-1",
      idleSessionTimeoutMs: 30,
    });
    closers.push(() => bridge.close());

    const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/realtime?call_id=rtc_1`, {
      headers: { Authorization: "Bearer helm-key" },
    });
    await once(client, "open");
    const [code] = (await once(client, "close")) as [number, Buffer];
    expect(code).toBe(1001);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
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
