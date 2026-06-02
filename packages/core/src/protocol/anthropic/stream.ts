import { z } from "zod";
import type { IRChunk } from "../gemini/gemini-types.js";
import type { IRResponse, IRUsage } from "../ir.js";
import {
  type AnthropicStopReason,
  type AnthropicUsage,
  createAnthropicToolNameMap,
  mapStopReason,
  mapUsage,
} from "./response.js";

// OpenAI chunk → Anthropic SSE event stream: the EXPLICIT state machine that is
// protocol translation's #1 risk (CLAUDE.md principle 8, docs/05). Streaming is
// NEVER passthrough: an upstream OpenAI `data: {chunk}` feed is turned, frame by
// frame, into the deterministic Anthropic event sequence
//
//   message_start
//     → content_block_start / content_block_delta* / content_block_stop  (per block)
//   message_delta (stop_reason + accumulated output usage)
//   message_stop
//
// All the difficulty is in the STATE (docs/05 pits #3/#4 + research-notes):
//   • content-block index is allocated monotonically, never reused;
//   • OpenAI's integer tool_call `index` maps to a STABLE Anthropic block index,
//     so fragmented `input_json_delta`s never cross blocks (litellm #25561);
//   • a tool-call id may only arrive on a later fragment — we open the block with a
//     temp id and upgrade it before the START event is observed by the consumer
//     (we DEFER content_block_start for a tool block until we have enough info);
//   • usage is BUFFERED to the terminal message_delta (never billed mid-stream, so
//     a cache read is not double-counted, pit #2);
//   • close is IDEMPOTENT: every content_block_stop and message_stop is emitted at
//     most once (guards against the "controller already closed" bug, pit #4).
//
// Pure logic, framework-agnostic (CLAUDE.md principle 1): it produces event OBJECTS
// and is NOT coupled to Hono's `streamSSE` — that wiring lives in the gateway. The
// terminal stop_reason/usage reuse `mapStopReason`/`mapUsage` from response.ts so
// the streaming and non-streaming paths cannot diverge. Reimplemented from the
// docs, NOT copied from musistudio/llms or litellm. No `any`.

// —— Inbound OpenAI streaming chunk schema (the subset we consume). —————————————
// Tolerant by design: an upstream may omit `id`/`name` on the first tool fragment
// and split `arguments` across many chunks. `.passthrough()` keeps unknown fields
// from breaking parse; everything optional degrades to a no-op.

const OpenAIToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const OpenAIChunkDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(OpenAIToolCallDeltaSchema).optional(),
});

const OpenAIChunkChoiceSchema = z.object({
  index: z.number().int().optional(),
  delta: OpenAIChunkDeltaSchema.optional(),
  finish_reason: z.string().nullable().optional(),
});

const OpenAIChunkUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    // Some upstreams flatten cached here; real OpenAI nests it under
    // prompt_tokens_details.cached_tokens (matching the non-stream openai.ts shape).
    cached_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .partial();

export const OpenAIChunkSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z.array(OpenAIChunkChoiceSchema).optional(),
    usage: OpenAIChunkUsageSchema.nullable().optional(),
  })
  .passthrough();
export type OpenAIChunk = z.infer<typeof OpenAIChunkSchema>;

// —— Anthropic SSE event schemas (the output alphabet of the state machine). ————
// One discriminated union on `type`, mirroring the Anthropic Messages streaming
// wire events. Deltas are themselves a discriminated union (text vs tool args).

const AnthropicTextBlockStartSchema = z.object({ type: z.literal("text"), text: z.literal("") });
const AnthropicToolUseBlockStartSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const AnthropicStartContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextBlockStartSchema,
  AnthropicToolUseBlockStartSchema,
]);

const AnthropicTextDeltaSchema = z.object({ type: z.literal("text_delta"), text: z.string() });
const AnthropicInputJSONDeltaSchema = z.object({
  type: z.literal("input_json_delta"),
  partial_json: z.string(),
});
const AnthropicBlockDeltaSchema = z.discriminatedUnion("type", [
  AnthropicTextDeltaSchema,
  AnthropicInputJSONDeltaSchema,
]);

const MessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  message: z.object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    model: z.string(),
    content: z.array(z.unknown()),
    stop_reason: z.null(),
    stop_sequence: z.null(),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
  }),
});

const ContentBlockStartEventSchema = z.object({
  type: z.literal("content_block_start"),
  index: z.number().int().nonnegative(),
  content_block: AnthropicStartContentBlockSchema,
});

const ContentBlockDeltaEventSchema = z.object({
  type: z.literal("content_block_delta"),
  index: z.number().int().nonnegative(),
  delta: AnthropicBlockDeltaSchema,
});

const ContentBlockStopEventSchema = z.object({
  type: z.literal("content_block_stop"),
  index: z.number().int().nonnegative(),
});

const MessageDeltaEventSchema = z.object({
  type: z.literal("message_delta"),
  delta: z.object({ stop_reason: z.string(), stop_sequence: z.null() }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
  }),
});

const MessageStopEventSchema = z.object({ type: z.literal("message_stop") });

export const AnthropicSSEEventSchema = z.discriminatedUnion("type", [
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
]);
export type AnthropicSSEEvent = z.infer<typeof AnthropicSSEEventSchema>;

// —— State object (docs/05). Pure data; the generator drives the transitions. ————

interface ToolSlot {
  blockIndex: number; // assigned Anthropic content-block index
  started: boolean; // whether content_block_start has been emitted yet
  id: string; // real id (a temp id until the upstream supplies one)
  name: string;
  argBuffer: string; // accumulated argument fragments (tolerates partial JSON)
}

interface StreamState {
  messageStarted: boolean; // message_start emitted?
  nextBlockIndex: number; // monotonic content-block index allocator
  openBlocks: Set<number>; // started-but-not-stopped blocks (close guard)
  textBlockIndex: number | null; // text block index (lazily allocated)
  toolIndexToBlock: Map<number, ToolSlot>; // OpenAI tool index → block slot
  toolNameMap: ReturnType<typeof createAnthropicToolNameMap>;
  finishReason: string | null; // terminal message_delta.stop_reason
  usage: IRUsage | null; // buffered; flushed on the terminal event
}

function createState(): StreamState {
  return {
    messageStarted: false,
    nextBlockIndex: 0,
    openBlocks: new Set(),
    textBlockIndex: null,
    toolIndexToBlock: new Map(),
    toolNameMap: createAnthropicToolNameMap(),
    finishReason: null,
    usage: null,
  };
}

function allocBlock(state: StreamState): number {
  const i = state.nextBlockIndex;
  state.nextBlockIndex += 1;
  state.openBlocks.add(i);
  return i;
}

// A monotonically-unique temporary id for a tool block whose real id has not yet
// arrived on the wire. It is replaced before the START event is emitted.
function tempId(blockIndex: number): string {
  return `tmp_tool_${blockIndex}`;
}

// —— Event constructors ————————————————————————————————————————————————————————

function messageStartEvent(): AnthropicSSEEvent {
  // The skeleton usage carries zeros; the real input/output land on message_delta.
  return {
    type: "message_start",
    message: {
      id: "",
      type: "message",
      role: "assistant",
      model: "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function textDeltaEvent(index: number, text: string): AnthropicSSEEvent {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

function inputJSONDeltaEvent(index: number, partial: string): AnthropicSSEEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partial },
  };
}

function messageDeltaEvent(state: StreamState): AnthropicSSEEvent {
  const stop = mapStopReason(state.finishReason ?? "");
  const usage: AnthropicUsage = mapUsage(state.usage ?? {});
  return {
    type: "message_delta",
    delta: { stop_reason: stop.stop_reason satisfies AnthropicStopReason, stop_sequence: null },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    },
  };
}

// —— The state machine ————————————————————————————————————————————————————————

/**
 * Turn an async OpenAI chunk stream into an Anthropic SSE event stream. Pure
 * generator — NOT bound to Hono's streamSSE. Deterministic event sequence with a
 * monotonic block allocator, a stable tool-index→block map, temp-id→real-id
 * upgrade, buffered terminal usage, and idempotent stop/close guards.
 *
 * Tool-block START is DEFERRED: a tool's `content_block_start` is emitted lazily
 * on the FIRST event that carries an argument fragment (or at stream end), so the
 * id observed by the consumer is already the upgraded real id when it was supplied
 * on an early fragment — the spec's "guarantee the id is settled by first emit"
 * strategy, which sidesteps emitting a temp id the client could act on.
 */
export async function* convertOpenAIStreamToAnthropic(
  chunks: AsyncIterable<OpenAIChunk>,
): AsyncIterable<AnthropicSSEEvent> {
  const state = createState();

  for await (const raw of chunks) {
    const chunk = OpenAIChunkSchema.parse(raw);

    if (!state.messageStarted) {
      state.messageStarted = true;
      yield messageStartEvent();
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // —— text: lazily open the text block, then stream text_delta. ——
    if (delta?.content) {
      if (state.textBlockIndex === null) {
        const i = allocBlock(state);
        state.textBlockIndex = i;
        yield {
          type: "content_block_start",
          index: i,
          content_block: { type: "text", text: "" },
        };
      }
      yield textDeltaEvent(state.textBlockIndex, delta.content);
    }

    // —— tool calls: integer index → stable block; temp id → real id upgrade. ——
    for (const tc of delta?.tool_calls ?? []) {
      let slot = state.toolIndexToBlock.get(tc.index);
      if (slot === undefined) {
        const blockIndex = allocBlock(state);
        slot = {
          blockIndex,
          started: false,
          id: tc.id ?? tempId(blockIndex),
          name:
            tc.function?.name !== undefined ? state.toolNameMap.toAnthropic(tc.function.name) : "",
          argBuffer: "",
        };
        state.toolIndexToBlock.set(tc.index, slot);
      } else {
        // Upgrade a temp id to the real one and backfill a late-arriving name.
        if (tc.id !== undefined && tc.id !== "") slot.id = tc.id;
        if (tc.function?.name !== undefined && tc.function.name !== "")
          slot.name = state.toolNameMap.toAnthropic(tc.function.name);
      }

      const args = tc.function?.arguments;
      if (args !== undefined && args !== "") {
        // First argument fragment: settle id/name and emit START before any delta
        // (block start ALWAYS precedes its deltas — no orphan delta, pit #4).
        if (!slot.started) {
          slot.started = true;
          yield {
            type: "content_block_start",
            index: slot.blockIndex,
            content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} },
          };
        }
        slot.argBuffer += args;
        yield inputJSONDeltaEvent(slot.blockIndex, args);
      }
    }

    // Buffer usage; never billed mid-stream (pit #2). Raw upstream `prompt_tokens` is
    // the FULL prompt (cached + fresh), but mapUsage() expects IR usage where prompt
    // has ALREADY had cached subtracted (the non-stream openai.ts path does the same).
    // Normalize here: prompt = max(0, prompt − cached), carry cached separately. Read
    // cached from the flat field OR the real OpenAI prompt_tokens_details nesting.
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

  // —— Stream end: flush any tool block that never saw an argument fragment, close
  // every open block exactly once, then the terminal events. ——
  for (const slot of state.toolIndexToBlock.values()) {
    if (slot.started) continue;
    // A slot that never produced a name AND never produced an argument fragment is an
    // empty husk (upstream announced an index/id then dropped it). Emitting it would
    // produce a name:'' tool_use block AND — worse — an orphan content_block_stop
    // (pit #4). Skip ALLOCATION entirely: drop its block from the close set, never start.
    if (slot.name === "" && slot.argBuffer === "") {
      state.openBlocks.delete(slot.blockIndex);
      continue;
    }
    slot.started = true;
    yield {
      type: "content_block_start",
      index: slot.blockIndex,
      content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} },
    };
  }

  // Close blocks in allocation order; the openBlocks set guarantees each fires once.
  for (let i = 0; i < state.nextBlockIndex; i++) {
    if (state.openBlocks.delete(i)) {
      yield { type: "content_block_stop", index: i };
    }
  }

  yield messageDeltaEvent(state);
  yield { type: "message_stop" };
}

// —— JSON → SSE synthesizer (cache hit / non-streaming upstream). ————————————————

/**
 * Explode ONE complete IR response into the SAME deterministic event sequence a
 * real stream would produce, so a streaming client cannot tell a cache hit / a
 * non-streaming upstream apart. Reuses `convertOpenAIStreamToAnthropic` by
 * synthesizing a single-chunk feed, guaranteeing the two paths are isomorphic.
 */
export async function* synthesizeSSEFromJSON(resp: IRResponse): AsyncIterable<AnthropicSSEEvent> {
  const choice = resp.choices[0];
  const message = choice?.message;

  // Build a single OpenAI chunk equivalent to the whole response.
  const delta: z.infer<typeof OpenAIChunkDeltaSchema> = { role: "assistant" };

  const content = message?.content;
  if (typeof content === "string") {
    if (content !== "") delta.content = content;
  } else if (Array.isArray(content)) {
    // Join multipart text; thinking/image parts have no streaming text_delta here.
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

  yield* convertOpenAIStreamToAnthropic(single());
}

// ——————————————————————————————————————————————————————————————————————————————
// Inbound: native Anthropic SSE events -> IR chunks (issue #59, Theme 2). The
// reverse of convertOpenAIStreamToAnthropic: an Anthropic provider stream becomes
// the IR (OpenAI chat.completion.chunk) shape the hub speaks. Reference
// translateAnthropicSSE (provider/anthropic.ts) but yield IR chunk OBJECTS, not
// OpenAI SSE strings — framework-agnostic, no Hono, no [DONE] sentinel.
//
//   message_start            -> a {role:"assistant"} delta chunk
//   content_block_start(text)-> (no emit; text arrives via deltas)
//   content_block_start(tool)-> a tool_calls delta announcing id+name (args: "")
//   content_block_delta      -> text_delta -> {content}; input_json_delta -> tool args
//   message_delta            -> buffer stop_reason + usage (flushed on terminal chunk)
//   message_stop             -> terminal chunk carrying finish_reason + usage
//
// Anthropic input_tokens is ALREADY the non-cached input, so prompt_tokens maps
// straight across; cache_read_input_tokens -> cached_tokens (never double-billed).

const STOP_REASON_TO_FINISH_STREAM: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

interface InboundToolState {
  openaiIndex: number; // the OpenAI integer tool_call index
}

export async function* convertAnthropicStreamToIR(
  events: AsyncIterable<AnthropicSSEEvent>,
): AsyncIterable<IRChunk> {
  let model = "";
  let id = "";
  let started = false;
  let nextToolIndex = 0;
  // Anthropic content-block index -> OpenAI tool_call index (only for tool blocks).
  const blockToTool = new Map<number, InboundToolState>();
  let finishReason: string | null = null;
  let usage: IRChunk["usage"] | undefined;

  function base(): IRChunk {
    return {
      ...(id !== "" ? { id } : {}),
      ...(model !== "" ? { model } : {}),
    };
  }

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        id = event.message.id !== "" ? event.message.id : id;
        model = event.message.model !== "" ? event.message.model : model;
        started = true;
        yield { ...base(), choices: [{ index: 0, delta: { role: "assistant" } }] };
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          const openaiIndex = nextToolIndex;
          nextToolIndex += 1;
          blockToTool.set(event.index, { openaiIndex });
          yield {
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: openaiIndex,
                      id: block.id,
                      type: "function",
                      function: { name: block.name, arguments: "" },
                    },
                  ],
                },
              },
            ],
          };
        }
        // text block start carries no payload; deltas follow.
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          if (!started) {
            started = true;
            yield { ...base(), choices: [{ index: 0, delta: { role: "assistant" } }] };
          }
          yield { ...base(), choices: [{ index: 0, delta: { content: delta.text } }] };
        } else if (delta.type === "input_json_delta") {
          const tool = blockToTool.get(event.index);
          const openaiIndex = tool?.openaiIndex ?? 0;
          yield {
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: openaiIndex, function: { arguments: delta.partial_json } }],
                },
              },
            ],
          };
        }
        break;
      }
      case "content_block_stop":
        // No IR equivalent; tool args are streamed incrementally and finalized by
        // the consumer. Nothing to emit (idempotent close lives on the producer).
        break;
      case "message_delta": {
        finishReason = STOP_REASON_TO_FINISH_STREAM[event.delta.stop_reason] ?? "stop";
        // Anthropic input_tokens is non-cached; carry straight across.
        usage = {
          prompt_tokens: event.usage.input_tokens,
          completion_tokens: event.usage.output_tokens,
          ...(event.usage.cache_read_input_tokens > 0
            ? { cached_tokens: event.usage.cache_read_input_tokens }
            : {}),
        };
        break;
      }
      case "message_stop": {
        yield {
          ...base(),
          choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }],
          ...(usage !== undefined ? { usage } : {}),
        };
        break;
      }
    }
  }
}
