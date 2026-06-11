import { describe, expect, it } from "vitest";
import type { IRChunk } from "../gemini/gemini-types.js";
import type { IRResponse } from "../ir.js";
import {
  type AnthropicSSEEvent,
  convertAnthropicStreamToIR,
  convertOpenAIStreamToAnthropic,
  type OpenAIChunk,
  synthesizeSSEFromJSON,
} from "./stream.js";

// —— helpers ————————————————————————————————————————————————————————————————

/** Wrap an array of chunks as an async iterable (the upstream OpenAI chunk feed). */
async function* feed(chunks: OpenAIChunk[]): AsyncIterable<OpenAIChunk> {
  for (const c of chunks) yield c;
}

/** Drain an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected item at index ${index}`);
  }
  return item;
}

/** A text-only OpenAI chunk carrying a content delta. */
function textChunk(content: string, finish: string | null = null): OpenAIChunk {
  return {
    id: "chatcmpl-x",
    model: "gpt-x",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

// —— 1. event sequence: pure text ————————————————————————————————————————————

describe("convertOpenAIStreamToAnthropic — text event sequence", () => {
  it("emits message_start → content_block_start(0) → delta×N → stop(0) → message_delta → message_stop", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([textChunk("Hel"), textChunk("lo"), textChunk("", "stop")]),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    // First text block is index 0, content_block_start carries an empty text block.
    const start = nth(events, 1);
    expect(start.type).toBe("content_block_start");
    if (start.type === "content_block_start") {
      expect(start.index).toBe(0);
      expect(start.content_block).toEqual({ type: "text", text: "" });
    }

    // text_delta carries the fragment and nothing else.
    const d1 = nth(events, 2);
    if (d1.type === "content_block_delta") {
      expect(d1.index).toBe(0);
      expect(d1.delta).toEqual({ type: "text_delta", text: "Hel" });
    }

    // message_delta carries a legal stop_reason.
    const md = nth(events, 5);
    if (md.type === "message_delta") {
      expect(md.delta.stop_reason).toBe("end_turn");
    }
  });
});

// —— 2. parallel tool-call streaming ——————————————————————————————————————————

describe("convertOpenAIStreamToAnthropic — parallel tool calls", () => {
  it("maps interleaved tool_call indices 0/1 to stable, non-cross-contaminated blocks", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_a", function: { name: "alpha", arguments: '{"a' } },
                    { index: 1, id: "call_b", function: { name: "beta", arguments: '{"b' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 1, function: { arguments: '":2}' } },
                    { index: 0, function: { arguments: '":1}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    // Two distinct tool_use blocks: alpha → block 0, beta → block 1.
    const starts = events.filter(
      (e): e is Extract<AnthropicSSEEvent, { type: "content_block_start" }> =>
        e.type === "content_block_start",
    );
    expect(starts).toHaveLength(2);
    const firstStart = nth(starts, 0);
    const secondStart = nth(starts, 1);
    expect(firstStart.index).toBe(0);
    expect(firstStart.content_block).toMatchObject({
      type: "tool_use",
      id: "call_a",
      name: "alpha",
    });
    expect(secondStart.index).toBe(1);
    expect(secondStart.content_block).toMatchObject({
      type: "tool_use",
      id: "call_b",
      name: "beta",
    });

    // input_json_delta fragments never cross blocks: block 0 only ever sees alpha's args.
    const block0Args = events
      .filter(
        (e): e is Extract<AnthropicSSEEvent, { type: "content_block_delta" }> =>
          e.type === "content_block_delta" && e.index === 0,
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    const block1Args = events
      .filter(
        (e): e is Extract<AnthropicSSEEvent, { type: "content_block_delta" }> =>
          e.type === "content_block_delta" && e.index === 1,
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    expect(block0Args).toBe('{"a":1}');
    expect(block1Args).toBe('{"b":2}');

    // Each block start/stop is paired exactly once.
    const stops = events.filter((e) => e.type === "content_block_stop");
    expect(stops).toHaveLength(2);
  });
});

// —— 3. temp id upgrade ———————————————————————————————————————————————————————

describe("convertOpenAIStreamToAnthropic — temp id upgrade", () => {
  it("starts a tool_use block with a temp id, then the emitted id matches the real id", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          // First fragment: NO id yet, only name.
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: "" } }] },
                finish_reason: null,
              },
            ],
          },
          // Second fragment: the real id arrives.
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "call_real", function: { arguments: "{}" } }],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const start = events.find((e) => e.type === "content_block_start");
    expect(start?.type).toBe("content_block_start");
    if (start?.type === "content_block_start" && start.content_block.type === "tool_use") {
      // The id emitted to the client equals the final real id (not the temp one).
      expect(start.content_block.id).toBe("call_real");
    }
  });
});

// —— 4. idempotent close guard ————————————————————————————————————————————————

describe("convertOpenAIStreamToAnthropic — idempotent close guard", () => {
  it("emits content_block_stop and message_stop exactly once even with redundant finish chunks", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("hi"),
          textChunk("", "stop"),
          // A redundant trailing finish chunk must not double-close anything.
          textChunk("", "stop"),
        ]),
      ),
    );
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
  });
});

// —— 5. usage buffered to the terminal message_delta —————————————————————————

describe("convertOpenAIStreamToAnthropic — usage buffering", () => {
  it("does not emit usage mid-stream; carries it on message_delta with input = prompt − cached", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("x"),
          // A mid-stream chunk carrying usage must NOT be emitted immediately.
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30 },
          },
          textChunk("", "stop"),
        ]),
      ),
    );

    // No standalone usage event mid-stream — usage rides the terminal message_delta.
    const md = events.find((e) => e.type === "message_delta");
    expect(md?.type).toBe("message_delta");
    if (md?.type === "message_delta") {
      // input = prompt − cached: raw upstream prompt_tokens (100) is the FULL prompt
      // incl. cached, so we normalize to 100 − 30 = 70 before buffering (matching the
      // non-stream openai.ts path); cached (30) is re-exposed as cache_read.
      expect(md.usage.input_tokens).toBe(70);
      expect(md.usage.output_tokens).toBe(20);
      expect(md.usage.cache_read_input_tokens).toBe(30);
    }
  });

  it("reads cache read/write from prompt_tokens_details (real OpenAI nesting)", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("x"),
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 30, cache_creation_tokens: 10 },
            },
          },
          textChunk("", "stop"),
        ]),
      ),
    );

    const md = events.find((e) => e.type === "message_delta");
    if (md?.type === "message_delta") {
      expect(md.usage.input_tokens).toBe(60);
      expect(md.usage.cache_read_input_tokens).toBe(30);
      expect(md.usage.cache_creation_input_tokens).toBe(10);
    }
  });
});

// —— 5b. empty-named end-of-stream tool block is dropped entirely ——————————————

describe("convertOpenAIStreamToAnthropic — empty-named tool block", () => {
  it("does not emit a content_block_start/stop for a tool index that had no name and no args", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          // upstream announced a tool index/id but never sent a name or any arguments.
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_x", function: {} }] },
                finish_reason: null,
              },
            ],
          },
          { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    // No tool_use block at all: neither a start nor an orphan stop (pit #4).
    expect(events.filter((e) => e.type === "content_block_start")).toHaveLength(0);
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(0);
    // The terminal events are still well-formed.
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

// —— 6. no orphan deltas ——————————————————————————————————————————————————————

describe("convertOpenAIStreamToAnthropic — no orphan delta", () => {
  it("never emits a content_block_delta whose index has no preceding content_block_start", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          textChunk("a"),
          {
            id: "c",
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "t", function: { name: "f", arguments: "{}" } }],
                },
                finish_reason: null,
              },
            ],
          },
          textChunk("", "stop"),
        ]),
      ),
    );

    const started = new Set<number>();
    for (const e of events) {
      if (e.type === "content_block_start") started.add(e.index);
      if (e.type === "content_block_delta") {
        expect(started.has(e.index)).toBe(true);
      }
    }
  });
});

// —— 7. JSON → SSE synthesizer (cache hit) ————————————————————————————————————

describe("synthesizeSSEFromJSON — cache hit / non-streaming upstream", () => {
  it("explodes a single IR response into an isomorphic event sequence", async () => {
    const res: IRResponse = {
      id: "resp_1",
      model: "gpt-x",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const events = await collect(synthesizeSSEFromJSON(res));
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const delta = nth(events, 2);
    if (delta.type === "content_block_delta" && delta.delta.type === "text_delta") {
      expect(delta.delta.text).toBe("Hello world");
    }
    const md = nth(events, 4);
    if (md.type === "message_delta") {
      expect(md.delta.stop_reason).toBe("end_turn");
      expect(md.usage.input_tokens).toBe(10);
      expect(md.usage.output_tokens).toBe(5);
    }
  });

  // Regression (Codex P3): reasoning must survive the cache-hit / non-stream synth —
  // a streaming Anthropic client served from a non-stream path still gets the thinking.
  it("carries reasoning_content into a synthesized thinking block", async () => {
    const res: IRResponse = {
      id: "resp_r",
      model: "deepseek-r",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "answer", reasoning_content: "let me think" },
          finish_reason: "stop",
        },
      ],
    };
    const events = await collect(synthesizeSSEFromJSON(res));
    const thinking = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.type === "content_block_delta" ? e.delta : undefined))
      .filter((d) => d?.type === "thinking_delta");
    expect(thinking.length).toBeGreaterThan(0);
    const text = thinking.map((d) => (d?.type === "thinking_delta" ? d.thinking : "")).join("");
    expect(text).toBe("let me think");
  });

  it("synthesizes a tool_use block: start (id+name) before input_json_delta", async () => {
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
    const events = await collect(synthesizeSSEFromJSON(res));
    const start = events.find((e) => e.type === "content_block_start");
    expect(start?.type).toBe("content_block_start");
    if (start?.type === "content_block_start" && start.content_block.type === "tool_use") {
      expect(start.content_block.id).toBe("call_42");
      expect(start.content_block.name).toBe("get_weather");
    }
    const argDelta = events.find(
      (e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta",
    );
    expect(argDelta).toBeDefined();
    if (argDelta?.type === "content_block_delta" && argDelta.delta.type === "input_json_delta") {
      expect(argDelta.delta.partial_json).toBe('{"city":"SF"}');
    }
    const md = events.find((e) => e.type === "message_delta");
    if (md?.type === "message_delta") {
      expect(md.delta.stop_reason).toBe("tool_use");
    }
  });
});

// —— P4: thinking streaming OUTBOUND (OpenAI reasoning_content -> Anthropic) ————
describe("convertOpenAIStreamToAnthropic — thinking streaming (outbound)", () => {
  it("maps delta.reasoning_content to a thinking content block + thinking_delta", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: { reasoning_content: "let me " }, finish_reason: null }],
          },
          {
            id: "c",
            model: "m",
            choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }],
          },
          textChunk("answer"),
          textChunk("", "stop"),
        ]),
      ),
    );

    // A thinking content block opens before the text block.
    const starts = events.filter(
      (e): e is Extract<AnthropicSSEEvent, { type: "content_block_start" }> =>
        e.type === "content_block_start",
    );
    expect(starts[0]?.content_block.type).toBe("thinking");

    // thinking_delta fragments carry the reasoning text on the thinking block index.
    const thinkingIndex = nth(starts, 0).index;
    const thinkingText = events
      .filter(
        (e): e is Extract<AnthropicSSEEvent, { type: "content_block_delta" }> =>
          e.type === "content_block_delta" && e.index === thinkingIndex,
      )
      .map((e) => (e.delta.type === "thinking_delta" ? e.delta.thinking : ""))
      .join("");
    expect(thinkingText).toBe("let me think");

    // The text block is a distinct, later block.
    expect(starts[1]?.content_block.type).toBe("text");
  });
});

// —— P4: thinking streaming INBOUND (Anthropic thinking/signature -> IR) ————————
describe("convertAnthropicStreamToIR — thinking streaming (inbound)", () => {
  async function* events(evts: AnthropicSSEEvent[]): AsyncIterable<AnthropicSSEEvent> {
    for (const e of evts) yield e;
  }

  it("maps thinking_delta -> IR delta.reasoning_content and signature_delta -> thinking_blocks", async () => {
    const chunks = await collect<IRChunk>(
      convertAnthropicStreamToIR(
        events([
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reason A" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-xyz" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 7 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    // reasoning_content streamed on a delta.
    const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("");
    expect(reasoning).toBe("reason A");

    // signature lands in a thinking_blocks delta.
    const sigChunk = chunks.find((c) =>
      c.choices?.[0]?.delta?.thinking_blocks?.some((b) => b.signature === "sig-xyz"),
    );
    expect(sigChunk).toBeDefined();
  });
});

describe("convertOpenAIStreamToAnthropic — tool name sanitizer", () => {
  it("preserves MCP double-underscore tool names in streaming tool_use blocks", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_mcp",
                      function: {
                        name: "mcp__codegraph__codegraph_context",
                        arguments: '{"task":"inspect"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const start = events.find(
      (e): e is Extract<AnthropicSSEEvent, { type: "content_block_start" }> =>
        e.type === "content_block_start" && e.content_block.type === "tool_use",
    );
    expect(start?.content_block).toMatchObject({
      type: "tool_use",
      id: "call_mcp",
      name: "mcp__codegraph__codegraph_context",
    });
  });

  it("sanitizes colliding tool names in parallel streaming tool_use blocks", async () => {
    const events = await collect(
      convertOpenAIStreamToAnthropic(
        feed([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_a",
                      function: { name: "search-web", arguments: '{"q":"a"}' },
                    },
                    {
                      index: 1,
                      id: "call_b",
                      function: { name: "search web", arguments: '{"q":"b"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const starts = events.filter(
      (e): e is Extract<AnthropicSSEEvent, { type: "content_block_start" }> =>
        e.type === "content_block_start" && e.content_block.type === "tool_use",
    );
    const toolNames = starts.flatMap((e) =>
      e.content_block.type === "tool_use" ? [e.content_block.name] : [],
    );
    expect(toolNames).toEqual(["search_web", expect.stringMatching(/^search_web_[a-z0-9]{8}$/)]);
  });
});

// —— order 12: the terminal message_delta must carry cache_creation_input_tokens
// (ephemeral cache WRITE) when the IR usage reports it, not just cache_read.
describe("message_delta usage — cache_creation_input_tokens (order 12)", () => {
  it("emits cache_creation_input_tokens on the terminal message_delta", async () => {
    const resp: IRResponse = {
      id: "resp-cache",
      model: "claude-3-5-sonnet",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        cached_tokens: 20,
        cache_creation_tokens: 80,
      },
    };
    const events = await collect(synthesizeSSEFromJSON(resp));
    const delta = events.find((e) => e.type === "message_delta");
    expect(delta).toBeDefined();
    if (delta?.type === "message_delta") {
      expect(
        (delta.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      ).toBe(80);
    }
  });
});

// —— order 5 regression: cache-hit / non-stream synthesis must emit the thinking
// block when the IR response carries flat reasoning_content (not just live streams).
describe("synthesizeSSEFromJSON — reasoning_content surfaces a thinking block (order 5)", () => {
  it("emits a thinking content_block + thinking_delta from flat reasoning_content", async () => {
    const resp: IRResponse = {
      id: "resp-think",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer is 4.",
            reasoning_content: "2 + 2 = 4",
          },
          finish_reason: "stop",
        },
      ],
    };
    const events = await collect(synthesizeSSEFromJSON(resp));
    const thinkingStart = events.find(
      (e) => e.type === "content_block_start" && e.content_block.type === "thinking",
    );
    expect(thinkingStart).toBeDefined();
    const thinkingDelta = events.find(
      (e) => e.type === "content_block_delta" && e.delta.type === "thinking_delta",
    );
    expect(thinkingDelta).toBeDefined();
    if (
      thinkingDelta?.type === "content_block_delta" &&
      thinkingDelta.delta.type === "thinking_delta"
    ) {
      expect(thinkingDelta.delta.thinking).toBe("2 + 2 = 4");
    }
  });
});
