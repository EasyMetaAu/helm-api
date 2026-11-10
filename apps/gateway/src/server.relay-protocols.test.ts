import { ProviderConfigSchema } from "@helm/shared";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { relayClientIdentityMiddleware } from "./middleware/relay-client-identity.js";
import { buildProviderClients } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ["openai_chat", "/v1/chat/completions"],
  ["openai_responses", "/v1/responses"],
  ["anthropic_messages", "/v1/messages"],
  ["gemini", "/v1/models/grok:generateContent"],
] as const)("keeps inbound identity through the Helm %s adapter", async (protocol, expectedPath) => {
  vi.stubEnv("RELAY_TEST_KEY", "upstream-key");
  const calls: { path: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, headers: new Headers(init?.headers) });
      return Response.json({ error: { message: "diagnostic stop" } }, { status: 400 });
    }),
  );
  const provider = ProviderConfigSchema.parse({
    name: "relay",
    type: "helm",
    target_provider_protocol: protocol,
    base_url:
      protocol === "anthropic_messages" ? "https://upstream.test" : "https://upstream.test/v1",
    api_key_env: "RELAY_TEST_KEY",
    models: [{ alias: "relay/grok", provider_model: "grok" }],
  });
  const client = buildProviderClients([provider], "https://unused.test", 1000).get("relay");
  if (!client) throw new Error("missing relay");
  const app = new Hono();
  app.use("*", relayClientIdentityMiddleware());
  app.post("/", async (c) => {
    const req = { model: "grok", messages: [{ role: "user", content: "Reply OK only." }] };
    await expect(client.chatCompletion(req)).rejects.toThrow();
    return c.text("captured");
  });
  const uas = ["grok-shell/1.0.77 (macos; aarch64)", "claude-cli/2.1.319 (external, cli)"];
  await Promise.all(
    uas.map((ua) => app.request("/", { method: "POST", headers: { "user-agent": ua } })),
  );
  expect(calls.map((c) => c.path)).toEqual([expectedPath, expectedPath]);
  expect(calls.map((c) => c.headers.get("user-agent")).sort()).toEqual([...uas].sort());
  for (const call of calls) {
    expect(
      call.headers.get("authorization") ??
        call.headers.get("x-api-key") ??
        call.headers.get("x-goog-api-key"),
    ).toMatch(/upstream-key/);
  }
});

it("preserves the inbound UA at the Helm Responses WebSocket handshake", async () => {
  const { createNativePassthroughCarrier } = await import("@helm/shared");
  const { CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER } = await import("@helm/core");
  const websocket = await import("./codex-responses-websocket.js");
  const connect = vi.fn(async () => ({
    responseHeaders: new Headers(),
    send: vi.fn(async () => {}),
    receive: vi.fn(async () =>
      JSON.stringify({
        type: "response.completed",
        response: { id: "r", status: "completed", output: [] },
      }),
    ),
    close: vi.fn(async () => {}),
  }));
  const factory = vi
    .spyOn(websocket, "createCodexResponsesWebSocketConnector")
    .mockReturnValue(connect);
  vi.stubEnv("RELAY_TEST_KEY", "upstream-key");
  try {
    const provider = ProviderConfigSchema.parse({
      name: "relay",
      type: "helm",
      target_provider_protocol: "openai_responses",
      base_url: "https://upstream.test/v1",
      api_key_env: "RELAY_TEST_KEY",
      models: [{ alias: "relay/grok", provider_model: "grok" }],
    });
    const client = buildProviderClients([provider], "https://unused.test", 1000).get("relay");
    if (!client?.nativePassthroughStream) throw new Error("missing stream relay");
    const app = new Hono();
    app.use("*", relayClientIdentityMiddleware());
    app.post("/", async (c) => {
      const body = { model: "grok", input: [], stream: true };
      const request = createNativePassthroughCarrier({
        protocol: "openai_responses",
        body,
        rawBody: JSON.stringify(body),
        headers: {
          "user-agent": "stale-translated-agent",
          authorization: "Bearer inbound-key",
          [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "session-test",
        },
      });
      const chunks = [];
      for await (const chunk of client.nativePassthroughStream?.(request) ?? []) chunks.push(chunk);
      await client.closeResponsesWebSocketSession?.("session-test");
      return c.text(chunks.join(""));
    });
    const ua = "grok-shell/1.0.77 (macos; aarch64)";
    const response = await app.request("/", { method: "POST", headers: { "user-agent": ua } });
    expect(await response.text()).toContain("response.completed");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": ua,
          authorization: "Bearer upstream-key",
        }),
      }),
    );
  } finally {
    factory.mockRestore();
  }
});
