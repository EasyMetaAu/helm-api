import { describe, expect, it } from "vitest";
import type { OpenAIChunk } from "./anthropic/stream.js";
import type { IRResponse } from "./ir.js";
import {
  convertOpenAIStreamToResponses,
  convertResponsesEventStreamToOpenAI,
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

// —— order 22: refusal + annotation streaming events ————————————————————————————
describe("convertOpenAIStreamToResponses — refusal + annotation streaming (order 22)", () => {
  it("emits response.refusal.delta×N + a terminal response.refusal.done", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", refusal: "I can" } }] },
      { choices: [{ index: 0, delta: { refusal: "not help" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const deltas = events.filter((e) => e.type === "response.refusal.delta");
    expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["I can", "not help"]);
    const done = events.find((e) => e.type === "response.refusal.done") as
      | { refusal: string }
      | undefined;
    expect(done?.refusal).toBe("I cannot help");
    // The refusal item closes as a message item carrying a refusal content part.
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    const refusalItem = (completed.response.output as Array<{ content?: Array<{ type: string }> }>)
      .flatMap((o) => o.content ?? [])
      .find((p) => p.type === "refusal");
    expect(refusalItem).toBeDefined();
  });

  it("emits response.output_text.annotation.added for delta.annotations", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "see source" } }] },
      {
        choices: [
          { index: 0, delta: { annotations: [{ type: "url_citation", url: "https://x" }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const ann = events.find((e) => e.type === "response.output_text.annotation.added") as
      | { annotation: { url?: string }; annotation_index: number }
      | undefined;
    expect(ann?.annotation?.url).toBe("https://x");
    expect(ann?.annotation_index).toBe(0);
  });

  it("reverse: response.refusal.delta -> delta.refusal", async () => {
    const irChunks = await collect(
      convertResponsesEventStreamToOpenAI(
        (async function* () {
          yield {
            type: "response.refusal.delta",
            sequence_number: 0,
            item_id: "i",
            output_index: 0,
            content_index: 0,
            delta: "no",
          } as ResponsesSSEEvent;
        })(),
      ),
    );
    const first = irChunks[0] as { choices?: Array<{ delta?: { refusal?: string } }> };
    expect(first.choices?.[0]?.delta?.refusal).toBe("no");
  });

  it("reverse: response.output_text.annotation.added -> delta.annotations", async () => {
    const irChunks = await collect(
      convertResponsesEventStreamToOpenAI(
        (async function* () {
          yield {
            type: "response.output_text.annotation.added",
            sequence_number: 0,
            item_id: "i",
            output_index: 0,
            content_index: 0,
            annotation_index: 0,
            annotation: { type: "url_citation", url: "https://x" },
          } as ResponsesSSEEvent;
        })(),
      ),
    );
    const first = irChunks[0] as {
      choices?: Array<{ delta?: { annotations?: Array<{ url?: string }> } }>;
    };
    expect(first.choices?.[0]?.delta?.annotations?.[0]?.url).toBe("https://x");
  });
});

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

  it("created/in_progress/completed carry the same non-empty model from the request seed", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("hi"), textChunk("", "stop")]), {
        model: "gpt-seeded",
      }),
    );
    const responseEvents = events.filter(
      (
        e,
      ): e is Extract<
        ResponsesSSEEvent,
        { type: "response.created" | "response.in_progress" | "response.completed" }
      > =>
        e.type === "response.created" ||
        e.type === "response.in_progress" ||
        e.type === "response.completed",
    );
    expect(responseEvents.map((e) => e.response.model)).toEqual([
      "gpt-seeded",
      "gpt-seeded",
      "gpt-seeded",
    ]);
  });

  it("done item and final response output mark message items completed", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("hi"), textChunk("", "stop")]), {
        model: "gpt-x",
      }),
    );
    const done = events.find((e) => e.type === "response.output_item.done") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.done" }
    >;
    expect(done.item).toMatchObject({ type: "message", status: "completed" });
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.output[0]).toMatchObject({ type: "message", status: "completed" });
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

  // order 21: reasoning_tokens (output) + cached (input) must ride the streamed usage
  // projection, so an o-series streaming client gets the same detail as non-streaming.
  it("projects reasoning_tokens + cached into response.completed usage details (order 21)", async () => {
    const usageChunk: OpenAIChunk = {
      id: "chatcmpl-x",
      model: "gpt-x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 8 },
      },
    } as OpenAIChunk;
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("hi"), usageChunk])),
    );
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    const usage = completed.response.usage as {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
    expect(usage.input_tokens).toBe(100); // full prompt reconstructed (cached + non-cached)
    expect(usage.input_tokens_details?.cached_tokens).toBe(30);
    expect(usage.output_tokens_details?.reasoning_tokens).toBe(8);
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

  it("marks function_call added as in_progress and done/final output as completed", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_ping", function: { name: "ping", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks), { model: "gpt-x" }));
    const added = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(added.item).toMatchObject({ type: "function_call", status: "in_progress" });
    const done = events.find((e) => e.type === "response.output_item.done") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.done" }
    >;
    expect(done.item).toMatchObject({ type: "function_call", status: "completed" });
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.output[0]).toMatchObject({
      type: "function_call",
      status: "completed",
    });
  });

  it("keeps no-argument function_call items when name/call_id arrives with empty arguments", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_empty", function: { name: "ping", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks), { model: "gpt-x" }));
    const added = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(added.item).toMatchObject({
      type: "function_call",
      call_id: "call_empty",
      name: "ping",
      arguments: "",
    });
    const argsDone = events.find(
      (e) => e.type === "response.function_call_arguments.done",
    ) as Extract<ResponsesSSEEvent, { type: "response.function_call_arguments.done" }>;
    expect(argsDone.arguments).toBe("");
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.output).toHaveLength(1);
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
    expect((added[0]?.item as { call_id?: string }).call_id).toBe("c0");
    expect((added[1]?.item as { call_id?: string }).call_id).toBe("c1");
  });

  it("keeps function_call when call_id arrives without arguments/name", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_only" }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collect(convertOpenAIStreamToResponses(feed(chunks)));
    const added = events.find((e) => e.type === "response.output_item.added") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.added" }
    >;
    expect(added.item).toMatchObject({
      type: "function_call",
      call_id: "call_only",
      name: "",
      status: "in_progress",
      arguments: "",
    });
    const argsDone = events.find(
      (e) => e.type === "response.function_call_arguments.done",
    ) as Extract<ResponsesSSEEvent, { type: "response.function_call_arguments.done" }>;
    expect(argsDone.arguments).toBe("");
    const done = events.find((e) => e.type === "response.output_item.done") as Extract<
      ResponsesSSEEvent,
      { type: "response.output_item.done" }
    >;
    expect(done.item).toMatchObject({
      type: "function_call",
      call_id: "call_only",
      status: "completed",
      arguments: "",
    });
    const completed = events.at(-1) as Extract<ResponsesSSEEvent, { type: "response.completed" }>;
    expect(completed.response.output).toEqual([expect.objectContaining(done.item)]);
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
  // order 24: an incomplete result terminates with a distinct response.incomplete
  // event (OpenAI's wire contract), NOT response.completed with an incomplete status.
  it("maps finish_reason length → terminal response.incomplete event", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("x"), textChunk("", "length")])),
    );
    const terminal = events.at(-1) as ResponsesSSEEvent;
    expect(terminal.type).toBe("response.incomplete");
    if (terminal.type === "response.incomplete")
      expect(terminal.response.status).toBe("incomplete");
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });

  // Codex P2: response.incomplete must carry incomplete_details.reason so a client (and
  // the reverse path) can tell content_filter from max_tokens.
  it("carries incomplete_details.reason=content_filter on a filtered stream", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("x"), textChunk("", "content_filter")])),
    );
    const terminal = events.at(-1) as ResponsesSSEEvent;
    expect(terminal.type).toBe("response.incomplete");
    if (terminal.type === "response.incomplete") {
      expect(
        (terminal.response as { incomplete_details?: { reason?: string } }).incomplete_details
          ?.reason,
      ).toBe("content_filter");
    }
  });

  it("carries incomplete_details.reason=max_tokens on a length-capped stream", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([textChunk("x"), textChunk("", "length")])),
    );
    const terminal = events.at(-1) as ResponsesSSEEvent;
    if (terminal.type === "response.incomplete") {
      expect(
        (terminal.response as { incomplete_details?: { reason?: string } }).incomplete_details
          ?.reason,
      ).toBe("max_tokens");
    }
  });

  it("reverse: response.incomplete{content_filter} maps to finish_reason=content_filter", async () => {
    const irChunks = await collect(
      convertResponsesEventStreamToOpenAI(
        (async function* () {
          yield {
            type: "response.incomplete",
            sequence_number: 0,
            response: {
              id: "r",
              object: "response",
              model: "m",
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          } as ResponsesSSEEvent;
        })(),
      ),
    );
    const last = irChunks.at(-1) as { choices?: Array<{ finish_reason?: string }> };
    expect(last.choices?.[0]?.finish_reason).toBe("content_filter");
  });

  it("reverse: a response.incomplete upstream event maps to finish_reason=length", async () => {
    const irChunks = await collect(
      convertResponsesEventStreamToOpenAI(
        (async function* () {
          yield {
            type: "response.incomplete",
            sequence_number: 0,
            response: {
              id: "r",
              object: "response",
              model: "m",
              status: "incomplete",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          } as ResponsesSSEEvent;
        })(),
      ),
    );
    const last = irChunks.at(-1) as { choices?: Array<{ finish_reason?: string }> };
    expect(last.choices?.[0]?.finish_reason).toBe("length");
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

// —— 3b. reasoning streaming + error event ————————————————————————————————————

describe("convertOpenAIStreamToResponses — reasoning summary streaming", () => {
  function reasoningChunk(reasoning: string): OpenAIChunk {
    return {
      id: "chatcmpl-r",
      model: "gpt-x",
      choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
    };
  }

  it("emits a reasoning item + reasoning_summary_text.delta events for reasoning_content", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(
        feed([reasoningChunk("think"), reasoningChunk("ing"), textChunk("Hi", "stop")]),
      ),
    );
    const types = events.map((e) => e.type);
    // reasoning item opens before text item
    expect(types).toContain("response.reasoning_summary_text.delta");
    const deltas = events
      .filter((e) => e.type === "response.reasoning_summary_text.delta")
      .map(
        (e) =>
          (e as Extract<ResponsesSSEEvent, { type: "response.reasoning_summary_text.delta" }>)
            .delta,
      )
      .join("");
    expect(deltas).toBe("thinking");
    const done = events.find((e) => e.type === "response.reasoning_summary_text.done") as
      | Extract<ResponsesSSEEvent, { type: "response.reasoning_summary_text.done" }>
      | undefined;
    expect(done?.text).toBe("thinking");
    // reasoning item is opened (output_item.added with type reasoning)
    const reasoningAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e as Extract<ResponsesSSEEvent, { type: "response.output_item.added" }>).item.type ===
          "reasoning",
    );
    expect(reasoningAdded).toBeDefined();
  });

  it("keeps strictly monotonic sequence_number across reasoning + text events", async () => {
    const events = await collect(
      convertOpenAIStreamToResponses(feed([reasoningChunk("r"), textChunk("t", "stop")])),
    );
    const s = seqs(events);
    expect(s[0]).toBe(0);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]).toBe((s[i - 1] as number) + 1);
    }
  });

  // Regression (Codex P3): reasoning must survive the cache-hit / non-stream synth.
  it("synthesizeResponsesSSEFromJSON carries reasoning_content into a reasoning event", async () => {
    const events = await collect(
      synthesizeResponsesSSEFromJSON({
        id: "resp_r",
        model: "o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer", reasoning_content: "ponder" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const done = events.find((e) => e.type === "response.reasoning_summary_text.done") as
      | Extract<ResponsesSSEEvent, { type: "response.reasoning_summary_text.done" }>
      | undefined;
    expect(done?.text).toBe("ponder");
  });
});

describe("convertResponsesEventStreamToOpenAI — reasoning delta -> IR (reverse)", () => {
  it("folds response.reasoning_summary_text.delta back into an IR chunk reasoning_content", async () => {
    async function* events(): AsyncIterable<ResponsesSSEEvent> {
      yield {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 0,
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "deep ",
      };
      yield {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 1,
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "thought",
      };
    }
    const chunks = await collect(convertResponsesEventStreamToOpenAI(events()));
    const reasoning = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.delta?.reasoning_content)
      .filter((r): r is string => typeof r === "string")
      .join("");
    expect(reasoning).toBe("deep thought");
  });
});

describe("convertOpenAIStreamToResponses — mid-stream error event", () => {
  it("emits a Responses error event when the upstream feed throws", async () => {
    async function* boom(): AsyncIterable<OpenAIChunk> {
      yield textChunk("partial");
      throw new Error("upstream exploded");
    }
    const events = await collect(convertOpenAIStreamToResponses(boom()));
    const err = events.find((e) => e.type === "error") as
      | Extract<ResponsesSSEEvent, { type: "error" }>
      | undefined;
    expect(err).toBeDefined();
    expect(err?.error.message).toContain("upstream exploded");
    expect(typeof err?.error.code).toBe("string");
    expect(typeof err?.sequence_number).toBe("number");
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
