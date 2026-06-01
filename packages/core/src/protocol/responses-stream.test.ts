import { describe, expect, it } from "vitest";
import type { OpenAIChunk } from "./anthropic/stream.js";
import type { IRResponse } from "./ir.js";
import {
  convertOpenAIStreamToResponses,
  type ResponsesSSEEvent,
  synthesizeResponsesSSEFromJSON,
} from "./responses-stream.js";

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

/** A text-only OpenAI chunk carrying a content delta. */
function textChunk(content: string, finish: string | null = null): OpenAIChunk {
  return {
    id: "chatcmpl-x",
    model: "gpt-x",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

function seqs(events: ResponsesSSEEvent[]): number[] {
  return events.map((e) => e.sequence_number);
}

// —— 1. event sequence: pure text ————————————————————————————————————————————

describe("convertOpenAIStreamToResponses — text event sequence", () => {
  it("emits the canonical TEXT sequence created→in_progress→item/part open→delta×N→done×→completed", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(
        feed([textChunk("Hel"), textChunk("lo"), textChunk("", "stop")]),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("assigns a strictly monotonic sequence_number starting at 0", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("a"), textChunk("b", "stop")])),
    );
    const s = seqs(events);
    expect(s[0]).toBe(0);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]).toBe((s[i - 1] as number) + 1);
    }
  });

  it("output_text.delta concatenation equals output_text.done full text", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(
        feed([textChunk("Hel"), textChunk("lo"), textChunk("", "stop")]),
      ),
    );
    const deltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => (e as Extract<ResponsesSSEEvent, { type: "response.output_text.delta" }>).delta)
      .join("");
    expect(deltas).toBe("Hello");
    const done = events.find((e) => e.type === "response.output_text.done");
    expect(done).toBeDefined();
    expect((done as Extract<ResponsesSSEEvent, { type: "response.output_text.done" }>).text).toBe(
      "Hello",
    );
  });

  it("response.completed carries terminal status completed + usage projection", async () => {
    const usageChunk: OpenAIChunk = {
      id: "chatcmpl-x",
      model: "gpt-x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    };
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("hi"), usageChunk])),
    );
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.type).toBe("response.completed");
    expect(completed.response.status).toBe("completed");
    expect(completed.response.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });
});

// —— 2. tool calls ————————————————————————————————————————————————————————————

describe("convertOpenAIStreamToResponses — tool calls", () => {
  it("emits added→arguments.delta*→arguments.done→item.done with stable call_id/name/args", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_abc", function: { name: "get_weather", arguments: '{"ci' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const toolTypes = events
      .map((e) => e.type)
      .filter(
        (t) => t.startsWith("response.output_item") || t.startsWith("response.function_call"),
      );
    expect(toolTypes).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
    ]);

    const added = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(added.item).toMatchObject({
      type: "function_call",
      name: "get_weather",
      call_id: "call_abc",
    });
    expect(added.output_index).toBe(0);

    const done = events.find((e) => e.type === "response.function_call_arguments.done") as Extract<
      ResponsesSSEEvent,
      { type: "response.function_call_arguments.done" }
    >;
    expect(done.arguments).toBe('{"city":"NYC"}');
    expect(done.output_index).toBe(0);
  });

  it("assigns stable, non-reused output_index across multiple tool calls", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c0", function: { name: "f0", arguments: "{}" } },
                { index: 1, id: "c1", function: { name: "f1", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const added = events.filter((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >[];
    expect(added.map((e) => e.output_index)).toEqual([0, 1]);
    expect((added[0]!.item as { call_id?: string }).call_id).toBe("c0");
    expect((added[1]!.item as { call_id?: string }).call_id).toBe("c1");
  });

  it("drops an empty-husk tool (announced index/id but no name and no arguments)", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "ghost" }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    expect(events.some((e) => e.type === "response.output_item.added")).toBe(false);
    // still terminates cleanly.
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("interleaves text then tool call with distinct output_index slots", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { content: "thinking" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c0", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const textItem = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(textItem.output_index).toBe(0);
    const toolItem = events
      .filter((e) => e.type === "response.output_item.added")
      .at(-1) as Extract<ResponsesSSEEvent, { type: "response.output_item.added" }>;
    expect(toolItem.output_index).toBe(1);
  });
});

// —— 3. terminal mapping + boundary sequences ————————————————————————————————

describe("convertOpenAIStreamToResponses — terminal mapping & edge sequences", () => {
  it("maps finish_reason length → status incomplete", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("x"), textChunk("", "length")])),
    );
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.status).toBe("incomplete");
  });

  it("empty stream still produces a legal created…completed sequence", async () => {
    const events = await collect(convertOpenAIStreamToResponses(feed([])));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types.at(-1)).toBe("response.completed");
    // no orphan item/part events for an empty stream.
    expect(types).not.toContain("response.output_item.added");
  });

  it("emits each output_item.done at most once (idempotent close)", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { content: "a" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c0", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const doneIndexes = events
      .filter((e) => e.type === "response.output_item.done")
      .map(
        (e) =>
          (e as Extract<ResponsesSSEEvent, { type: "response.output_item.done" }>).output_index,
      );
    expect(new Set(doneIndexes).size).toBe(doneIndexes.length);
  });
});

// —— 4. synthesizer (cache hit / non-streaming upstream) ——————————————————————

describe("synthesizeResponsesSSEFromJSON — isomorphic with the live stream", () => {
  it("text-only response → identical canonical TEXT sequence", async () => {
    const resp: IRResponse = {
      id: "resp_abc",
      model: "gpt-x",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    };
    const events = await collect(synthesizeResponsesSSEFromJSON(resp));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
  });

  it("tool-only response → function_call item sequence", async () => {
    const resp: IRResponse = {
      id: "resp_t",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_z", type: "function", function: { name: "do_it", arguments: '{"k":1}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const events = await collect(synthesizeResponsesSSEFromJSON(resp));
    const added = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(added.item).toMatchObject({ type: "function_call", name: "do_it", call_id: "call_z" });
    const argsDone = events.find(
      (e) => e.type === "response.function_call_arguments.done",
    ) as Extract<ResponsesSSEEvent, { type: "response.function_call_arguments.done" }>;
    expect(argsDone.arguments).toBe('{"k":1}');
  });

  it("mixed text + tool response → both item kinds present, terminal completed", async () => {
    const resp: IRResponse = {
      id: "resp_m",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "here",
            tool_calls: [
              { id: "call_m", type: "function", function: { name: "g", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const events = await collect(synthesizeResponsesSSEFromJSON(resp));
    expect(events.some((e) => e.type === "response.output_text.delta")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "response.output_item.added" &&
          (e as Extract<ResponsesSSEEvent, { type: "response.output_item.added" }>).item.type ===
            "function_call",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("response.completed");
  });
});
