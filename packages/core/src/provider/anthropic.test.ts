import { describe, expect, it, vi } from "vitest";
import {
  anthropicToOpenAIResponse,
  createAnthropicClient,
  openaiToAnthropicRequest,
  translateAnthropicSSE,
} from "./anthropic.js";
import { UpstreamError } from "./openai.js";

describe("openaiToAnthropicRequest", () => {
  it("prepends the Claude-Code system spoof and maps messages + max_tokens", () => {
    const body = openaiToAnthropicRequest({
      model: "claude-opus-4-6",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      temperature: 0.5,
    });
    const sys = body.system as Array<{ text: string }>;
    expect(sys[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[1]?.text).toBe("Be terse.");
    expect(body.max_tokens).toBe(4096); // defaulted
    expect(body.temperature).toBe(0.5);
    const msgs = body.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs[0]?.content[0]).toMatchObject({ type: "text", text: "Hi" });
  });

  it("maps assistant tool_calls -> tool_use and tool results -> tool_result", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "get", arguments: '{"x":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "get", parameters: { type: "object" } } }],
    });
    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]?.content[0]).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "get",
      input: { x: 1 },
    });
    expect(msgs[1]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(body.tools as unknown[]).toHaveLength(1);
  });
});

describe("anthropicToOpenAIResponse", () => {
  it("maps text + usage + stop_reason", () => {
    const out = anthropicToOpenAIResponse(
      {
        id: "msg_1",
        content: [{ type: "text", text: "hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-opus-4-6",
    ) as Record<string, unknown>;
    const choice = (out.choices as Array<Record<string, unknown>>)[0];
    expect((choice?.message as Record<string, unknown>).content).toBe("hello world");
    expect(choice?.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("maps tool_use -> tool_calls with finish_reason tool_calls", () => {
    const out = anthropicToOpenAIResponse(
      {
        id: "msg_2",
        content: [{ type: "tool_use", id: "t1", name: "get", input: { x: 1 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "m",
    ) as Record<string, unknown>;
    const choice = (out.choices as Array<Record<string, unknown>>)[0];
    const tc = (choice?.message as Record<string, unknown>).tool_calls as Array<
      Record<string, unknown>
    >;
    expect(tc[0]).toMatchObject({ id: "t1", type: "function" });
    expect((tc[0]?.function as Record<string, unknown>).arguments).toBe('{"x":1}');
    expect(choice?.finish_reason).toBe("tool_calls");
  });
});

function sseResponse(events: object[]): Response {
  const body = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("translateAnthropicSSE", () => {
  it("maps message_start/content_block_delta/message_delta/message_stop to OpenAI chunks + [DONE]", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    const chunks: string[] = [];
    for await (const c of translateAnthropicSSE(res, "m")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"Hel"');
    expect(joined).toContain('"content":"lo"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createAnthropicClient", () => {
  it("sends Bearer + Claude-Code identity headers + system spoof; 401-retries once", async () => {
    let calls = 0;
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const h = new Headers(init?.headers);
      seenAuth.push(h.get("Authorization") ?? "");
      expect(h.get("anthropic-beta")).toContain("oauth-2025-04-20");
      expect(h.get("user-agent")).toContain("claude-cli/");
      expect(h.get("x-app")).toBe("cli");
      const sys = (JSON.parse(String(init?.body)) as { system: Array<{ text: string }> }).system;
      expect(sys[0]?.text).toContain("You are Claude Code");
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
      return jsonResponse({
        id: "msg",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    let token = "AT1";
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = "AT2";
        },
        currentSecrets: () => [token],
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const resp = (await client.chatCompletion({
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    })) as Record<string, unknown>;
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(["Bearer AT1", "Bearer AT2"]);
    expect(
      ((resp.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>)
        .content,
    ).toBe("ok");
  });

  it("throws UpstreamError on a persistent non-401 error", async () => {
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("requires exactly one of apiKey / getAuthHeader", () => {
    expect(() =>
      createAnthropicClient({
        config: { baseUrl: "https://x", apiKey: "k", getAuthHeader: async () => "Bearer y" },
      }),
    ).toThrow(/exactly one/);
  });
});
