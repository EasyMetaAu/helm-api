import { createNativePassthroughCarrier } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "./anthropic.js";

const sdkIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const identity = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.318; cc_entrypoint=cli;" },
  { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: "text", text: sdkIdentity },
];
const business = {
  type: "text",
  text: "Summarize receipts. Mention x-anthropic-billing-header only if asked.",
  cache_control: { type: "ephemeral" },
};
const sse =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","usage":{"input_tokens":18}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("official API key native identity boundary", () => {
  it.each([
    "json",
    "stream",
    "count",
  ] as const)("removes only CLI and SDK identity on %s without mutating the source", async (mode) => {
    let sent: RequestInit | undefined;
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 128000,
      stream: mode === "stream",
      system: [...identity, business],
      messages: [{ role: "user", content: "OK" }],
      metadata: { user_id: "opaque-user" },
    };
    const input = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body,
      rawBody: JSON.stringify(body),
      headers: {
        "anthropic-beta": "oauth-2025-04-20,structured-outputs-2025-11-13",
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.318",
        "x-claude-code-session-id": "client-session",
      },
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test" },
      fetch: (async (_url, init) => {
        sent = init;
        return mode === "stream"
          ? new Response(sse, { headers: { "content-type": "text/event-stream" } })
          : Response.json(
              mode === "count"
                ? { input_tokens: 18 }
                : {
                    content: [{ type: "text", text: "OK" }],
                    usage: { input_tokens: 18, output_tokens: 4 },
                  },
            );
      }) as typeof fetch,
    });
    if (mode === "stream") {
      for await (const _ of client.nativePassthroughStream!(input)) {
        /* drain */
      }
    } else if (mode === "count") await client.countTokens!({ ...input });
    else await client.nativePassthrough!(input);
    expect(JSON.parse(String(sent?.body))).toEqual({ ...body, system: [business] });
    const headers = new Headers(sent?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    expect(headers.get("anthropic-beta")).toContain("structured-outputs-2025-11-13");
    expect(headers.get("anthropic-beta")).not.toContain("oauth-");
    for (const name of ["authorization", "x-app", "user-agent", "x-claude-code-session-id"])
      expect(headers.has(name)).toBe(false);
    expect(input.body.system).toEqual([...identity, business]);
    expect(input.headers["x-app"]).toBe("cli");
  });
  it("removes a standalone SDK identity line and retains business text mentioning it", async () => {
    const businessText = `Document this example identity: ${sdkIdentity}`;
    const body = {
      model: "claude-sonnet-5-5",
      system: `${sdkIdentity}\n${businessText}`,
      messages: [{ role: "user", content: "OK" }],
    };
    let sent: RequestInit | undefined;
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test" },
      fetch: (async (_url, init) => {
        sent = init;
        return Response.json({ content: [], usage: {} });
      }) as typeof fetch,
    });
    await client.nativePassthrough!(body);
    expect(JSON.parse(String(sent?.body)).system).toBe(businessText);
    expect(body.system).toBe(`${sdkIdentity}\n${businessText}`);
  });
  it("preserves relay identity blocks and raw bytes", async () => {
    const body = {
      model: "anthropic/claude-sonnet-5.5",
      system: [...identity, business],
      messages: [{ role: "user", content: "OK" }],
    };
    const raw = JSON.stringify(body, null, 2);
    let sent: RequestInit | undefined;
    const client = createAnthropicClient({
      config: { baseUrl: "https://zenmux.ai/api/anthropic", apiKey: "sk-relay" },
      fetch: (async (_url, init) => {
        sent = init;
        return Response.json({ content: [], usage: {} });
      }) as typeof fetch,
    });
    await client.nativePassthrough!(
      createNativePassthroughCarrier({
        protocol: "anthropic_messages",
        body,
        rawBody: raw,
        headers: {},
      }),
    );
    expect(sent?.body).toBe(raw);
  });
});

it.each([
  false,
  true,
])("preserves billed USD through translated Anthropic (stream=%s)", async (stream) => {
  const usage = { input_tokens: 18, output_tokens: 4, cost: "0.000152", inference_geo: "global" };
  const wire = `data: ${JSON.stringify({ type: "message_start", message: { id: "msg", usage: { ...usage, output_tokens: 0, cost: "0.000072" } } })}\n\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage })}\n\ndata: {"type":"message_stop"}\n\n`;
  const client = createAnthropicClient({
    config: { baseUrl: "https://zenmux.ai/api/anthropic", apiKey: "sk-relay" },
    fetch: (async () =>
      stream
        ? new Response(wire, { headers: { "content-type": "text/event-stream" } })
        : Response.json({
            id: "msg",
            content: [{ type: "text", text: "OK" }],
            usage,
          })) as typeof fetch,
  });
  const req = {
    model: "anthropic/claude-opus-5.5",
    messages: [{ role: "user" as const, content: "OK" }],
  };
  if (stream) {
    let raw = "";
    for await (const chunk of client.chatCompletionStream(req)) raw += chunk;
    const frames = raw
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    expect(frames.find((f) => f.usage)?.usage.cost_usd).toBe(0.000152);
  } else expect((await client.chatCompletion(req)).usage).toMatchObject({ cost_usd: 0.000152 });
});

it("keeps the original subscription identity for OAuth native forwarding", async () => {
  const body = {
    model: "claude-sonnet-5-5",
    system: [...identity, business],
    messages: [{ role: "user", content: "OK" }],
  };
  let sent: RequestInit | undefined;
  const client = createAnthropicClient({
    config: {
      baseUrl: "https://api.anthropic.com",
      getAuthHeader: async () => "Bearer test-oauth",
      claudeCliFingerprintMode: "off",
    },
    fetch: (async (_url, init) => {
      sent = init;
      return Response.json({ content: [], usage: {} });
    }) as typeof fetch,
  });
  await client.nativePassthrough!(
    createNativePassthroughCarrier({ protocol: "anthropic_messages", body, headers: {} }),
  );
  expect(JSON.parse(String(sent?.body)).system).toEqual(body.system);
  expect(new Headers(sent?.headers).get("authorization")).toBe("Bearer test-oauth");
});
