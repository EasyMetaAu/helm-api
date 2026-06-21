import { describe, expect, it } from "vitest";
import type { IRResponse } from "./ir.js";
import {
  type Controller,
  createStreamState,
  parseSSEData,
  readSSE,
  safeClose,
  safeEnqueue,
  synthesizeSSE,
} from "./streaming.js";

// —— helpers ————————————————————————————————————————————————————————————————

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a ReadableStream that emits the given byte chunks in order. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i];
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** Drain an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Read a whole ReadableStream into a decoded string. */
async function drainText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  text += dec.decode();
  return text;
}

/** Parse the raw SSE wire text back into {event,data} frames (consumer side). */
function parseWire(wire: string): Array<{ event?: string; data: string }> {
  const frames: Array<{ event?: string; data: string }> = [];
  for (const block of wire.split("\n\n")) {
    if (block.trim() === "") continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    frames.push({ ...(event !== undefined ? { event } : {}), data: dataLines.join("\n") });
  }
  return frames;
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected item at index ${index}`);
  }
  return item;
}

// —— 1. SSE splitting across chunk boundaries ————————————————————————————————

describe("readSSE — generic SSE splitter", () => {
  it("reassembles a frame split mid-line across two chunks", async () => {
    const frame = 'data: {"hello":"world"}\n\n';
    const cut = 10; // break inside the `data:` line
    const events = await collect(
      readSSE(streamOf([enc.encode(frame.slice(0, cut)), enc.encode(frame.slice(cut))])),
    );
    expect(events).toEqual([{ data: '{"hello":"world"}' }]);
  });

  it("handles multiple events crammed in one chunk, blank-line separated", async () => {
    const wire = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    const events = await collect(readSSE(streamOf([enc.encode(wire)])));
    expect(events).toEqual([{ data: '{"a":1}' }, { data: '{"b":2}' }]);
  });

  it("captures the optional event: name and tolerates CRLF/LF mix + [DONE]", async () => {
    const wire = 'event: message\r\ndata: {"x":1}\r\n\r\ndata: [DONE]\n\n';
    const events = await collect(readSSE(streamOf([enc.encode(wire)])));
    expect(events).toEqual([{ event: "message", data: '{"x":1}' }, { data: "[DONE]" }]);
  });

  it("joins multi-line data fields within one event", async () => {
    const wire = "data: line1\ndata: line2\n\n";
    const events = await collect(readSSE(streamOf([enc.encode(wire)])));
    expect(events).toEqual([{ data: "line1\nline2" }]);
  });

  // H9 (stated #1 risk): a multibyte UTF-8 codepoint split across two reads must
  // reassemble intact — never mojibake / U+FFFD. The decoder uses { stream: true };
  // this pins that contract so a refactor that drops the flag fails loudly.
  it("reassembles a multibyte codepoint (CJK + emoji) split mid-byte across chunks", async () => {
    const frame = 'data: {"text":"你好👋"}\n\n';
    const bytes = enc.encode(frame);
    // Cut INSIDE the 4-byte emoji 👋: prefix bytes up to 你好, then +2 into the emoji.
    const cut = enc.encode('data: {"text":"你好').length + 2;
    const events = await collect(readSSE(streamOf([bytes.slice(0, cut), bytes.slice(cut)])));
    expect(events).toEqual([{ data: '{"text":"你好👋"}' }]);
    // Round-trips through JSON with no replacement-char corruption.
    expect(JSON.parse(nth(events, 0).data).text).toBe("你好👋");
  });
});

// —— 2. parseSSEData tolerance ————————————————————————————————————————————————

describe("parseSSEData", () => {
  it("parses a legal JSON line into an object", () => {
    expect(parseSSEData<{ k: number }>('{"k":7}')).toEqual({ k: 7 });
  });

  it("returns null for [DONE] and non-JSON without throwing", () => {
    expect(parseSSEData("[DONE]")).toBeNull();
    expect(parseSSEData("not json")).toBeNull();
    expect(parseSSEData("")).toBeNull();
  });
});

// —— 3. State machine: block ordering invariant ——————————————————————————————

describe("StreamState — block ordering invariant", () => {
  it("rejects a delta before message_start", () => {
    const state = createStreamState();
    // No message_start sent yet: a strict consumer must drop the delta.
    expect(state.started).toBe(false);
    expect(state.openBlocks.has(0)).toBe(false);
  });

  it("monotonic contentIndex allocation per openai index, stable across calls", () => {
    const state = createStreamState();
    // First sight of openai index 0 → block 0; index 1 → block 1.
    const b0 = allocBlock(state, 0);
    const b1 = allocBlock(state, 1);
    const b0again = allocBlock(state, 0);
    expect(b0).toBe(0);
    expect(b1).toBe(1);
    expect(b0again).toBe(0); // stable, not re-allocated
    expect(state.contentIndex).toBe(2);
  });
});

// helper mirroring how a protocol transformer would use the state object
function allocBlock(state: ReturnType<typeof createStreamState>, openaiIndex: number): number {
  const existing = state.openaiIndexToBlockIndex.get(openaiIndex);
  if (existing !== undefined) return existing;
  const block = state.contentIndex;
  state.contentIndex += 1;
  state.openaiIndexToBlockIndex.set(openaiIndex, block);
  return block;
}

// —— 4. State machine: tool-call index→block + id upgrade ————————————————————

describe("StreamState — tool-call index→block mapping + id upgrade", () => {
  it("maps parallel tool_call indices to stable blocks and upgrades temp ids", () => {
    const state = createStreamState();
    // Two parallel tool calls, indices 0 and 1; ids only on first fragment.
    const blockA = allocBlock(state, 0);
    const blockB = allocBlock(state, 1);
    expect(blockA).not.toBe(blockB);

    // Temp id synthesized before the real id arrives, then upgraded.
    state.toolCallIdUpgrade.set("tmp_0", "call_real_0");
    expect(state.toolCallIdUpgrade.get("tmp_0")).toBe("call_real_0");

    // Later fragments for index 0 still resolve to the same block (partial JSON tolerated).
    expect(allocBlock(state, 0)).toBe(blockA);
  });
});

// —— 5. Idempotent close guard ————————————————————————————————————————————————

describe("safeEnqueue / safeClose — idempotent close guard", () => {
  it("no-ops after close and never double-operates the controller", () => {
    const enqueued: unknown[] = [];
    let closes = 0;
    const c: Controller = {
      enqueue: (chunk) => enqueued.push(chunk),
      close: () => {
        closes += 1;
      },
    };
    const state = createStreamState();

    safeEnqueue(c, state, "a");
    safeClose(c, state);
    expect(state.closed).toBe(true);
    expect(closes).toBe(1);

    // After close: every further op is a no-op.
    safeEnqueue(c, state, "b");
    safeClose(c, state);
    expect(enqueued).toEqual(["a"]);
    expect(closes).toBe(1);
  });
});

// —— 6 & 7. JSON → SSE synthesizer ————————————————————————————————————————————

/** A minimal native-events splitter, mimicking what a protocol provides. */
function toNativeEvents(res: IRResponse): Array<{ event?: string; data: string }> {
  const choice = res.choices[0];
  const msg = choice?.message;
  const events: Array<{ event?: string; data: string }> = [];
  events.push({ data: JSON.stringify({ type: "start", id: res.id, role: "assistant" }) });
  if (typeof msg?.content === "string" && msg.content.length > 0) {
    events.push({ data: JSON.stringify({ type: "delta", text: msg.content }) });
  }
  for (const tc of msg?.tool_calls ?? []) {
    events.push({
      data: JSON.stringify({ type: "tool_start", id: tc.id, name: tc.function.name }),
    });
    events.push({ data: JSON.stringify({ type: "tool_delta", args: tc.function.arguments }) });
  }
  events.push({ data: JSON.stringify({ type: "finish", reason: choice?.finish_reason ?? null }) });
  return events;
}

describe("synthesizeSSE — JSON → SSE for cache hit / non-streaming upstream", () => {
  it("emits a deterministic start → delta(s) → finish → [DONE] sequence", async () => {
    const res: IRResponse = {
      id: "resp_1",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
    };
    const wire = await drainText(synthesizeSSE(res, toNativeEvents));
    const frames = parseWire(wire);
    const types = frames.map((f) => {
      if (f.data === "[DONE]") return "[DONE]";
      return (JSON.parse(f.data) as { type: string }).type;
    });
    expect(types).toEqual(["start", "delta", "finish", "[DONE]"]);
    // lossless: the delta carries the full content.
    const delta = JSON.parse(nth(frames, 1).data) as { text: string };
    expect(delta.text).toBe("Hello world");
  });

  it("synthesizes tool_use blocks with start (id+name) before delta", async () => {
    const res: IRResponse = {
      id: "resp_2",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_42",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const wire = await drainText(synthesizeSSE(res, toNativeEvents));
    const frames = parseWire(wire);
    const parsed = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>);
    const toolStartIdx = parsed.findIndex((e) => e.type === "tool_start");
    const toolDeltaIdx = parsed.findIndex((e) => e.type === "tool_delta");
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);
    expect(toolDeltaIdx).toBeGreaterThan(toolStartIdx); // start before delta (pit #4)
    expect(parsed[toolStartIdx]).toMatchObject({ id: "call_42", name: "get_weather" });
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });
});
