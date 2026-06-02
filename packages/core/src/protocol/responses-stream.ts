import { z } from "zod";
import { type OpenAIChunk, OpenAIChunkSchema } from "./anthropic/stream.js";
import type { IRResponse, IRUsage } from "./ir.js";
import { mapResponsesStatus } from "./responses.js";

// OpenAI chunk → OpenAI **Responses** (`response.*`) SSE event stream: the SECOND
// explicit IR→SSE state machine (the first being the Anthropic alphabet in
// `anthropic/stream.ts`). Streaming is protocol translation's #1 risk (CLAUDE.md
// principle 8, docs/05): an upstream OpenAI `data: {chunk}` feed is turned, frame
// by frame, into the deterministic Responses event sequence
//
//   response.created
//   response.in_progress
//     (TEXT)  response.output_item.added(message)
//             response.content_part.added(output_text)
//             response.output_text.delta × N
//             response.output_text.done   (accumulated full text)
//             response.content_part.done
//             response.output_item.done
//     (TOOL)  response.output_item.added(function_call, name, call_id)
//             response.function_call_arguments.delta × N
//             response.function_call_arguments.done (accumulated arguments)
//             response.output_item.done
//   response.completed   (terminal response object + status + usage)
//
// There is NO `[DONE]` sentinel: the terminal `response.completed` closes the
// stream. Every event carries a strictly monotonic `sequence_number` allocated
// from the state counter (the Anthropic machine has no analogue).
//
// All the difficulty is in the STATE (docs/05 pits #2/#3/#4 + research-notes):
//   • output_index is allocated monotonically, never reused;
//   • OpenAI's integer tool_call `index` maps to a STABLE Responses output_index,
//     so fragmented argument deltas never cross items;
//   • a tool-call id/name may only arrive on a later fragment — we DEFER the
//     `output_item.added` for a tool item until the id/name are settled (same
//     discipline as the Anthropic machine), and SKIP an empty husk item that
//     never produced a name or any argument fragment;
//   • usage is BUFFERED and flushed ONLY on `response.completed` (never billed
//     mid-stream, so a cache read is not double-counted, pit #2);
//   • close is IDEMPOTENT: every `output_item.done` and the terminal
//     `response.completed` is emitted at most once (`openItems` guard, pit #4);
//   • `response.created` + `response.in_progress` are emitted UNCONDITIONALLY
//     before the loop — an empty/zero-chunk stream must still produce a legal
//     `created…completed` envelope (the Anthropic machine gates `message_start`
//     inside the loop and so would emit NOTHING for an empty stream).
//
// Pure logic, framework-agnostic (CLAUDE.md principle 1): produces event OBJECTS
// only, NOT coupled to Hono's `streamSSE` — that wiring lives in the gateway. The
// terminal status reuses `mapResponsesStatus` from responses.ts so the streaming
// and non-streaming paths cannot diverge; the usage projection inlines the same
// 2-line shape `toResponsesResponse` produces (that helper is not exported).
// Reimplemented from the docs, NOT copied from musistudio/llms or litellm. No `any`.

// —— Output alphabet: Responses `response.*` SSE events. ———————————————————————
// One discriminated union on `type`, mirroring `AnthropicSSEEventSchema`. Building
// each event THROUGH the schema means a malformed event fails in tests, not in
// production. `sequence_number` rides every event (the Responses wire contract).

const ResponsesMessageItemSchema = z.object({
  type: z.literal("message"),
  id: z.string(),
  status: z.enum(["in_progress", "completed"]),
  role: z.literal("assistant"),
  content: z.array(z.unknown()),
});

const ResponsesFunctionCallItemSchema = z.object({
  type: z.literal("function_call"),
  id: z.string(),
  status: z.enum(["in_progress", "completed"]),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const ResponsesOutputItemSchema = z.union([
  ResponsesMessageItemSchema,
  ResponsesFunctionCallItemSchema,
]);

const ResponsesUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

const ResponseObjectSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  model: z.string(),
  status: z.string(),
  output: z.array(z.unknown()),
  usage: ResponsesUsageSchema.optional(),
});

const ResponseCreatedSchema = z.object({
  type: z.literal("response.created"),
  sequence_number: z.number().int().nonnegative(),
  response: ResponseObjectSchema,
});
const ResponseInProgressSchema = z.object({
  type: z.literal("response.in_progress"),
  sequence_number: z.number().int().nonnegative(),
  response: ResponseObjectSchema,
});
const OutputItemAddedSchema = z.object({
  type: z.literal("response.output_item.added"),
  sequence_number: z.number().int().nonnegative(),
  output_index: z.number().int().nonnegative(),
  item: ResponsesOutputItemSchema,
});
const ContentPartAddedSchema = z.object({
  type: z.literal("response.content_part.added"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  part: z.object({ type: z.literal("output_text"), text: z.literal("") }),
});
const OutputTextDeltaSchema = z.object({
  type: z.literal("response.output_text.delta"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  delta: z.string(),
});
const OutputTextDoneSchema = z.object({
  type: z.literal("response.output_text.done"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  text: z.string(),
});
const ContentPartDoneSchema = z.object({
  type: z.literal("response.content_part.done"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  part: z.object({ type: z.literal("output_text"), text: z.string() }),
});
const FunctionCallArgumentsDeltaSchema = z.object({
  type: z.literal("response.function_call_arguments.delta"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  delta: z.string(),
});
const FunctionCallArgumentsDoneSchema = z.object({
  type: z.literal("response.function_call_arguments.done"),
  sequence_number: z.number().int().nonnegative(),
  item_id: z.string(),
  output_index: z.number().int().nonnegative(),
  arguments: z.string(),
});
const OutputItemDoneSchema = z.object({
  type: z.literal("response.output_item.done"),
  sequence_number: z.number().int().nonnegative(),
  output_index: z.number().int().nonnegative(),
  item: ResponsesOutputItemSchema,
});
const ResponseCompletedSchema = z.object({
  type: z.literal("response.completed"),
  sequence_number: z.number().int().nonnegative(),
  response: ResponseObjectSchema,
});

export const ResponsesSSEEventSchema = z.discriminatedUnion("type", [
  ResponseCreatedSchema,
  ResponseInProgressSchema,
  OutputItemAddedSchema,
  ContentPartAddedSchema,
  OutputTextDeltaSchema,
  OutputTextDoneSchema,
  ContentPartDoneSchema,
  FunctionCallArgumentsDeltaSchema,
  FunctionCallArgumentsDoneSchema,
  OutputItemDoneSchema,
  ResponseCompletedSchema,
]);
export type ResponsesSSEEvent = z.infer<typeof ResponsesSSEEventSchema>;

type ResponsesOutputItem = z.infer<typeof ResponsesOutputItemSchema>;

// —— State object (docs/05). Pure data; the generator drives the transitions. ————

interface TextSlot {
  outputIndex: number;
  itemId: string;
  started: boolean; // output_item.added + content_part.added emitted?
  textBuffer: string; // accumulated text (flushed on output_text.done)
}

interface ToolSlot {
  outputIndex: number;
  itemId: string;
  started: boolean; // output_item.added emitted?
  callId: string; // real id (a temp id until the upstream supplies one)
  name: string;
  argBuffer: string; // accumulated argument fragments (tolerates partial JSON)
}

interface StreamState {
  sequenceNumber: number; // monotonic per-event counter (allocated on emit)
  responseId: string; // stable response id reused on created + completed
  model: string;
  nextOutputIndex: number; // monotonic output-index allocator
  openItems: Set<number>; // started-but-not-done items (close guard)
  textSlot: TextSlot | null; // lazily allocated text item
  toolIndexToSlot: Map<number, ToolSlot>; // OpenAI tool index → output slot
  finishReason: string | null; // terminal status source
  usage: IRUsage | null; // buffered; flushed on response.completed
}

function createState(model = "unknown"): StreamState {
  return {
    sequenceNumber: 0,
    responseId: "",
    model,
    nextOutputIndex: 0,
    openItems: new Set(),
    textSlot: null,
    toolIndexToSlot: new Map(),
    finishReason: null,
    usage: null,
  };
}

function nextSeq(state: StreamState): number {
  const s = state.sequenceNumber;
  state.sequenceNumber += 1;
  return s;
}

function allocOutputIndex(state: StreamState): number {
  const i = state.nextOutputIndex;
  state.nextOutputIndex += 1;
  state.openItems.add(i);
  return i;
}

// A monotonically-unique synthesized id when the upstream supplies none. Stable
// across the whole stream once allocated.
function synthResponseId(): string {
  return `resp_${Math.random().toString(36).slice(2, 14)}`;
}
function synthCallId(outputIndex: number): string {
  return `call_${outputIndex}`;
}
function itemId(outputIndex: number): string {
  return `item_${outputIndex}`;
}

// —— usage projection: IR usage → Responses { input_tokens, output_tokens }. The
// same 2-line shape `toResponsesResponse` produces (that helper is unexported, so
// inline it rather than reference a non-existent symbol). ——————————————————————
function projectUsage(usage: IRUsage | null): z.infer<typeof ResponsesUsageSchema> | undefined {
  if (usage === null) return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
}

function responseObject(
  state: StreamState,
  opts: { status: string; output?: unknown[]; usage?: z.infer<typeof ResponsesUsageSchema> },
): z.infer<typeof ResponseObjectSchema> {
  return {
    id: state.responseId,
    object: "response",
    model: state.model,
    status: opts.status,
    output: opts.output ?? [],
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
}

// —— The state machine ————————————————————————————————————————————————————————

/**
 * Turn an async OpenAI chunk stream into a Responses `response.*` SSE event
 * stream. Pure generator — NOT bound to Hono's streamSSE. Deterministic event
 * sequence with a monotonic output-index allocator, a stable tool-index→item map,
 * deferred tool-item start (id/name settled before the consumer sees `.added`),
 * buffered terminal usage, and idempotent close guards. `response.created` +
 * `response.in_progress` are emitted unconditionally so an empty stream still
 * yields a legal envelope.
 */
export async function* convertOpenAIStreamToResponses(
  chunks: AsyncIterable<OpenAIChunk>,
  // Optional seed: the synthesizer passes the IR response id/model so cache-hit
  // created/completed matches the non-stream body; live streams pass request model
  // so prelude events never expose an empty model before the first upstream chunk.
  seed?: string | { id?: string; model?: string },
): AsyncIterable<ResponsesSSEEvent> {
  const seedId = typeof seed === "string" ? seed : seed?.id;
  const seedModel =
    typeof seed === "object" && seed.model !== undefined && seed.model !== ""
      ? seed.model
      : "unknown";
  const state = createState(seedModel);
  state.responseId = seedId !== undefined && seedId !== "" ? seedId : synthResponseId();

  // Unconditional prelude: an empty/zero-chunk stream still terminates cleanly.
  yield ResponsesSSEEventSchema.parse({
    type: "response.created",
    sequence_number: nextSeq(state),
    response: responseObject(state, { status: "in_progress" }),
  });
  yield ResponsesSSEEventSchema.parse({
    type: "response.in_progress",
    sequence_number: nextSeq(state),
    response: responseObject(state, { status: "in_progress" }),
  });

  for await (const raw of chunks) {
    const chunk = OpenAIChunkSchema.parse(raw);
    if (state.model === "" && typeof chunk.model === "string") state.model = chunk.model;

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // —— text: lazily open the text item + content part, then stream deltas. ——
    if (delta?.content) {
      if (state.textSlot === null) {
        const outputIndex = allocOutputIndex(state);
        const slot: TextSlot = {
          outputIndex,
          itemId: itemId(outputIndex),
          started: true,
          textBuffer: "",
        };
        state.textSlot = slot;
        yield ResponsesSSEEventSchema.parse({
          type: "response.output_item.added",
          sequence_number: nextSeq(state),
          output_index: slot.outputIndex,
          item: {
            type: "message",
            id: slot.itemId,
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        yield ResponsesSSEEventSchema.parse({
          type: "response.content_part.added",
          sequence_number: nextSeq(state),
          item_id: slot.itemId,
          output_index: slot.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "" },
        });
      }
      const slot = state.textSlot;
      slot.textBuffer += delta.content;
      yield ResponsesSSEEventSchema.parse({
        type: "response.output_text.delta",
        sequence_number: nextSeq(state),
        item_id: slot.itemId,
        output_index: slot.outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    // —— tool calls: integer index → stable output item; temp id → real upgrade. ——
    for (const tc of delta?.tool_calls ?? []) {
      let slot = state.toolIndexToSlot.get(tc.index);
      if (slot === undefined) {
        const outputIndex = allocOutputIndex(state);
        slot = {
          outputIndex,
          itemId: itemId(outputIndex),
          started: false,
          callId: tc.id ?? "",
          name: tc.function?.name ?? "",
          argBuffer: "",
        };
        state.toolIndexToSlot.set(tc.index, slot);
      } else {
        if (tc.id !== undefined && tc.id !== "") slot.callId = tc.id;
        if (tc.function?.name !== undefined && tc.function.name !== "")
          slot.name = tc.function.name;
      }

      const args = tc.function?.arguments;
      if (args !== undefined || slot.name !== "") {
        // First meaningful tool signal: settle id/name and emit output_item.added before
        // any argument delta (item added ALWAYS precedes its deltas, pit #4).
        if (!slot.started) {
          slot.started = true;
          yield ResponsesSSEEventSchema.parse({
            type: "response.output_item.added",
            sequence_number: nextSeq(state),
            output_index: slot.outputIndex,
            item: {
              type: "function_call",
              id: slot.itemId,
              call_id: slot.callId !== "" ? slot.callId : synthCallId(slot.outputIndex),
              name: slot.name,
              status: "in_progress",
              arguments: "",
            },
          });
        }
        if (args !== undefined && args !== "") {
          slot.argBuffer += args;
          yield ResponsesSSEEventSchema.parse({
            type: "response.function_call_arguments.delta",
            sequence_number: nextSeq(state),
            item_id: slot.itemId,
            output_index: slot.outputIndex,
            delta: args,
          });
        }
      }
    }

    // Buffer usage; never billed mid-stream (pit #2). Raw upstream prompt_tokens is
    // the FULL prompt; normalize prompt = max(0, prompt − cached) so the projection
    // matches the non-stream toResponsesResponse path.
    if (chunk.usage) {
      const u = chunk.usage;
      const cached = u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      state.usage = {
        ...(u.prompt_tokens !== undefined
          ? { prompt_tokens: Math.max(0, u.prompt_tokens - cached) }
          : {}),
        ...(u.completion_tokens !== undefined ? { completion_tokens: u.completion_tokens } : {}),
        ...(cached > 0 ? { cached_tokens: cached } : {}),
      };
    }
    if (choice?.finish_reason != null) state.finishReason = choice.finish_reason;
  }

  // —— Stream end: close the text item (text done → part done → item done). ——
  const finalOutput: ResponsesOutputItem[] = [];
  if (state.textSlot !== null && state.openItems.has(state.textSlot.outputIndex)) {
    const slot = state.textSlot;
    yield ResponsesSSEEventSchema.parse({
      type: "response.output_text.done",
      sequence_number: nextSeq(state),
      item_id: slot.itemId,
      output_index: slot.outputIndex,
      content_index: 0,
      text: slot.textBuffer,
    });
    yield ResponsesSSEEventSchema.parse({
      type: "response.content_part.done",
      sequence_number: nextSeq(state),
      item_id: slot.itemId,
      output_index: slot.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: slot.textBuffer },
    });
    const item: ResponsesOutputItem = {
      type: "message",
      id: slot.itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: slot.textBuffer }],
    };
    state.openItems.delete(slot.outputIndex);
    yield ResponsesSSEEventSchema.parse({
      type: "response.output_item.done",
      sequence_number: nextSeq(state),
      output_index: slot.outputIndex,
      item,
    });
    finalOutput.push(item);
  }

  // —— Close each started tool item; drop empty husks. Iterate in allocation order
  // so output ordering is deterministic. ——
  const toolSlots = [...state.toolIndexToSlot.values()].sort(
    (a, b) => a.outputIndex - b.outputIndex,
  );
  for (const slot of toolSlots) {
    if (!slot.started) {
      // A husk that never produced a name AND never produced an argument fragment:
      // drop it entirely (never started, so no .added was emitted — pit #4).
      state.openItems.delete(slot.outputIndex);
      continue;
    }
    if (!state.openItems.has(slot.outputIndex)) continue;
    const callId = slot.callId !== "" ? slot.callId : synthCallId(slot.outputIndex);
    yield ResponsesSSEEventSchema.parse({
      type: "response.function_call_arguments.done",
      sequence_number: nextSeq(state),
      item_id: slot.itemId,
      output_index: slot.outputIndex,
      arguments: slot.argBuffer,
    });
    const item: ResponsesOutputItem = {
      type: "function_call",
      id: slot.itemId,
      call_id: callId,
      status: "completed",
      name: slot.name,
      arguments: slot.argBuffer,
    };
    state.openItems.delete(slot.outputIndex);
    yield ResponsesSSEEventSchema.parse({
      type: "response.output_item.done",
      sequence_number: nextSeq(state),
      output_index: slot.outputIndex,
      item,
    });
    finalOutput.push(item);
  }

  // —— Terminal response.completed: status via mapResponsesStatus (cannot diverge
  // from the non-stream path), usage flushed exactly once here. ——
  const { status } = mapResponsesStatus(state.finishReason);
  yield ResponsesSSEEventSchema.parse({
    type: "response.completed",
    sequence_number: nextSeq(state),
    response: responseObject(state, {
      status,
      output: finalOutput,
      ...(projectUsage(state.usage) !== undefined ? { usage: projectUsage(state.usage) } : {}),
    }),
  });
}

// —— JSON → SSE synthesizer (cache hit / non-streaming upstream). ————————————————

/**
 * Explode ONE complete IR response into the SAME deterministic event sequence a
 * real stream would produce, so a streaming Responses client cannot tell a cache
 * hit / a non-streaming upstream apart. Reuses `convertOpenAIStreamToResponses` by
 * synthesizing a single-chunk feed, guaranteeing the two paths are isomorphic.
 */
export async function* synthesizeResponsesSSEFromJSON(
  resp: IRResponse,
): AsyncIterable<ResponsesSSEEvent> {
  const choice = resp.choices[0];
  const message = choice?.message;

  const delta: NonNullable<NonNullable<OpenAIChunk["choices"]>[number]["delta"]> = {
    role: "assistant",
  };

  const content = message?.content;
  if (typeof content === "string") {
    if (content !== "") delta.content = content;
  } else if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (text !== "") delta.content = text;
  }

  const toolCalls = message?.tool_calls ?? [];
  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  const chunk: OpenAIChunk = {
    ...(resp.id !== undefined ? { id: resp.id } : {}),
    ...(resp.model !== undefined ? { model: resp.model } : {}),
    choices: [{ index: 0, delta, finish_reason: choice?.finish_reason ?? "stop" }],
    ...(resp.usage !== undefined ? { usage: resp.usage } : {}),
  };

  async function* single(): AsyncIterable<OpenAIChunk> {
    yield chunk;
  }

  yield* convertOpenAIStreamToResponses(single(), { id: resp.id, model: resp.model });
}
