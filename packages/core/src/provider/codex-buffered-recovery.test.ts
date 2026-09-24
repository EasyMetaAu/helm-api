import { describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { createCodexBufferedTurn } from "./codex-buffered-recovery.js";
import { preOutputClassifierFor } from "./failover-guard.js";
import { createOAuthPoolClient } from "./oauth/pool.js";
import { UpstreamError } from "./openai.js";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  type CodexResponsesWebSocketConnection,
  CodexResponsesWebSocketNotOpenError,
  createCodexResponsesClient,
} from "./openai-responses.js";

const created = (id: string) => ({ type: "response.created", response: { id } });
const text = (delta: string) => ({ type: "response.output_text.delta", delta });
const completed = (id: string) => ({
  type: "response.completed",
  response: { id, status: "completed", usage: {} },
});
const message = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "parent" }],
};
const done = (item: object) => ({ type: "response.output_item.done", output_index: 0, item });
function connection(turns: object[][]) {
  let pending: object[] = [];
  const sent: Record<string, unknown>[] = [];
  const value: CodexResponsesWebSocketConnection = {
    responseHeaders: new Headers(),
    async send(raw) {
      sent.push(JSON.parse(raw));
      pending = [...(turns[sent.length - 1] ?? [])];
    },
    async receive() {
      const event = pending.shift();
      return event ? JSON.stringify(event) : null;
    },
    closeInfo: () => ({ code: 1006, reason: "" }),
    close: vi.fn(async () => {}),
  };
  return { value, sent };
}
function input(extra: Record<string, unknown> = {}) {
  return {
    protocol: "openai_responses" as const,
    headers: { [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "session" },
    mutations: {},
    body: {
      model: "gpt-6-astra",
      store: false,
      stream: true,
      input: [{ role: "user", content: "hello" }],
      ...extra,
    },
  };
}
function setup(turns: object[][][], capacityBytes = 1_000_000) {
  const sockets = turns.map(connection);
  const connect = vi.fn(
    async () => sockets[Math.min(connect.mock.calls.length - 1, sockets.length - 1)]!.value,
  );
  const admission = createResponseWorkAdmission({
    capacityBytes,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  const client = createCodexResponsesClient({
    responseWorkAdmission: admission,
    fetch: vi.fn(async () => {
      throw new Error("unexpected HTTP fallback");
    }),
    config: {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      getAuthHeader: async () => "Bearer test",
      responsesWebSocketConnector: connect,
      connectRetryBackoffMs: [0],
    },
  });
  const eligibility = vi.fn();
  const run = async (body = input()) => {
    const chunks: string[] = [];
    for await (const chunk of client.nativePassthroughStream!(body, {
      codexBufferedStreamRecovery: true,
      onStreamRecoveryEligibility: eligibility,
    }))
      chunks.push(chunk);
    return chunks.join("");
  };
  return { client, sockets, connect, admission, run, eligibility };
}

describe("Codex buffered stream recovery", () => {
  it("rejects incomplete additional_tools declarations", () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 1000,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const reasons: string[] = [];
    expect(
      createCodexBufferedTurn(
        input({ input: [{ type: "additional_tools" }] }).body,
        undefined,
        admission,
        (reason) => reasons.push(reason),
      ),
    ).toBeNull();
    expect(reasons).toEqual(["unsupported_input"]);
    expect(admission.reservedBytes).toBe(0);
  });

  it("reports missing previous history instead of silently disabling recovery", () => {
    const reasons: string[] = [];
    const turn = createCodexBufferedTurn(
      input({ previous_response_id: "missing" }).body,
      undefined,
      createResponseWorkAdmission({ capacityBytes: 1000, jsonAmplification: 1, minChargeBytes: 1 }),
      (reason) => reasons.push(reason),
    );
    expect(turn).toBeNull();
    expect(reasons).toEqual(["incomplete_history"]);
  });

  it("bounds all retained histories to a quarter of the shared response budget", () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 1000,
      jsonAmplification: 2,
      minChargeBytes: 1,
    });
    const turn = createCodexBufferedTurn(input().body, undefined, admission)!;
    const histories = Array.from({ length: 20 }, () => turn.snapshot(completed("parent")));
    turn.release();
    expect(histories.some((history) => history === null)).toBe(true);
    expect(admission.reservedBytes).toBeLessThanOrEqual(250);
    for (const history of histories) history?.lease.release();
    expect(admission.reservedBytes).toBe(0);
    const next = createCodexBufferedTurn(input().body, undefined, admission)!;
    const history = next.snapshot(completed("next"));
    expect(history).not.toBeNull();
    history?.lease.release();
    next.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("discards a truncated text/tool attempt and delivers one successful attempt", async () => {
    const failedTool = {
      type: "function_call",
      name: "edit",
      call_id: "failed-call",
      arguments: "{}",
    };
    const goodTool = { ...failedTool, call_id: "good-call" };
    const s = setup([
      [[created("failed"), text("discard me"), done(failedTool)]],
      [[created("good"), done(goodTool), completed("good")]],
    ]);
    const output = await s.run(
      input({ tools: [{ type: "function", name: "edit", parameters: {} }] }),
    );
    expect(output).not.toContain("failed");
    expect(output).not.toContain("discard me");
    expect(output.match(/good-call/g)).toHaveLength(1);
    expect(s.sockets.map((c) => c.sent.length)).toEqual([1, 1]);
    await s.client.closeResponsesWebSocketSession!("session");
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("rebuilds a continuation from the exact completed parent on the same account", async () => {
    const s = setup([
      [
        [
          { type: "codex.response.metadata" },
          created("parent"),
          done(message),
          { type: "responsesapi.websocket_timing" },
          completed("parent"),
        ],
        [{ type: "codex.response.metadata" }, created("failed"), text("discard me")],
      ],
      [[created("child"), done(message), completed("child")]],
    ]);
    await s.run();
    const delta = { role: "user", content: "next" };
    const output = await s.run(input({ previous_response_id: "parent", input: [delta] }));
    expect(output).toContain("child");
    expect(output).not.toContain("failed");
    expect(s.sockets[1]!.sent[0]!.previous_response_id).toBeUndefined();
    expect(s.sockets[1]!.sent[0]!.input).toEqual([
      { role: "user", content: "hello" },
      message,
      delta,
    ]);
    await s.client.closeResponsesWebSocketSession!("session");
    expect(s.admission.reservedBytes).toBe(0);
  });

  it.each([
    { tools: [{ type: "web_search" }] },
    {
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "remote",
              tools: [{ type: "mcp", server_url: "https://remote.test" }],
            },
          ],
        },
      ],
    },
    { background: true },
    { generate: false },
  ])("does not replay an ineligible request %j", async (extra) => {
    const s = setup([[[created("failed"), text("partial")]]]);
    await expect(s.run(input(extra))).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("reports unsupported activity when an armed turn cannot be replayed", async () => {
    const s = setup([[[created("failed"), { type: "response.web_search_call.in_progress" }]]]);
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.eligibility).toHaveBeenLastCalledWith({
      eligible: false,
      reason: "unsupported_event",
    });
  });

  it("stops after one replay and releases all buffered work", async () => {
    const s = setup([[[created("failed1"), text("one")]], [[created("failed2"), text("two")]]]);
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(2);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("does not replay unparseable upstream activity", async () => {
    const s = setup([[[created("bad")]]]);
    let received = false;
    s.sockets[0]!.value.receive = async () => {
      if (received) return null;
      received = true;
      return "{broken";
    };
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("does not replay explicit provider errors", async () => {
    const s = setup([
      [
        [
          created("rejected"),
          { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "quota" } },
        ],
      ],
    ]);
    await expect(s.run()).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });
  it("never reconstructs a parent whose streamed output items were incomplete", async () => {
    const s = setup([
      [
        [created("parent"), text("missing done item"), completed("parent")],
        [created("child"), text("cut")],
      ],
    ]);
    await s.run();
    await expect(s.run(input({ previous_response_id: "parent" }))).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("does not mark an unsent second attempt as proof the original request was unsent", async () => {
    const s = setup([[[created("failed"), text("discard")]], [[]]]);
    s.sockets[1]!.value.send = async () => {
      throw new CodexResponsesWebSocketNotOpenError();
    };
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(2);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it.each([
    "limit",
    "oversized",
  ])("never falls through to a third inference after replay %s", async (failure) => {
    const s = setup([
      [[created("cut"), text("discard")]],
      [
        [
          ...(failure === "limit"
            ? [
                {
                  type: "error",
                  status: 429,
                  error: { code: "websocket_connection_limit_reached", message: "limit" },
                },
              ]
            : []),
        ],
      ],
    ]);
    if (failure === "oversized")
      s.sockets[1]!.value.closeInfo = () => ({ code: 1009, reason: "large" });
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(2);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it("releases an overflowing buffer without replay", async () => {
    const s = setup([[[created("large"), text("x".repeat(2_000))]]], 600);
    await expect(s.run()).rejects.toMatchObject({
      providerRaw: { error: { code: "response_work_capacity_exhausted" } },
    });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });

  it.each([
    "timeout",
    "send",
    "abort",
  ])("does not replay %s and releases the buffer", async (failure) => {
    const s = setup([[[created("partial")]]]);
    const abort = new AbortController();
    const receive = s.sockets[0]!.value.receive;
    let received = false;
    if (failure === "send")
      s.sockets[0]!.value.send = async () => {
        throw new Error("callback failed");
      };
    else
      s.sockets[0]!.value.receive = async () => {
        if (!received) {
          received = true;
          return receive();
        }
        if (failure === "abort") {
          abort.abort(new Error("cancelled"));
          return null;
        }
        throw new UpstreamError("timeout", "idle timeout");
      };
    const drain = async () => {
      for await (const _ of s.client.nativePassthroughStream!(input(), {
        codexBufferedStreamRecovery: true,
        signal: abort.signal,
      })) {
      }
    };
    await expect(drain()).rejects.toThrow();
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.admission.reservedBytes).toBe(0);
  });
  it("keeps a successful replay inside the selected OAuth account", async () => {
    const s = setup([
      [[created("cut"), text("discard")]],
      [[created("ok"), text("answer"), completed("ok")]],
    ]);
    const unused = vi.fn(async function* () {
      yield* [];
      throw new Error("must not rotate account");
    });
    const selected = vi.fn();
    const pool = createOAuthPoolClient({
      members: [
        { account: "original", schedulable: true, priority: 0, client: s.client },
        {
          account: "other",
          schedulable: true,
          priority: 0,
          client: { ...s.client, nativePassthroughStream: unused },
        },
      ],
      nativeStreamPreambleClassifier: preOutputClassifierFor("openai_responses"),
      onSelect: selected,
    });
    let result = "";
    for await (const chunk of pool.nativePassthroughStream!(input(), {
      codexBufferedStreamRecovery: true,
    }))
      result += chunk;
    expect(result).toContain("answer");
    expect(result).not.toContain("discard");
    expect(unused).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0]?.[0]).toBe("original");
    await s.client.closeResponsesWebSocketSession!("session");
    expect(s.admission.reservedBytes).toBe(0);
  });
});
