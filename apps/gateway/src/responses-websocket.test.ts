import { once } from "node:events";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { createResponseWorkAdmission } from "@helm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  installResponsesWebSocketBridge,
  isResponsesWebSocketPath,
  type ResponsesWebSocketUpgradeServer,
  responsesWebSocketPreflightPending,
} from "./responses-websocket.js";
import {
  CODEX_RESPONSES_WEBSOCKET_RECOVERY_PROOF_HEADER,
  markResponsesWebSocketRequestParsed,
} from "./responses-websocket-internal.js";
import { createBodyMemoryAdmission } from "./runtime/memory-admission.js";

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
}

const openBridges: Array<{ close(): Promise<void> }> = [];
const openServers: ReturnType<typeof createServer>[] = [];
const openSockets: WebSocket[] = [];
const TEST_SESSION_PROOF = "responses-websocket-test-proof";

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    if (socket.readyState === WebSocket.CLOSED) continue;
    socket.on("error", () => {});
    socket.terminate();
  }
  for (const bridge of openBridges.splice(0)) await bridge.close();
  for (const server of openServers.splice(0)) {
    server.close();
    await once(server, "close");
  }
});

function collectTurn(
  socket: WebSocket,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket response"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      events.push(event);
      if (
        event.type === "response.completed" ||
        event.type === "response.cancelled" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      ) {
        cleanup();
        resolve(events);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(JSON.stringify(request));
  });
}

async function startBridge(
  fetch: (request: Request) => Promise<Response> | Response,
  modelsFetch: (request: Request) => Promise<Response> | Response = () =>
    new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json", etag: '"models-1"' },
    }),
  options: {
    closeSession?: (sessionId: string) => void | Promise<void>;
    memoryAdmission?: ReturnType<typeof createBodyMemoryAdmission>;
    ingressAdmission?: ReturnType<typeof createBodyMemoryAdmission>;
    responseWorkAdmission?: ReturnType<typeof createResponseWorkAdmission>;
    preflightTimeoutMs?: number;
    maxPayloadBytes?: number;
    maxPreflightRequests?: number;
    maxSseFrameBytes?: number;
    idleSessionTimeoutMs?: number;
  } = {},
) {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  openServers.push(server);
  const bridge = installResponsesWebSocketBridge({
    server,
    fetch: (request) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
        return modelsFetch(request);
      }
      return fetch(request);
    },
    closeSession: options.closeSession,
    sessionProof: TEST_SESSION_PROOF,
    memoryAdmission: options.memoryAdmission,
    ingressAdmission: options.ingressAdmission,
    responseWorkAdmission: options.responseWorkAdmission,
    preflightTimeoutMs: options.preflightTimeoutMs,
    maxPayloadBytes: options.maxPayloadBytes,
    maxPreflightRequests: options.maxPreflightRequests,
    maxSseFrameBytes: options.maxSseFrameBytes,
    idleSessionTimeoutMs: options.idleSessionTimeoutMs,
  });
  openBridges.push(bridge);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return `ws://127.0.0.1:${address.port}`;
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    headers: {
      authorization: "Bearer helm-test-key",
      "session-id": "session-1",
      "user-agent": "codex_cli_rs/0.144.1 (test)",
      ...headers,
    },
  });
  openSockets.push(socket);
  await once(socket, "open");
  return socket;
}

describe("Responses websocket bridge", () => {
  it("rejects an oversized client frame before the response handler runs", async () => {
    const fetch = vi.fn(() => {
      throw new Error("oversized frame must not reach the response handler");
    });
    const baseUrl = await startBridge(fetch, undefined, { maxPayloadBytes: 10 });
    const socket = await connect(`${baseUrl}/v1/responses`);
    const closed = once(socket, "close");

    socket.send("01234567890");

    const [code] = await closed;
    expect(code).toBe(1009);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caps active clients and releases the slot after close", async () => {
    const baseUrl = await startBridge(
      () =>
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      { maxPreflightRequests: 1 },
    );
    const first = await connect(`${baseUrl}/v1/responses`);

    const rejected = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: {
        authorization: "Bearer helm-test-key",
        "user-agent": "codex_cli_rs/0.144.1",
      },
    });
    rejected.on("error", () => {});
    openSockets.push(rejected);
    const [, response] = (await once(rejected, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(503);

    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;
    await connect(`${baseUrl}/v1/responses`);
  });

  it("does not reserve a maximum frame for idle websocket connections", async () => {
    const ingressAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 20,
      jsonAmplification: 1,
      minRequestChargeBytes: 10,
    });
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      undefined,
      { ingressAdmission },
    );

    await Promise.all([
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
    ]);

    expect(ingressAdmission.reservedBytes).toBe(0);
  });

  it("admits concurrent materialized websocket messages without capacity 503", async () => {
    const ingressAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 200,
      jsonAmplification: 1,
      minRequestChargeBytes: 100,
    });
    const pendingResponses: Array<(response: Response) => void> = [];
    const baseUrl = await startBridge(
      () => new Promise<Response>((resolve) => pendingResponses.push(resolve)),
      undefined,
      { ingressAdmission },
    );
    const [first, second, third] = await Promise.all([
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
    ]);
    const request = {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    };

    const firstTurn = collectTurn(first, request);
    const secondTurn = collectTurn(second, request);
    const thirdTurn = collectTurn(third, request);
    for (let attempt = 0; attempt < 40 && pendingResponses.length < 3; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(pendingResponses).toHaveLength(3);
    expect(ingressAdmission.reservedBytes).toBe(300);

    const completed = () =>
      new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    for (const resolve of pendingResponses) resolve(completed());
    await Promise.all([firstTurn, secondTurn, thirdTurn]);
    expect(ingressAdmission.reservedBytes).toBe(0);
  });

  it("accepts a websocket message larger than the former shared hard wire limit", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const baseUrl = await startBridge(
      () =>
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      { memoryAdmission },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    const events = await collectTurn(socket, {
      type: "response.create",
      input: "larger than ten bytes",
    });

    expect(events.at(-1)).toMatchObject({ type: "response.completed" });
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("reports maintenance pause honestly on an established websocket", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const baseUrl = await startBridge(
      () => {
        throw new Error("fetch should not run while admission is paused");
      },
      undefined,
      { memoryAdmission },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    memoryAdmission.pause();

    await expect(
      collectTurn(socket, { type: "response.create", input: "maintenance", stream: true }),
    ).resolves.toMatchObject([
      {
        type: "error",
        status: 503,
        error: {
          code: "database_maintenance",
          message: "database maintenance in progress",
        },
      },
    ]);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("materializes the shared request lease after the internal HTTP parser returns", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1_000,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
    });
    let fetched!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    const baseUrl = await startBridge(
      (request) => {
        fetched();
        markResponsesWebSocketRequestParsed(request);
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          }),
        );
      },
      undefined,
      { memoryAdmission },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    socket.send(JSON.stringify({ type: "response.create", input: [], stream: true }));
    await fetchStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(memoryAdmission.reservedBytes).toBeGreaterThan(0);
    expect(memoryAdmission.pendingBytes).toBe(0);
  });

  it("keeps request admission until the internal parser finishes", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      capacityBytes: () => 100,
      jsonAmplification: 1,
      minRequestChargeBytes: 100,
    });
    const pendingResponses: Array<(response: Response) => void> = [];
    const parsedRequests: Request[] = [];
    const baseUrl = await startBridge(
      (request) => {
        parsedRequests.push(request);
        return new Promise<Response>((resolve) => pendingResponses.push(resolve));
      },
      undefined,
      { memoryAdmission },
    );
    const [first, second, third] = await Promise.all([
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
      connect(`${baseUrl}/v1/responses`),
    ]);
    const firstTurn = collectTurn(first, {
      type: "response.create",
      input: [],
      stream: true,
    });

    for (let attempt = 0; attempt < 40 && parsedRequests.length < 1; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(parsedRequests).toHaveLength(1);
    expect(memoryAdmission.pendingBytes).toBe(100);

    await expect(
      collectTurn(second, { type: "response.create", input: [], stream: true }),
    ).resolves.toMatchObject([{ type: "error", status: 503 }]);
    expect(parsedRequests).toHaveLength(1);

    const firstRequest = parsedRequests[0];
    if (firstRequest === undefined) throw new Error("internal request did not reach the parser");
    markResponsesWebSocketRequestParsed(firstRequest);
    expect(memoryAdmission.pendingBytes).toBe(0);

    const thirdTurn = collectTurn(third, {
      type: "response.create",
      input: [],
      stream: true,
    });
    for (let attempt = 0; attempt < 40 && parsedRequests.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(parsedRequests).toHaveLength(2);

    const completed = () =>
      new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    for (const resolve of pendingResponses) resolve(completed());
    await Promise.all([firstTurn, thirdTurn]);
  });

  it.each([
    "/v1/responses",
    "/responses",
    "/openai/v1/responses",
    "/v1/responses?model=gpt-5.6-sol",
  ])("recognizes %s", (path) => {
    expect(isResponsesWebSocketPath(path)).toBe(true);
  });

  it.each([
    undefined,
    "/v1/responses/compact",
    "/v1/responses/input_tokens",
    "/v1/chat/completions",
  ])("rejects non-create path %s", (path) => {
    expect(isResponsesWebSocketPath(path)).toBe(false);
  });

  it("rejects upgrades beyond the bounded preflight capacity", async () => {
    let resolveModels!: (response: Response) => void;
    const pendingModels = new Promise<Response>((resolve) => {
      resolveModels = resolve;
    });
    const baseUrl = await startBridge(
      () => {
        throw new Error("response handler must not run");
      },
      () => pendingModels,
      { maxPreflightRequests: 1 },
    );
    const first = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer helm-test-key", "user-agent": "codex_cli_rs/0.144.1" },
    });
    first.on("error", () => {});
    openSockets.push(first);
    for (
      let attempt = 0;
      attempt < 40 && responsesWebSocketPreflightPending() === 0;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(responsesWebSocketPreflightPending()).toBe(1);

    const rejected = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer helm-test-key", "user-agent": "codex_cli_rs/0.144.1" },
    });
    rejected.on("error", () => {});
    openSockets.push(rejected);
    const [, response] = (await once(rejected, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(503);

    const opened = once(first, "open");
    resolveModels(
      new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await opened;
  });

  it("handles an upgrade socket reset while async preflight is pending", async () => {
    let upgradeListener: Parameters<ResponsesWebSocketUpgradeServer["on"]>[1] | undefined;
    const server: ResponsesWebSocketUpgradeServer = {
      on(_event, listener) {
        upgradeListener = listener;
      },
      off(_event, listener) {
        if (upgradeListener === listener) upgradeListener = undefined;
      },
    };
    let resolvePreflight!: (response: Response) => void;
    let preflightStarted = false;
    let preflightSignal: AbortSignal | undefined;
    const preflight = new Promise<Response>((resolve) => {
      resolvePreflight = resolve;
    });
    const bridge = installResponsesWebSocketBridge({
      server,
      fetch: (request) => {
        preflightStarted = true;
        preflightSignal = request.signal;
        return preflight;
      },
    });
    openBridges.push(bridge);

    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.method = "GET";
    request.url = "/v1/responses";
    upgradeListener?.(request, socket, Buffer.alloc(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preflightStarted).toBe(true);
    expect(responsesWebSocketPreflightPending()).toBe(1);

    let unhandledError: unknown;
    try {
      socket.emit(
        "error",
        Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      );
    } catch (error) {
      unhandledError = error;
    } finally {
      socket.destroy();
      resolvePreflight(
        new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(unhandledError).toBeUndefined();
    expect(preflightSignal?.aborted).toBe(true);
    expect(responsesWebSocketPreflightPending()).toBe(0);
  });

  it("supports prewarm and a second response.create on the same connection", async () => {
    const captured: CapturedRequest[] = [];
    let responseNumber = 0;
    const baseUrl = await startBridge(async (request) => {
      responseNumber += 1;
      captured.push({
        body: (await request.json()) as Record<string, unknown>,
        headers: request.headers,
      });
      const id = `resp-${responseNumber}`;
      const encoder = new TextEncoder();
      const chunks = [
        `event: response.created\r\ndata: {"type":"response.created","response":{"id":"${id}"}}\r\n\r`,
        `\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"${id}","status":"completed"}}\n\n`,
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const socket = await connect(`${baseUrl}/v1/responses`);

    const warmup = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
      generate: false,
    });
    const turn = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [] }],
      stream: true,
      store: false,
      previous_response_id: "resp-1",
    });

    expect(warmup.map((event) => event.type)).toEqual(["response.created", "response.completed"]);
    expect(turn.map((event) => event.type)).toEqual(["response.created", "response.completed"]);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.body).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      generate: false,
    });
    expect(captured[0]?.body.type).toBeUndefined();
    expect(captured[1]?.body.previous_response_id).toBe("resp-1");
    expect(captured[0]?.headers.get("authorization")).toBe("Bearer helm-test-key");
    expect(captured[0]?.headers.get("session-id")).toBe("session-1");
    expect(captured[0]?.headers.get("upgrade")).toBeNull();
    expect(captured[0]?.headers.get("sec-websocket-key")).toBeNull();
    expect(captured[0]?.headers.get("accept")).toBe("text/event-stream");
  });

  it("resets the idle deadline for accepted turns and closes the upstream session on expiry", async () => {
    let closeSessionCalls = 0;
    let closedSessionId = "";
    const baseUrl = await startBridge(
      () =>
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      {
        idleSessionTimeoutMs: 100,
        closeSession: (sessionId) => {
          closeSessionCalls += 1;
          closedSessionId = sessionId;
        },
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await collectTurn(socket, { type: "response.create", input: [], stream: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const [code] = (await Promise.race([
      once(socket, "close"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("idle close timed out")), 250),
      ),
    ])) as [number, Buffer];
    expect(code).toBe(1001);
    expect(closeSessionCalls).toBe(1);
    expect(closedSessionId).not.toBe("");
  });

  it("closes a connection that pipelines a second active response without injecting an error", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const baseUrl = await startBridge((request) => {
      started();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener("abort", () => controller.close(), { once: true });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const socket = await connect(`${baseUrl}/v1/responses`);
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    socket.send(JSON.stringify({ type: "response.create", input: [], stream: true }));
    await requestStarted;

    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "response.create", input: [], stream: true }));
    const [code] = await closed;

    expect(code).toBe(1008);
    expect(messages).toEqual([]);
  });

  it("returns the models ETag without inventing reasoning capability on the 101 handshake", async () => {
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("client_version")).toBe("0.144.1");
        return new Response(JSON.stringify({ models: [] }), {
          headers: { "content-type": "application/json", etag: '"models-1"' },
        });
      },
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: {
        authorization: "Bearer helm-test-key",
        "user-agent": "Codex Desktop/0.144.1 (macOS 26.0; arm64)",
      },
      perMessageDeflate: true,
    });
    openSockets.push(socket);
    const upgrade = once(socket, "upgrade") as Promise<[IncomingMessage]>;
    const opened = once(socket, "open");
    const [[response]] = await Promise.all([upgrade, opened]);

    expect(response.statusCode).toBe(101);
    expect(response.headers["x-models-etag"]).toBe('"models-1"');
    expect(response.headers["x-reasoning-included"]).toBeUndefined();
    expect(response.headers["sec-websocket-extensions"]).toBeUndefined();
  });

  it("falls back to an auth-only models check when versioned preflight times out", async () => {
    let versionedAborted = false;
    let fallbackCalls = 0;
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      (request) => {
        const version = new URL(request.url).searchParams.get("client_version");
        if (version !== null) {
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(new Response("catalog stuck", { status: 504 })),
              50,
            );
            request.signal.addEventListener(
              "abort",
              () => {
                versionedAborted = true;
                clearTimeout(timer);
                reject(request.signal.reason);
              },
              { once: true },
            );
          });
        }
        fallbackCalls += 1;
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
      { preflightTimeoutMs: 10 },
    );

    const socket = await connect(`${baseUrl}/v1/responses`);

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(versionedAborted).toBe(true);
    expect(fallbackCalls).toBe(1);
  });

  it("bounds a stalled auth-only fallback and releases the preflight", async () => {
    let upgradeListener: Parameters<ResponsesWebSocketUpgradeServer["on"]>[1] | undefined;
    const server: ResponsesWebSocketUpgradeServer = {
      on(_event, listener) {
        upgradeListener = listener;
      },
      off(_event, listener) {
        if (upgradeListener === listener) upgradeListener = undefined;
      },
    };
    let fallbackSignal: AbortSignal | undefined;
    let resolveFallback!: (response: Response) => void;
    const fallback = new Promise<Response>((resolve) => {
      resolveFallback = resolve;
    });
    const bridge = installResponsesWebSocketBridge({
      server,
      preflightTimeoutMs: 5,
      fetch: (request) => {
        if (new URL(request.url).searchParams.has("client_version")) {
          return Promise.resolve(new Response("catalog timeout", { status: 504 }));
        }
        fallbackSignal = request.signal;
        return fallback;
      },
    });
    openBridges.push(bridge);
    const socket = new Socket();
    socket.on("error", () => {});
    const request = new IncomingMessage(socket);
    request.method = "GET";
    request.url = "/v1/responses";
    request.headers = {
      authorization: "Bearer helm-test-key",
      "user-agent": "codex_cli_rs/0.144.1 (test)",
    };

    upgradeListener?.(request, socket, Buffer.alloc(0));

    try {
      await vi.waitFor(() => expect(fallbackSignal?.aborted).toBe(true));
      await vi.waitFor(() => expect(responsesWebSocketPreflightPending()).toBe(0));
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      resolveFallback(new Response("late response"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("cancels an unused successful models preflight body", async () => {
    let cancelled = false;
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { etag: '"models-1"' } },
        ),
    );

    await connect(`${baseUrl}/v1/responses`);

    expect(cancelled).toBe(true);
  });

  it("prefers the standard version header for the models preflight cache key", async () => {
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("client_version")).toBe("1.2.3");
        return new Response(JSON.stringify({ models: [] }), {
          headers: { "content-type": "application/json", etag: '"models-versioned"' },
        });
      },
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: {
        authorization: "Bearer helm-test-key",
        version: "1.2.3",
        "x-codex-client-version": "2.3.4",
        "user-agent": "Codex Desktop/3.4.5 (macOS 26.0; arm64)",
      },
    });
    openSockets.push(socket);
    await once(socket, "open");
  });

  it("normalizes a prerelease version for models preflight and forwarded execution", async () => {
    const forwardedVersions: Array<string | null> = [];
    const baseUrl = await startBridge(
      (request) => {
        forwardedVersions.push(request.headers.get("version"));
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-version","status":"completed"}}\n\n',
                ),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("client_version")).toBe("0.145.0");
        expect(request.headers.get("version")).toBe("0.145.0");
        return new Response(JSON.stringify({ models: [] }), {
          headers: { "content-type": "application/json", etag: '"models-whole-version"' },
        });
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`, {
      version: "0.145.0-alpha.4",
    });

    await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
    });

    expect(forwardedVersions).toEqual(["0.145.0"]);
  });

  it("rejects an invalid explicit version before models preflight", async () => {
    let modelsCalled = false;
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      () => {
        modelsCalled = true;
        throw new Error("models fetch should not run");
      },
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: {
        authorization: "Bearer helm-test-key",
        version: "latest",
      },
    });
    socket.on("error", () => {});
    openSockets.push(socket);

    const [, response] = (await once(socket, "unexpected-response")) as [
      IncomingMessage,
      IncomingMessage,
    ];
    response.resume();

    expect(response.statusCode).toBe(400);
    expect(modelsCalled).toBe(false);
  });

  it("forwards a protocol-shaped maintenance response from models preflight", async () => {
    const body = {
      error: {
        message: "database maintenance in progress",
        type: "api_error",
        code: "database_maintenance",
        trace_id: "trace-maintenance",
      },
    };
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      () =>
        new Response(JSON.stringify(body), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer helm-test-key" },
    });
    socket.on("error", () => {});
    openSockets.push(socket);

    const [, response] = (await once(socket, "unexpected-response")) as [
      IncomingMessage,
      IncomingMessage,
    ];
    let payload = "";
    response.setEncoding("utf8");
    for await (const chunk of response) payload += chunk;

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(payload)).toEqual(body);
  });

  it("omits a false x-reasoning-included value because Codex treats presence as true", async () => {
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      () =>
        new Response(JSON.stringify({ models: [] }), {
          headers: {
            "content-type": "application/json",
            etag: '"models-1"',
            "x-reasoning-included": "false",
          },
        }),
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer helm-test-key" },
    });
    openSockets.push(socket);
    const upgrade = once(socket, "upgrade") as Promise<[IncomingMessage]>;
    const opened = once(socket, "open");
    const [[response]] = await Promise.all([upgrade, opened]);

    expect(response.headers["x-reasoning-included"]).toBeUndefined();
  });

  it("forwards x-reasoning-included when the preflight explicitly enables it", async () => {
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      () =>
        new Response(JSON.stringify({ models: [] }), {
          headers: {
            "content-type": "application/json",
            etag: '"models-1"',
            "x-reasoning-included": "true",
          },
        }),
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer helm-test-key" },
    });
    openSockets.push(socket);
    const upgrade = once(socket, "upgrade") as Promise<[IncomingMessage]>;
    const opened = once(socket, "open");
    const [[response]] = await Promise.all([upgrade, opened]);

    expect(response.headers["x-reasoning-included"]).toBe("true");
  });

  it("rejects invalid API keys before upgrading the websocket", async () => {
    const baseUrl = await startBridge(
      () => {
        throw new Error("response fetch should not run");
      },
      (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer invalid-key");
        return new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              code: "invalid_api_key",
              message: "invalid API key",
            },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer invalid-key" },
    });
    openSockets.push(socket);

    const { response, body } = await new Promise<{ response: IncomingMessage; body: string }>(
      (resolve, reject) => {
        socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            socket.on("error", () => {});
            socket.terminate();
            resolve({ response, body: Buffer.concat(chunks).toString() });
          });
          response.on("error", reject);
        });
      },
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(body)).toEqual({
      error: {
        type: "authentication_error",
        code: "invalid_api_key",
        message: "invalid API key",
      },
    });
  });

  it("wraps HTTP errors in the Codex websocket error envelope", async () => {
    const baseUrl = await startBridge(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              code: "invalid_api_key",
              message: "invalid key",
            },
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "x-codex-primary-used-percent": "100",
            },
          },
        ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-terra",
      input: [],
      stream: true,
    });

    expect(events).toEqual([
      {
        type: "error",
        status: 401,
        status_code: 401,
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "invalid key",
        },
        headers: {
          "x-codex-primary-used-percent": "100",
        },
      },
    ]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("normalizes nested HTTP errors into a Codex websocket error envelope", async () => {
    const baseUrl = await startBridge(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            status_code: 422,
            error: {
              type: "invalid_request_error",
              error: {
                code: "unsupported_input",
                message: "model does not support this input",
              },
            },
          }),
          {
            status: 422,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });

    expect(events).toEqual([
      {
        type: "error",
        status: 422,
        status_code: 422,
        error: {
          type: "invalid_request_error",
          code: "unsupported_input",
          message: "model does not support this input",
        },
        headers: {},
      },
    ]);
  });

  it("turns a lost continuation session into a retryable disconnect, then accepts full history", async () => {
    const bodies: Record<string, unknown>[] = [];
    let closedSessionId = "";
    const baseUrl = await startBridge(
      async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return body.previous_response_id
          ? new Response(
              'event: error\ndata: {"type":"error","code":"response_create_not_sent","message":"send full history"}\n\n',
              {
                headers: {
                  "content-type": "text/event-stream",
                  [CODEX_RESPONSES_WEBSOCKET_RECOVERY_PROOF_HEADER]: TEST_SESSION_PROOF,
                },
              },
            )
          : new Response(
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
      },
      undefined,
      {
        closeSession: (sessionId) => {
          closedSessionId = sessionId;
        },
      },
    );
    const first = await connect(`${baseUrl}/v1/responses`);
    const closed = once(first, "close");
    first.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-sol",
        previous_response_id: "resp-parent",
        input: [{ role: "user", content: "incremental" }],
      }),
    );

    const [code, reason] = await closed;
    expect(code).toBe(1012);
    expect(reason.toString()).toBe("upstream response stream disconnected");

    const second = await connect(`${baseUrl}/v1/responses`);
    const recovered = await collectTurn(second, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [
        { role: "user", content: "parent" },
        { role: "assistant", content: "parent response" },
        { role: "user", content: "incremental" },
      ],
    });

    expect(recovered.at(-1)?.type).toBe("response.completed");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.previous_response_id).toBe("resp-parent");
    expect(bodies[1]?.previous_response_id).toBeUndefined();
    expect(closedSessionId).not.toBe("");
  });

  it("turns a non-OK nested recovery marker into a retryable disconnect", async () => {
    const baseUrl = await startBridge(async () =>
      Response.json(
        {
          error: {
            code: "lane_unavailable",
            provider_raw: { error: { code: "response_create_not_sent" } },
          },
        },
        {
          status: 503,
          headers: {
            [CODEX_RESPONSES_WEBSOCKET_RECOVERY_PROOF_HEADER]: TEST_SESSION_PROOF,
          },
        },
      ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: [] }));

    const [code, reason] = await closed;
    expect(code).toBe(1012);
    expect(reason.toString()).toBe("upstream response stream disconnected");
  });

  it("does not close for an unproven private recovery code", async () => {
    const baseUrl = await startBridge(
      async () =>
        new Response(
          'event: error\ndata: {"type":"error","code":"response_create_not_sent","message":"untrusted upstream marker"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "response_create_not_sent",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("forwards an ambiguous post-send outcome without closing or replaying", async () => {
    const baseUrl = await startBridge(
      async () =>
        new Response(
          'event: error\ndata: {"type":"error","code":"response_create_outcome_unknown","message":"outcome unknown"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      {
        responseWorkAdmission: createResponseWorkAdmission({
          capacityBytes: 1_000_000,
          jsonAmplification: 1,
          minChargeBytes: 1,
        }),
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
    });

    expect(events).toEqual([
      {
        type: "error",
        code: "response_create_outcome_unknown",
        message: "outcome unknown",
      },
    ]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("cancels an unexpected successful non-SSE response body", async () => {
    let cancelled = false;
    const baseUrl = await startBridge(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"unexpected":true}'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "websocket_bridge_error" },
    });
    expect(cancelled).toBe(true);
  });

  it("cancels an upstream stream whose SSE frame exceeds the configured bound", async () => {
    let cancelled = false;
    const baseUrl = await startBridge(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(128)}`));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      { maxSseFrameBytes: 64 },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "websocket_bridge_error" },
    });
    expect(cancelled).toBe(true);
  });

  it("stops at the terminal event and cancels the internal HTTP stream", async () => {
    let cancelled = false;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;
    const encoder = new TextEncoder();
    const baseUrl = await startBridge(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-terminal","status":"completed"}}\n\n',
                ),
              );
              trailingTimer = setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"late"}\n\n',
                  ),
                );
                controller.close();
              }, 20);
            },
            cancel() {
              cancelled = true;
              if (trailingTimer !== null) clearTimeout(trailingTimer);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    const events: Record<string, unknown>[] = [];
    socket.on("message", (data) => {
      events.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-sol",
        input: [],
        stream: true,
      }),
    );
    await once(socket, "message");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cancelled).toBe(true);
    expect(events).toEqual([
      {
        type: "response.completed",
        response: { id: "resp-terminal", status: "completed" },
      },
    ]);
  });

  it("treats response.cancelled as terminal without adding a bridge error", async () => {
    let requestCount = 0;
    const baseUrl = await startBridge(
      () => {
        requestCount += 1;
        return new Response(
          requestCount === 1
            ? 'event: response.cancelled\ndata: {"type":"response.cancelled","response":{"status":"cancelled"}}\n\n'
            : 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      undefined,
      {
        memoryAdmission: createBodyMemoryAdmission({
          activeRequestBytes: 1_000_000,
          jsonAmplification: 1,
          minRequestChargeBytes: 1,
        }),
        ingressAdmission: createBodyMemoryAdmission({
          activeRequestBytes: 1_000_000,
          jsonAmplification: 1,
          minRequestChargeBytes: 1,
        }),
        responseWorkAdmission: createResponseWorkAdmission({
          capacityBytes: 1_000_000,
          jsonAmplification: 1,
          minChargeBytes: 1,
        }),
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);
    const cancelled = await collectTurn(socket, {
      type: "response.create",
      input: [],
      stream: true,
    });
    const completed = await collectTurn(socket, {
      type: "response.create",
      input: [],
      stream: true,
    });

    expect(cancelled).toEqual([{ type: "response.cancelled", response: { status: "cancelled" } }]);
    expect(completed).toEqual([{ type: "response.completed", response: { status: "completed" } }]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("does not wait for internal stream cancellation before handling the next turn", async () => {
    let requestCount = 0;
    let cancelled = false;
    let turnAborted = false;
    const encoder = new TextEncoder();
    const completedFrame =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-completed","status":"completed"}}\n\n';
    const baseUrl = await startBridge((request) => {
      requestCount += 1;
      if (requestCount === 1) {
        request.signal.addEventListener("abort", () => {
          turnAborted = true;
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(completedFrame));
            if (requestCount > 1) controller.close();
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const socket = await connect(`${baseUrl}/v1/responses`);

    await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-sol",
        input: [],
        stream: true,
      }),
    );
    for (let attempt = 0; attempt < 20 && requestCount < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(cancelled).toBe(true);
    expect(turnAborted).toBe(true);
    expect(requestCount).toBe(2);
  });

  it.each([
    ["response.failed", 1],
    ["response.incomplete", 0],
    ["error", 1],
  ] as const)("keeps the downstream websocket reusable after %s", async (terminalType, closes) => {
    let closedSessionId = "";
    let closeSessionCalls = 0;
    let requestCount = 0;
    const baseUrl = await startBridge(
      () => {
        requestCount += 1;
        const body =
          requestCount === 1
            ? `event: ${terminalType}\ndata: ${JSON.stringify({
                type: terminalType,
                ...(terminalType === "error"
                  ? { code: "synthetic_error", message: "synthetic bridge error" }
                  : { response: { status: terminalType.split(".")[1] } }),
              })}\n\n`
            : 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
      undefined,
      {
        memoryAdmission: createBodyMemoryAdmission({
          activeRequestBytes: 1_000,
          jsonAmplification: 6,
        }),
        ingressAdmission: createBodyMemoryAdmission({
          activeRequestBytes: 1_000_000,
          jsonAmplification: 1,
          minRequestChargeBytes: 1,
        }),
        responseWorkAdmission: createResponseWorkAdmission({
          capacityBytes: 1_000_000,
          jsonAmplification: 1,
          minChargeBytes: 1,
        }),
        closeSession: (sessionId) => {
          closeSessionCalls += 1;
          closedSessionId = sessionId;
        },
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const failed = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });
    const recovered = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });
    expect(failed.at(-1)?.type).toBe(terminalType);
    expect(recovered.at(-1)?.type).toBe("response.completed");
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(closedSessionId === "").toBe(closes === 0);
    expect(closeSessionCalls).toBe(closes);
  });

  it("swallows a synchronous session cleanup failure", async () => {
    const baseUrl = await startBridge(
      () =>
        new Response(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      {
        closeSession: () => {
          throw new Error("synthetic synchronous cleanup failure");
        },
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("returns a structured 400 for malformed websocket messages", async () => {
    const baseUrl = await startBridge(() => {
      throw new Error("fetch should not run");
    });
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, { type: "unsupported" });

    expect(events).toEqual([
      {
        type: "error",
        status: 400,
        status_code: 400,
        error: {
          type: "invalid_request_error",
          code: "invalid_websocket_request",
          message: "expected a response.create websocket message",
        },
        headers: {},
      },
    ]);
  });
});
