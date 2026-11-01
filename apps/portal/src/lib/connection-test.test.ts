import { describe, expect, it, vi } from "vitest";
import { testInferenceConnection } from "./connection-test.js";

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat =
  data({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }) +
  "data: [DONE]\n\n";
const responses =
  data({ type: "response.output_text.delta", delta: "OK" }) +
  data({ type: "response.completed", response: { status: "completed" } });
const messages =
  data({
    type: "content_block_delta",
    delta: { type: "text_delta", text: "OK" },
  }) +
  data({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  data({ type: "message_stop" });
function upstream(wire: string, status = 200) {
  return vi
    .fn()
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(
      new Response(wire, {
        status,
        headers: { "content-type": "text/event-stream" },
      }),
    );
}
describe("client inference check", () => {
  it.each([
    ["sdk", "/v1/chat/completions", chat],
    ["codex", "/v1/responses", responses],
    ["claude", "/v1/messages", messages],
  ] as const)(
    "uses the real %s protocol and requires a completed answer",
    async (client, path, wire) => {
      const fetcher = upstream(wire);
      const result = await testInferenceConnection({
        origin: "https://helm.test",
        key: "test-key",
        client,
        model: "work",
        fetcher,
      });
      expect(result).toMatchObject({
        auth: true,
        inference: true,
        model: "work",
      });
      expect(fetcher.mock.calls[1][0]).toBe(`https://helm.test${path}`);
      expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
        model: "work",
        stream: true,
      });
    },
  );
  it.each([
    "",
    data({ choices: [{ delta: { content: "partial" } }] }),
    "data: [DONE]\n\n",
    chat + data({ error: { message: "secret upstream diagnostic" } }),
    data({ type: "response.incomplete" }),
  ])(
    "does not report an empty, incomplete or failed stream as success",
    async (wire) => {
      const result = await testInferenceConnection({
        origin: "https://helm.test",
        key: "test-key",
        client: "sdk",
        model: "auto",
        fetcher: upstream(wire),
      });
      expect(result).toMatchObject({ auth: true, inference: false });
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );
  it("never spends an inference call after failed authentication", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    expect(
      await testInferenceConnection({
        origin: "https://helm.test",
        key: "bad",
        client: "sdk",
        model: "auto",
        fetcher,
      }),
    ).toMatchObject({ auth: false, inference: false, status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps auth success separate from inference rejection", async () => {
    expect(
      await testInferenceConnection({
        origin: "https://helm.test",
        key: "k",
        client: "sdk",
        model: "auto",
        fetcher: upstream("no capacity", 503),
      }),
    ).toMatchObject({ auth: true, inference: false, status: 503 });
  });
});

describe("connection progress and request identity", () => {
  const input = {
    origin: "https://helm.test",
    key: "k",
    client: "sdk" as const,
    model: "auto",
  };
  it("links only the inference's internal request id and reports proven stages", async () => {
    const onStage = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "X-Helm-Request-Id": "auth-id" } }),
      )
      .mockResolvedValueOnce(
        new Response(chat, {
          headers: {
            "content-type": "text/event-stream",
            "X-Helm-Request-Id": "inference-id",
            "X-Trace-Id": "client-controlled",
          },
        }),
      );
    expect(
      await testInferenceConnection({ ...input, fetcher, onStage }),
    ).toMatchObject({
      requestId: "inference-id",
      failure: null,
      auth: true,
      inference: true,
    });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      "auth",
      "inference",
    ]);
  });
  it("never substitutes a trace id for the internal request id", async () => {
    const result = await testInferenceConnection({
      ...input,
      fetcher: upstream(chat),
    });
    expect(result.requestId).toBeNull();
  });
  it("distinguishes an unconfirmed network check from rejected credentials", async () => {
    const result = await testInferenceConnection({
      ...input,
      fetcher: vi.fn().mockRejectedValue(new TypeError("offline")),
    });
    expect(result).toMatchObject({
      auth: false,
      failure: "network",
      status: null,
    });
  });
  it("reports explicit cancellation without claiming authentication failed", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await testInferenceConnection({
      ...input,
      signal: controller.signal,
      fetcher: vi
        .fn()
        .mockRejectedValue(new DOMException("Aborted", "AbortError")),
    });
    expect(result).toMatchObject({ failure: "cancelled", inference: false });
  });
});
