import { createNativePassthroughCarrier } from "@helm/shared";
import { expect, it, vi } from "vitest";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnection,
  type CodexResponsesWebSocketConnector,
  createGenericOpenAIResponsesClient,
} from "./openai-responses.js";

function request(session: string, previous?: string) {
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    input: [],
    ...(previous ? { previous_response_id: previous } : {}),
  };
  return createNativePassthroughCarrier({
    protocol: "openai_responses",
    body,
    rawBody: JSON.stringify(body),
    headers: {
      authorization: "Bearer downstream-secret",
      [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: session,
    },
  });
}
async function consume(
  client: ReturnType<typeof createGenericOpenAIResponsesClient>,
  session: string,
  previous?: string,
  signal?: AbortSignal,
) {
  const chunks: string[] = [];
  if (!client.nativePassthroughStream) throw Error("missing native stream");
  for await (const chunk of client.nativePassthroughStream(request(session, previous), { signal }))
    chunks.push(chunk);
  return chunks.join("");
}
function fixture(events: Array<Record<string, unknown> | null>) {
  const close = vi.fn(async () => {});
  const send = vi.fn(async (_text: string) => {});
  const release = vi.fn();
  const connection: CodexResponsesWebSocketConnection = {
    responseHeaders: new Headers(),
    send,
    close,
    receive: async () => null,
    receiveWithWork: vi.fn(async () => {
      const event = events.shift();
      return event == null ? null : { text: JSON.stringify(event), release };
    }),
  };
  const connect = vi.fn<CodexResponsesWebSocketConnector>(async () => connection);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw Error("must not fall back to HTTP");
  });
  const client = createGenericOpenAIResponsesClient({
    config: { baseUrl: "https://remote.test/v1", apiKey: "upstream-secret", timeoutMs: 1000 },
    responsesWebSocketConnector: connect,
    fetch,
  });
  return { client, connect, connection, send, close, release, fetch };
}
const completed = (id: string) => ({
  type: "response.completed",
  response: { id, status: "completed", output: [] },
});

it("keeps two native turns on one authenticated upstream socket and closes it on ingress teardown", async () => {
  const f = fixture([completed("r1"), completed("r2")]);
  expect(await consume(f.client, "session-a")).toContain('"id":"r1"');
  expect(await consume(f.client, "session-a", "r1")).toContain('"id":"r2"');
  expect(f.connect).toHaveBeenCalledTimes(1);
  const input = f.connect.mock.calls[0]?.[0];
  if (!input) throw Error("missing connection");
  expect(input.url).toBe("wss://remote.test/v1/responses");
  expect(new Headers(input.headers).get("authorization")).toBe("Bearer upstream-secret");
  expect(new Headers(input.headers).has(CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER)).toBe(false);
  expect(JSON.parse(f.send.mock.calls[1]?.[0] ?? "null")).toMatchObject({
    type: "response.create",
    model: "gpt-5.6-sol",
    previous_response_id: "r1",
  });
  expect(f.release).toHaveBeenCalledTimes(2);
  await f.client.closeResponsesWebSocketSession?.("session-a");
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("rejects continuation without the original connection without sending or changing accounts", async () => {
  const f = fixture([]);
  await expect(consume(f.client, "new-session", "old-response")).rejects.toMatchObject({
    providerRaw: { error: { code: "response_create_not_sent" } },
  });
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});

it("never replays a request after the socket closes with an unknown execution result", async () => {
  const f = fixture([null]);
  await expect(consume(f.client, "session-a")).rejects.toMatchObject({
    providerRaw: { error: { code: "response_create_outcome_unknown" } },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("preserves proven before-send recovery across a Helm hop", async () => {
  const f = fixture([
    {
      type: "error",
      error: { code: "response_create_not_sent", message: "original session unavailable" },
    },
  ]);
  await expect(consume(f.client, "session-a")).rejects.toMatchObject({
    providerRaw: {
      error: { code: "response_create_not_sent" },
      recovery: { safe_to_replay: true },
    },
  });
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("closes a blocked receive on downstream abort and releases any late frame", async () => {
  const f = fixture([]);
  let releaseReceive!: (value: { text: string; release: () => void }) => void;
  f.connection.receiveWithWork = () =>
    new Promise((resolve) => {
      releaseReceive = resolve;
    });
  const controller = new AbortController();
  const running = consume(f.client, "session-a", undefined, controller.signal);
  await vi.waitFor(() => expect(releaseReceive).toBeTypeOf("function"));
  controller.abort();
  await expect(running).rejects.toBeDefined();
  releaseReceive({ text: JSON.stringify(completed("late")), release: f.release });
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("leaves HTTP requests on HTTP even when Helm WebSocket support is enabled", async () => {
  const f = fixture([]);
  f.fetch.mockResolvedValue(new Response('data: {"type":"response.completed"}\n\n'));
  const frames = [];
  if (!f.client.nativePassthroughStream) throw Error("missing native stream");
  for await (const frame of f.client.nativePassthroughStream({
    model: "gpt-5.6-sol",
    input: [],
    stream: true,
  }))
    frames.push(frame);
  expect(frames.join("")).toContain("response.completed");
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.connect).not.toHaveBeenCalled();
});

it("does not reuse a different ingress session's upstream socket", async () => {
  const f = fixture([completed("r1"), completed("r2")]);
  await consume(f.client, "session-a");
  await expect(consume(f.client, "session-b", "r1")).rejects.toMatchObject({
    providerRaw: { error: { code: "response_create_not_sent" } },
  });
  await consume(f.client, "session-b");
  expect(f.connect).toHaveBeenCalledTimes(2);
  await f.client.closeResponsesWebSocketSession?.("session-a");
  await expect(consume(f.client, "session-a", "r1")).rejects.toMatchObject({
    providerRaw: { error: { code: "response_create_not_sent" } },
  });
});

it.each([
  401, 403, 429,
])("preserves authoritative handshake HTTP %i without advertising replay recovery", async (status) => {
  const f = fixture([]);
  f.connect.mockRejectedValue(
    new CodexResponsesWebSocketConnectError("handshake rejected", {
      status,
      headers: new Headers({ "content-type": "application/json", "retry-after": "10" }),
      body: JSON.stringify({ error: { message: "rejected upstream-secret" } }),
    }),
  );
  await expect(consume(f.client, "session-a")).rejects.toMatchObject({
    upstreamStatus: status,
    providerRaw: { error: { message: "rejected [redacted]" } },
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
