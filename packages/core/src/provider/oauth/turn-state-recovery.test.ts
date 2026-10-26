import type { NativePassthroughCarrier } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { preOutputClassifierFor } from "../failover-guard.js";
import { UpstreamError } from "../openai.js";
import { createCodexResponsesClient } from "../openai-responses.js";
import { createOAuthPoolClient } from "./pool.js";

const history = [
  { role: "user", content: "fix this" },
  { type: "reasoning", encrypted_content: "opaque-preserve" },
  { type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "patch" },
  { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
];
function carrier(extra: Record<string, unknown> = {}): NativePassthroughCarrier {
  const body = { model: "gpt-test", store: false, stream: true, input: history, ...extra };
  return {
    protocol: "openai_responses",
    body,
    raw_body: JSON.stringify(body),
    headers: { "X-Codex-Turn-State": "state-a", "x-codex-turn-metadata": "turn-1" },
    mutations: {},
  };
}
async function drain(stream: AsyncIterable<string>) {
  for await (const _ of stream) {
    /* drain */
  }
}
async function setup(stream: boolean, extra: Record<string, unknown> = {}) {
  const sent: { account: string; headers: Headers; body: string }[] = [];
  const meta = vi.fn();
  let bSequence = 0;
  const client = (account: string) =>
    createCodexResponsesClient({
      config: { baseUrl: "https://codex.test", getAuthHeader: async () => "Bearer synthetic" },
      fetch: async (_url, init) => {
        sent.push({ account, headers: new Headers(init?.headers), body: String(init?.body) });
        const state = account === "a" ? "state-a" : ++bSequence === 1 ? "stale-b" : "fresh-b";
        const response = { id: `resp-${account}`, status: "completed", output: [] };
        return new Response(
          stream
            ? `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`
            : JSON.stringify(response),
          {
            headers: {
              "x-codex-turn-state": state,
              "content-type": stream ? "text/event-stream" : "application/json",
            },
          },
        );
      },
    });
  const a = client("a"),
    b = client("b");
  const pool = createOAuthPoolClient({
    members: [
      { account: "a", priority: 0, schedulable: true, client: a },
      { account: "b", priority: 1, schedulable: true, client: b },
    ],
    nativeStreamPreambleClassifier: preOutputClassifierFor("openai_responses"),
    now: () => 1000,
  });
  const call = async (c: typeof a, input: NativePassthroughCarrier) => {
    if (!c.nativePassthroughStream || !c.nativePassthrough)
      throw new Error("Missing native methods");
    if (stream) await drain(c.nativePassthroughStream(input, { onResponseMeta: meta }));
    else await c.nativePassthrough(input, { onResponseMeta: meta });
  };
  const seed = carrier();
  delete seed.headers["X-Codex-Turn-State"];
  await call(pool, seed);
  await call(b, seed);
  pool.setUsageLimit("a", 601000);
  sent.length = 0;
  meta.mockClear();
  return { pool, b, sent, meta, call, input: carrier(extra) };
}

describe("Codex unavailable turn-state account recovery", () => {
  it.each([
    true,
    false,
  ])("reselects before sending with complete history, stream=%s", async (stream) => {
    const s = await setup(stream);
    const original = JSON.stringify(s.input.body),
      originalHeaders = { ...s.input.headers };
    await s.call(s.pool, s.input);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.account).toBe("b");
    expect(s.sent[0]?.headers.get("x-codex-turn-state")).toBeNull();
    expect(JSON.parse(s.sent[0]?.body ?? "{}").input).toEqual(history);
    expect(JSON.stringify(s.input.body)).toBe(original);
    expect(s.input.headers).toEqual(originalHeaders);
    expect(s.meta.mock.calls.at(-1)?.[0].get("x-codex-turn-state")).toBe("fresh-b");
    const next = carrier();
    next.headers["X-Codex-Turn-State"] = "fresh-b";
    await s.call(s.pool, next);
    expect(s.sent[1]?.account).toBe("b");
    delete next.headers["X-Codex-Turn-State"];
    await s.call(s.b, next);
    expect(s.sent[2]?.headers.get("x-codex-turn-state")).toBe("fresh-b");
  });
  it.each([
    { previous_response_id: "resp-a" },
    { conversation: "conversation-a" },
    { prompt: { id: "prompt-a" } },
    { input: [{ type: "item_reference", id: "item-a" }] },
    {
      input: [
        { role: "user", content: "go" },
        { type: "function_call_output", call_id: "missing", output: "done" },
      ],
    },
    {
      input: [
        { role: "user", content: "go" },
        { type: "custom_tool_call", call_id: "c", name: "x" },
        { type: "function_call_output", call_id: "c", output: "done" },
      ],
    },
    { input: [{ type: "compaction", encrypted_content: "opaque" }] },
  ])("keeps unresolved server history pinned: %j", async (extra) => {
    const s = await setup(true, extra);
    await expect(s.call(s.pool, s.input)).rejects.toThrow(/original account.*unavailable/);
    expect(s.sent).toHaveLength(0);
  });
  it("does not repeat a post-send failure while recovering the routing hint", async () => {
    const s = await setup(true);
    const failure = new UpstreamError(
      "upstream_error",
      "outcome unknown",
      {
        error: { code: "response_create_outcome_unknown" },
      },
      400,
    );
    const send = vi.fn(async function* () {
      yield await Promise.reject<string>(failure);
    });
    s.b.nativePassthroughStream = send;
    await expect(s.call(s.pool, s.input)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not bypass a WebSocket session or an unavailable alternate", async () => {
    const s = await setup(true);
    s.input.headers["x-helm-codex-responses-websocket-session"] = "session";
    await expect(s.call(s.pool, s.input)).rejects.toThrow();
    expect(s.sent).toHaveLength(0);
    delete s.input.headers["x-helm-codex-responses-websocket-session"];
    s.pool.setUsageLimit("b", 601000);
    await expect(s.call(s.pool, s.input)).rejects.toThrow();
    expect(s.sent).toHaveLength(0);
  });
});
