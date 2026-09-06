import { createNativePassthroughCarrier } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { preOutputClassifierFor } from "./failover-guard.js";
import { createOAuthPoolClient, type OAuthPoolMember } from "./oauth/pool.js";
import type { ProviderCallOptions } from "./openai.js";
import { createCodexResponsesClient } from "./openai-responses.js";
import { type OverloadRetryBudget, waitForOverloadRetry } from "./retry.js";

const preamble =
  'data: {"type":"response.output_item.added","item":{"type":"reasoning","summary":[]}}\n\n';
const output = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n';
const overload =
  'data: {"type":"error","error":{"code":"server_is_overloaded","message":"busy"}}\n\n';
const body = { model: "gpt-test", stream: true, input: [] };
async function drain(stream: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function member(open: (opts?: ProviderCallOptions) => AsyncIterable<string>): OAuthPoolMember {
  return {
    account: "a",
    schedulable: true,
    priority: 0,
    client: {
      async chatCompletion() {
        return {};
      },
      chatCompletionStream: (_req, opts) => open(opts),
      nativePassthroughStream: (_req, opts) => open(opts),
    },
  };
}
function pool(account: OAuthPoolMember) {
  return createOAuthPoolClient({
    members: [account],
    nativeStreamPreambleClassifier: preOutputClassifierFor("openai_responses"),
  });
}
afterEach(() => vi.useRealTimers());

describe("bounded pre-output overload recovery", () => {
  it("shares two retries between HTTP rejection and in-band failure", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const budget: OverloadRetryBudget = { attempt: 0, onRetry: (event) => events.push(event) };
    let sends = 0;
    const account = member(async function* () {});
    account.client = createCodexResponsesClient({
      responseWorkAdmission: createResponseWorkAdmission({
        capacityBytes: 1024 * 1024,
        jsonAmplification: 1,
        minChargeBytes: 1,
      }),
      config: { baseUrl: "https://upstream.test/codex", getAuthHeader: async () => "Bearer test" },
      fetch: async () => {
        sends++;
        return new Response(sends === 1 ? "busy" : preamble + overload, {
          status: sends === 1 ? 503 : 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const result = drain(pool(account).nativePassthroughStream!(body, { overloadRetry: budget }));
    const rejected = expect(result).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(999);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toBe(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(sends).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(sends).toBe(3);
    expect(budget.exhausted).toBe(true);
    expect(events).toMatchObject([
      { reason: "http_503", attempt: 1, delay_ms: 1000, exhausted: false },
      { reason: "in_band_overload", attempt: 2, delay_ms: 3000, exhausted: false },
      { reason: "in_band_overload", attempt: 2, delay_ms: 0, exhausted: true },
    ]);
  });

  it.each([
    "chatCompletion",
    "nativePassthrough",
  ] as const)("stops exhausted HTTP overload retries before unary siblings: %s", async (method) => {
    vi.useFakeTimers();
    let sends = 0;
    const account = member(async function* () {});
    account.client = createCodexResponsesClient({
      config: { baseUrl: "https://upstream.test/codex", getAuthHeader: async () => "Bearer test" },
      fetch: async () => {
        sends++;
        return new Response("busy", { status: 503 });
      },
    });
    const client = createOAuthPoolClient({ members: [account, { ...account, account: "b" }] });
    const result = client[method]!({ ...body, messages: [] });
    const caught = result.catch((error) => error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await caught).toMatchObject({ upstreamStatus: 503 });
    expect(sends).toBe(3);
  });

  it.each([
    'data: {"type":"error","error":{"message":"overloaded"}}\n\n',
    'data: {"type":"error","error":{"code":"invalid_request","message":"overloaded"}}\n\n',
  ])("does not replay a message-only or unrelated error", async (error) => {
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield preamble + error;
    });
    await expect(drain(pool(account).nativePassthroughStream!(body))).rejects.toThrow("overloaded");
    expect(sends).toBe(1);
  });

  it.each([
    preamble,
    'data: {"type":"response.metadata","headers":{"x-codex-turn-state":"opaque-state"}}\n\n',
  ])("recovers after one second without relaying the failed preamble: %s", async (start) => {
    vi.useFakeTimers();
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield start + (sends === 1 ? overload : output);
    });
    const result = drain(pool(account).nativePassthroughStream!(body));
    await vi.advanceTimersByTimeAsync(999);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).join("")).toBe(start + output);
    expect(sends).toBe(2);
  });

  it("does not resend if the account is parked during backoff", async () => {
    vi.useFakeTimers();
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield preamble + overload;
    });
    const result = drain(pool(account).nativePassthroughStream!(body));
    const rejected = expect(result).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(500);
    account.schedulable = false;
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(sends).toBe(1);
  });

  it("cancels during backoff without another send or pending timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield preamble + overload;
    });
    const result = drain(
      pool(account).nativePassthroughStream!(body, { signal: controller.signal }),
    );
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(sends).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { body: { ...body, previous_response_id: "resp_previous" }, headers: {} },
    { body, headers: { "x-codex-turn-state": "turn" } },
    { body, headers: { "x-helm-codex-responses-websocket-session": "socket" } },
  ] as Array<{
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }>)("does not replay a strict-affinity request: %j", async (input) => {
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield preamble + overload;
    });
    const inputCarrier = createNativePassthroughCarrier({ protocol: "openai_responses", ...input });
    await expect(
      (async () =>
        drain(pool(account).nativePassthroughStream!(inputCarrier, { statefulAccount: "a" })))(),
    ).rejects.toThrow();
    expect(sends).toBeLessThanOrEqual(1);
  });

  it.each([
    output,
    'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"write_file","arguments":""}}\n\n',
    'data: {"type":"response.output_item.added","item":{"type":"reasoning","summary":[],"encrypted_content":"cipher"}}\n\n',
  ])("does not replay after actual output or tool work: %s", async (committed) => {
    let sends = 0;
    const account = member(async function* () {
      sends++;
      yield preamble + committed + overload;
    });
    expect((await drain(pool(account).nativePassthroughStream!(body))).join("")).toBe(
      preamble + committed + overload,
    );
    expect(sends).toBe(1);
  });

  it("checks abort again after a completed wait and removes its listener", async () => {
    const controller = new AbortController();
    await expect(
      waitForOverloadRetry(
        { attempt: 0 },
        {
          reason: "in_band_overload",
          signal: controller.signal,
          sleep: async () => {
            controller.abort(new Error("cancelled"));
          },
        },
      ),
    ).rejects.toThrow("cancelled");
    vi.useFakeTimers();
    const fresh = new AbortController();
    const remove = vi.spyOn(fresh.signal, "removeEventListener");
    const waiting = waitForOverloadRetry(
      { attempt: 0 },
      { reason: "in_band_overload", signal: fresh.signal },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
