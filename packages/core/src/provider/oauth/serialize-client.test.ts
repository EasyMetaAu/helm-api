import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedSerialGate } from "../../queue/keyed-serial-gate.js";
import { isUserMessageRequest } from "../../queue/user-turn.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderClient } from "../openai.js";
import { createSerializingClient, QueueTimeoutError } from "./serialize-client.js";

// Serializing decorator around one OAuth pool member's client (issue #93,
// feature B). Only genuine user-message requests are serialized; the lock is
// held until the request FULLY completes (stream fully drained — CRS parity).

const USER_REQ: ChatCompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};
const TOOL_REQ: ChatCompletionRequest = {
  model: "m",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [] },
    { role: "tool", content: "result", tool_call_id: "t1" },
  ],
} as unknown as ChatCompletionRequest;

const RESPONSE = { id: "r1" } as unknown as ChatCompletionResponse;

function makeInner(chunks: string[] = ["a", "b"]): ProviderClient & {
  calls: number;
  streamCalls: number;
} {
  const inner = {
    calls: 0,
    streamCalls: 0,
    async chatCompletion() {
      inner.calls += 1;
      return RESPONSE;
    },
    async *chatCompletionStream() {
      inner.streamCalls += 1;
      for (const c of chunks) yield c;
    },
  };
  return inner;
}

// Inner that ALSO implements native passthrough (issue #217) — an Anthropic-style
// member. Counts native calls separately so the lease/forwarding can be asserted.
function makeNativeInner(chunks: string[] = ["c1", "c2", "c3"]): ProviderClient & {
  nativeCalls: number;
  nativeStreamCalls: number;
  compactCalls: number;
} {
  const inner = {
    nativeCalls: 0,
    nativeStreamCalls: 0,
    compactCalls: 0,
    async chatCompletion() {
      return RESPONSE;
    },
    async *chatCompletionStream() {
      for (const c of chunks) yield c;
    },
    async nativePassthrough() {
      inner.nativeCalls += 1;
      return RESPONSE;
    },
    async *nativePassthroughStream() {
      inner.nativeStreamCalls += 1;
      for (const c of chunks) yield c;
    },
    async responsesCompact() {
      inner.compactCalls += 1;
      return { output: [] };
    },
  };
  return inner;
}

function makeClient(
  inner: ProviderClient,
  config: { enabled: boolean; delayMs: number; timeoutMs: number },
  gate = createKeyedSerialGate(),
) {
  return createSerializingClient({
    inner,
    gate,
    key: "prov acct1",
    getConfig: () => config,
    isUserMessage: isUserMessageRequest,
  });
}

describe("createSerializingClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes straight through when disabled (gate untouched)", async () => {
    const inner = makeInner();
    const gate = { acquire: vi.fn() };
    const client = createSerializingClient({
      inner,
      gate,
      key: "k",
      getConfig: () => ({ enabled: false, delayMs: 200, timeoutMs: 5_000 }),
      isUserMessage: isUserMessageRequest,
    });
    expect(await client.chatCompletion(USER_REQ)).toBe(RESPONSE);
    const out: string[] = [];
    for await (const c of client.chatCompletionStream(USER_REQ)) out.push(c);
    expect(out).toEqual(["a", "b"]);
    expect(gate.acquire).not.toHaveBeenCalled();
  });

  it("passes a non-user-turn request straight through (tool-result round-trip)", async () => {
    const inner = makeInner();
    const gate = { acquire: vi.fn() };
    const client = createSerializingClient({
      inner,
      gate,
      key: "k",
      getConfig: () => ({ enabled: true, delayMs: 200, timeoutMs: 5_000 }),
      isUserMessage: isUserMessageRequest,
    });
    expect(await client.chatCompletion(TOOL_REQ)).toBe(RESPONSE);
    expect(gate.acquire).not.toHaveBeenCalled();
  });

  it("preserves Realtime capability without entering the user-message queue", async () => {
    const result = {
      status: 201,
      sdp: "v=answer\r\n",
      contentType: "application/sdp",
      location: "/v1/live/rtc_1",
      callId: "rtc_1",
      sideband: { url: "wss://upstream.test/rtc_1", headers: async () => ({}) },
    };
    const realtimeCall = vi.fn(async () => result);
    const gate = { acquire: vi.fn() };
    const client = createSerializingClient({
      inner: { ...makeInner(), realtimeCall },
      gate,
      key: "k",
      getConfig: () => ({ enabled: true, delayMs: 200, timeoutMs: 5_000 }),
      isUserMessage: isUserMessageRequest,
    });
    const request = {
      endpoint: "live" as const,
      query: "",
      sdp: "v=offer\r\n",
      session: { model: "gpt-live-1-boulder-alpha" },
      headers: {},
    };

    await expect(client.realtimeCall?.(request)).resolves.toBe(result);
    expect(realtimeCall).toHaveBeenCalledWith(request, undefined);
    expect(gate.acquire).not.toHaveBeenCalled();
    expect(makeClient(makeInner(), { enabled: true, delayMs: 0, timeoutMs: 1 }).realtimeCall).toBe(
      undefined,
    );
  });

  it("serializes two user-message chatCompletions with the configured delay", async () => {
    const inner = makeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 200, timeoutMs: 5_000 });
    const t0 = Date.now();
    const first = client.chatCompletion(USER_REQ);
    let secondDoneAt: number | null = null;
    const second = client.chatCompletion(USER_REQ).then((r) => {
      secondDoneAt = Date.now();
      return r;
    });
    await first; // completes at ~t0, stamping the completion instant
    await vi.advanceTimersByTimeAsync(200);
    await second;
    expect(secondDoneAt).not.toBeNull();
    expect((secondDoneAt ?? 0) - t0).toBeGreaterThanOrEqual(200);
    expect(inner.calls).toBe(2);
  });

  it("holds the lock across the FULL stream drain (release on iterator finally)", async () => {
    const inner = makeInner(["c1", "c2", "c3"]);
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 5_000 });
    const stream = client.chatCompletionStream(USER_REQ);
    const it = stream[Symbol.asyncIterator]();
    await it.next(); // stream open, lock held
    let secondGranted = false;
    const second = client.chatCompletion(USER_REQ).then((r) => {
      secondGranted = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondGranted).toBe(false); // still locked mid-stream
    await it.next();
    await it.next();
    await it.next(); // done:true — generator finally releases
    await second;
    expect(secondGranted).toBe(true);
  });

  it("releases when the stream consumer breaks early (abort path)", async () => {
    const inner = makeInner(["c1", "c2", "c3"]);
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 5_000 });
    const it = client.chatCompletionStream(USER_REQ)[Symbol.asyncIterator]();
    await it.next();
    await it.return?.(undefined); // consumer breaks — finally must release
    const next = await client.chatCompletion(USER_REQ);
    expect(next).toBe(RESPONSE);
  });

  it("releases when the inner call throws", async () => {
    const gate = createKeyedSerialGate();
    const failing: ProviderClient = {
      async chatCompletion() {
        throw new Error("upstream boom");
      },
      // biome-ignore lint/correctness/useYield: throws before yielding
      async *chatCompletionStream() {
        throw new Error("upstream boom");
      },
    };
    const client = makeClient(failing, { enabled: true, delayMs: 0, timeoutMs: 5_000 }, gate);
    await expect(client.chatCompletion(USER_REQ)).rejects.toThrow("upstream boom");
    // Lock must be free again: a fresh acquire on the same gate key succeeds.
    const probe = await gate.acquire({ key: "prov acct1", delayMs: 0, timeoutMs: 1 });
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.release();
  });

  it("throws QueueTimeoutError when the wait times out (non-stream + stream)", async () => {
    const inner = makeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 1_000 });
    const stream = client.chatCompletionStream(USER_REQ);
    const first = stream[Symbol.asyncIterator]();
    await first.next(); // holds the lock mid-stream
    // Attach the rejection expectations BEFORE advancing time so the rejects
    // are handled the instant they fire (no transient unhandled rejection).
    const blocked = expect(client.chatCompletion(USER_REQ)).rejects.toBeInstanceOf(
      QueueTimeoutError,
    );
    const blockedStream = expect(
      (async () => {
        const out: string[] = [];
        for await (const c of client.chatCompletionStream(USER_REQ)) out.push(c);
        return out;
      })(),
    ).rejects.toBeInstanceOf(QueueTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await blocked;
    await blockedStream;
    expect(inner.calls).toBe(0); // the upstream was never bothered
  });

  it("rethrows an AbortError when the signal aborts during the wait", async () => {
    const inner = makeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 60_000 });
    const it = client.chatCompletionStream(USER_REQ)[Symbol.asyncIterator]();
    await it.next(); // lock held
    const ac = new AbortController();
    const blocked = client.chatCompletion(USER_REQ, { signal: ac.signal });
    ac.abort();
    await expect(blocked).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === "AbortError",
    );
  });

  it("fails OPEN when the gate itself blows up (request flows, warn logged)", async () => {
    const inner = makeInner();
    const warnings: string[] = [];
    const client = createSerializingClient({
      inner,
      gate: {
        acquire: () => Promise.reject(new Error("gate exploded")),
      },
      key: "k",
      getConfig: () => ({ enabled: true, delayMs: 200, timeoutMs: 5_000 }),
      isUserMessage: isUserMessageRequest,
      log: (_lvl, msg) => warnings.push(msg),
    });
    expect(await client.chatCompletion(USER_REQ)).toBe(RESPONSE);
    const out: string[] = [];
    for await (const c of client.chatCompletionStream(USER_REQ)) out.push(c);
    expect(out).toEqual(["a", "b"]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  // ── native protocol passthrough (issue #217): the decorator must forward the
  // new optional methods through the SAME serial-queue lease, and must NOT expose
  // them when the wrapped member can't passthrough (honest feature-detect). ──
  it("serializes two user-message nativePassthrough calls with the configured delay", async () => {
    const inner = makeNativeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 200, timeoutMs: 5_000 });
    expect(typeof client.nativePassthrough).toBe("function");
    const t0 = Date.now();
    const first = client.nativePassthrough?.(USER_REQ);
    let secondDoneAt: number | null = null;
    const second = client.nativePassthrough?.(USER_REQ).then((r) => {
      secondDoneAt = Date.now();
      return r;
    });
    await first;
    await vi.advanceTimersByTimeAsync(200);
    await second;
    expect((secondDoneAt ?? 0) - t0).toBeGreaterThanOrEqual(200);
    expect(inner.nativeCalls).toBe(2);
  });

  it("serializes native Responses input calls with the configured delay", async () => {
    const inner = makeNativeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 200, timeoutMs: 5_000 });
    const responsesReq = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "hi" }],
    };
    const t0 = Date.now();
    const first = client.nativePassthrough?.(responsesReq);
    let secondDoneAt: number | null = null;
    const second = client.nativePassthrough?.(responsesReq).then((r) => {
      secondDoneAt = Date.now();
      return r;
    });

    await first;
    await vi.advanceTimersByTimeAsync(200);
    await second;

    expect((secondDoneAt ?? 0) - t0).toBeGreaterThanOrEqual(200);
    expect(inner.nativeCalls).toBe(2);
  });

  it("holds the lock across the FULL nativePassthroughStream drain", async () => {
    const inner = makeNativeInner(["c1", "c2", "c3"]);
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 5_000 });
    expect(typeof client.nativePassthroughStream).toBe("function");
    const it = client.nativePassthroughStream?.(USER_REQ)[Symbol.asyncIterator]();
    await it?.next(); // stream open, lock held
    let secondGranted = false;
    const second = client.nativePassthrough?.(USER_REQ).then((r) => {
      secondGranted = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondGranted).toBe(false); // still locked mid-stream
    await it?.next();
    await it?.next();
    await it?.next(); // done:true — generator finally releases
    await second;
    expect(secondGranted).toBe(true);
    expect(inner.nativeStreamCalls).toBe(1);
  });

  it("holds the lock across a native Responses input stream", async () => {
    const inner = makeNativeInner(["c1", "c2", "c3"]);
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 5_000 });
    const responsesReq = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "hi" }],
    };
    const it = client.nativePassthroughStream?.(responsesReq)[Symbol.asyncIterator]();
    await it?.next();
    let secondGranted = false;
    const second = client.nativePassthrough?.(responsesReq).then((r) => {
      secondGranted = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondGranted).toBe(false);
    await it?.next();
    await it?.next();
    await it?.next();
    await second;

    expect(secondGranted).toBe(true);
    expect(inner.nativeStreamCalls).toBe(1);
  });

  it("forwards and serializes Responses compact calls", async () => {
    const inner = makeNativeInner();
    const client = makeClient(inner, { enabled: true, delayMs: 200, timeoutMs: 5_000 });
    const compact = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "compact this" }],
    };
    expect(typeof client.responsesCompact).toBe("function");

    const first = client.responsesCompact?.(compact);
    let secondDone = false;
    const second = client.responsesCompact?.(compact).then(() => {
      secondDone = true;
    });

    await first;
    expect(secondDone).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await second;

    expect(secondDone).toBe(true);
    expect(inner.compactCalls).toBe(2);
  });

  it("does NOT expose native passthrough when the inner member lacks it (honest feature-detect)", () => {
    const inner = makeInner(); // openai-style member: no native methods
    const client = makeClient(inner, { enabled: true, delayMs: 0, timeoutMs: 5_000 });
    expect(client.nativePassthrough).toBeUndefined();
    expect(client.nativePassthroughStream).toBeUndefined();
    expect(client.responsesCompact).toBeUndefined();
  });
});
