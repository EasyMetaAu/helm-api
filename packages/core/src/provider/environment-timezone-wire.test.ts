import { createNativePassthroughCarrier } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "./anthropic.js";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  createCodexResponsesClient,
  createGenericOpenAIResponsesClient,
} from "./openai-responses.js";

const environment =
  "<environment_context>\n<current_date>2026-10-15</current_date>\n<timezone>Asia/Shanghai</timezone>\n</environment_context>";
const input = [{ role: "user", content: [{ type: "input_text", text: environment }] }];
afterEach(() => vi.useRealTimers());

describe("environment timezone at final transport boundary", () => {
  it("Claude captures converted bytes, preserves response dates and original raw request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T02:00:00Z"));
    const response = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Meeting 2026-10-15 Asia/Shanghai" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    const client = createAnthropicClient({
      config: { baseUrl: "https://provider.test", apiKey: "test" },
      fetch,
      resolveEnvironmentTimezone: async () => "America/Los_Angeles",
    });
    const body = {
      model: "claude",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Today's date is 2026-10-15.</system-reminder>",
            },
          ],
        },
      ],
    };
    const carrier = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body,
      rawBody: JSON.stringify(body),
      headers: {},
    });
    const captureUpstream = vi.fn();
    expect(await client.nativePassthrough?.(carrier, { captureUpstream })).toEqual(response);
    const wire = String(fetch.mock.calls[0]?.[1]?.body);
    expect(wire).toContain("2026-10-14");
    expect(captureUpstream).toHaveBeenCalledWith(wire);
    expect(carrier.raw_body).toContain("2026-10-15");
  });
  it.each([
    "codex",
    "grok",
  ])("%s streaming request is converted; response text and tool arguments stay unchanged", async (provider) => {
    const event = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "c",
            name: "schedule",
            arguments: '{"timezone":"Asia/Shanghai","date":"2026-10-15"}',
          },
        ],
      },
    };
    const sse = `data: ${JSON.stringify(event)}\n\n`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      );
    const deps = {
      config: { baseUrl: "https://provider.test", getAuthHeader: async () => "Bearer test" },
      fetch,
      resolveEnvironmentTimezone: async () => "America/Los_Angeles",
    };
    const client =
      provider === "codex"
        ? createCodexResponsesClient(deps)
        : createGenericOpenAIResponsesClient(deps);
    const body = { model: "model", input, stream: true };
    const captureUpstream = vi.fn();
    let result = "";
    for await (const chunk of client.nativePassthroughStream?.(body, { captureUpstream }) ?? [])
      result += chunk;
    expect(result).toBe(sse);
    expect(result).toContain("Asia/Shanghai");
    expect(result).toContain("2026-10-15");
    expect(result).toContain("function_call");
    const wire = String(fetch.mock.calls[0]?.[1]?.body);
    expect(wire).toContain("America/Los_Angeles");
    expect(captureUpstream).toHaveBeenCalledWith(wire);
    expect(input[0]?.content[0]?.text).toBe(environment);
  });
});

it("Codex compact and WebSocket use the same conversion without changing continuation ids", async () => {
  let timezone = "America/Los_Angeles";
  const sent: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json({ output: [] }));
  const connect = vi.fn(async () => ({
    responseHeaders: new Headers(),
    send: async (text: string) => {
      sent.push(text);
    },
    receive: async () =>
      JSON.stringify({
        type: "response.completed",
        response: { id: `resp_${sent.length}`, status: "completed", output: [] },
      }),
    close: async () => {},
  }));
  const client = createCodexResponsesClient({
    config: {
      baseUrl: "https://provider.test",
      getAuthHeader: async () => "Bearer test",
      responsesWebSocketConnector: connect,
    },
    fetch,
    resolveEnvironmentTimezone: async () => timezone,
  });
  await client.responsesCompact?.({ model: "gpt-5.5", input });
  expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("America/Los_Angeles");
  for (const zone of ["America/Los_Angeles", "America/New_York"]) {
    timezone = zone;
    const body = {
      model: "gpt-5.5",
      input,
      stream: true,
      ...(sent.length ? { previous_response_id: "resp_1" } : {}),
    };
    const carrier = createNativePassthroughCarrier({
      protocol: "openai_responses",
      body,
      headers: { [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "ingress-one" },
    });
    for await (const _ of client.nativePassthroughStream?.(carrier) ?? []) {
      /* drain */
    }
    expect(sent.at(-1)).toContain(zone);
  }
  expect(connect).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sent[1] ?? "{}").previous_response_id).toBe("resp_1");
  expect(input[0]?.content[0]?.text).toBe(environment);
  await client.closeResponsesWebSocketSession?.("ingress-one");
});
