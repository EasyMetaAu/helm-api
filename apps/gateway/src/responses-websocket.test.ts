import { once } from "node:events";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  installResponsesWebSocketBridge,
  isResponsesWebSocketPath,
  type ResponsesWebSocketUpgradeServer,
} from "./responses-websocket.js";

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
}

const openBridges: Array<{ close(): Promise<void> }> = [];
const openServers: ReturnType<typeof createServer>[] = [];
const openSockets: WebSocket[] = [];

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
    const preflight = new Promise<Response>((resolve) => {
      resolvePreflight = resolve;
    });
    const bridge = installResponsesWebSocketBridge({
      server,
      fetch: () => {
        preflightStarted = true;
        return preflight;
      },
    });
    openBridges.push(bridge);

    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.method = "GET";
    request.url = "/v1/responses";
    upgradeListener?.(request, socket, Buffer.alloc(0));
    expect(preflightStarted).toBe(true);

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
    expect(response.headers["sec-websocket-extensions"]).toContain("permessage-deflate");
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

  it("does not wait for internal stream cancellation before handling the next turn", async () => {
    let requestCount = 0;
    let cancelled = false;
    const encoder = new TextEncoder();
    const completedFrame =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-completed","status":"completed"}}\n\n';
    const baseUrl = await startBridge(() => {
      requestCount += 1;
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
    expect(requestCount).toBe(2);
  });

  it.each([
    "response.failed",
    "response.incomplete",
    "error",
  ] as const)("destroys the internal upstream session after %s", async (terminalType) => {
    let closedSessionId = "";
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const baseUrl = await startBridge(
      () =>
        new Response(
          `event: ${terminalType}\ndata: ${JSON.stringify({
            type: terminalType,
            ...(terminalType === "error"
              ? { code: "synthetic_error", message: "synthetic bridge error" }
              : { response: { status: terminalType.split(".")[1] } }),
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      undefined,
      {
        closeSession: (sessionId) => {
          closedSessionId = sessionId;
          resolveClosed();
        },
      },
    );
    const socket = await connect(`${baseUrl}/v1/responses`);

    const events = await collectTurn(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
    });
    const closeResult = await Promise.race([
      closed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(events.at(-1)?.type).toBe(terminalType);
    expect(closeResult).toBe("closed");
    expect(closedSessionId).not.toBe("");
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
