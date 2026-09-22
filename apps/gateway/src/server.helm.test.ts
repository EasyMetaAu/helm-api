import { once } from "node:events";
import { createNativePassthroughCarrier, ProviderConfigSchema } from "@helm/shared";
import { afterEach, expect, it, vi } from "vitest";
import { buildProviderClients } from "./server.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("relays Codex native items and headers only for an explicit Helm upstream", async () => {
  vi.stubEnv("HELM_RELAY_TEST_KEY", "upstream-secret");
  const body = {
    model: "gpt-6-astra",
    stream: true,
    input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "probe" }] },
    ],
    reasoning: { effort: "low", context: "all_turns" },
  };
  const sse =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n';
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
  const config = {
    name: "relay",
    type: "helm",
    target_provider_protocol: "openai_responses",
    base_url: "https://upstream.test/v1",
    api_key_env: "HELM_RELAY_TEST_KEY",
    models: [],
  };
  const client = buildProviderClients([ProviderConfigSchema.parse(config)], "", 5000).get("relay");
  expect(client?.supportsResponsesNativeItems).toBe(true);
  if (!client?.nativePassthroughStream) throw new Error("missing native relay");
  const chunks = [];
  for await (const chunk of client.nativePassthroughStream(
    createNativePassthroughCarrier({
      protocol: "openai_responses",
      body,
      rawBody: JSON.stringify(body),
      headers: {
        authorization: "Bearer client-secret",
        "x-openai-internal-codex-responses-lite": "true",
      },
    }),
  ))
    chunks.push(chunk);
  expect(chunks.join("")).toBe(sse);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://upstream.test/v1/responses");
  const init = fetch.mock.calls[0]?.[1];
  expect(JSON.parse(String(init?.body))).toEqual(body);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer upstream-secret");
  expect(new Headers(init?.headers).get("x-openai-internal-codex-responses-lite")).toBe("true");
  const generic = buildProviderClients(
    [ProviderConfigSchema.parse({ ...config, type: "openai-responses-generic" })],
    "",
    5000,
  ).get("relay");
  expect(generic?.supportsResponsesNativeItems).not.toBe(true);
});

it("wires an explicit Helm provider to one persistent upstream WebSocket", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const server = createServer();
  const ws = new WebSocketServer({ server });
  const bodies: Record<string, unknown>[] = [];
  let connections = 0;
  ws.on("connection", (socket, request) => {
    connections++;
    expect(request.headers.authorization).toBe("Bearer upstream-secret");
    expect(request.headers["x-helm-codex-responses-websocket-session"]).toBeUndefined();
    socket.on("message", (raw) => {
      bodies.push(JSON.parse(raw.toString()));
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: `r${bodies.length}`, status: "completed", output: [] },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing port");
  vi.stubEnv("HELM_RELAY_TEST_KEY", "upstream-secret");
  const client = buildProviderClients(
    [
      ProviderConfigSchema.parse({
        name: "relay",
        type: "helm",
        target_provider_protocol: "openai_responses",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key_env: "HELM_RELAY_TEST_KEY",
        models: [],
      }),
    ],
    "",
    2000,
  ).get("relay");
  try {
    if (!client?.nativePassthroughStream) throw Error("missing native stream");
    for (const previous of [undefined, "r1"]) {
      const body = {
        model: "gpt-5.6-sol",
        stream: true,
        input: [],
        ...(previous ? { previous_response_id: previous } : {}),
      };
      const chunks: string[] = [];
      for await (const chunk of client.nativePassthroughStream(
        createNativePassthroughCarrier({
          protocol: "openai_responses",
          body,
          rawBody: JSON.stringify(body),
          headers: { "x-helm-codex-responses-websocket-session": "trusted-session" },
        }),
      ))
        chunks.push(chunk);
      expect(chunks.join("")).toContain("response.completed");
    }
    expect(connections).toBe(1);
    expect(bodies[1]).toMatchObject({
      type: "response.create",
      previous_response_id: "r1",
      model: "gpt-5.6-sol",
    });
  } finally {
    await client?.closeResponsesWebSocketSession?.("trusted-session");
    await new Promise<void>((resolve, reject) =>
      ws.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
