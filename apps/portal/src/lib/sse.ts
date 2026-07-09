// Client-side SSE stream parsing for captured streaming responses.
//
// The payload store keeps streaming bodies verbatim (the raw `data:` wire text —
// immutable source of truth, Principle 7). This module is the *view* layer's pure
// counterpart: it never throws (fail-soft like JsonViewer), recomputes nothing the
// gateway decided, and understands every client protocol the gateway speaks
// (docs/05): OpenAI `chat.completion.chunk`, OpenAI Responses `response.*`,
// Anthropic `event:`-typed messages, and Gemini-native `candidates[].parts[]`
// (a Gemini-CLI client talks this end-to-end; the gateway stores it verbatim).

/** How a single SSE event participates in the stream, for the chunk table. */
export type SseEventKind =
  | "reasoning" // thinking / reasoning_content delta
  | "content" // visible text delta
  | "tool_call" // tool/function call fragment
  | "finish" // finish_reason / stop_reason carrier
  | "meta" // structural event (role opener, message_start, block start/stop, ping)
  | "done" // OpenAI `[DONE]` sentinel
  | "other"; // unparseable or unrecognized — shown as-is, never dropped

export interface SseEvent {
  /** 0-based position in the stream. */
  index: number;
  /** `event:` field when present (Anthropic), else null (OpenAI bare data). */
  event: string | null;
  kind: SseEventKind;
  /** The delta text this event contributed (or finish reason / event label). */
  text: string;
  /** Parsed JSON payload for drill-down; null for [DONE] / unparseable lines. */
  data: unknown;
  /** Raw `data:` field value, always preserved. */
  raw: string;
}

export interface AssembledToolCall {
  id: string | null;
  name: string;
  arguments: string;
}

export interface AssembledStream {
  protocol: "openai" | "anthropic" | "gemini" | "unknown";
  /** Concatenated reasoning/thinking deltas. */
  reasoning: string;
  /** Concatenated visible text deltas — the final answer. */
  content: string;
  toolCalls: AssembledToolCall[];
  finishReason: string | null;
  /** Last-seen usage object, merged across events (Anthropic splits it). */
  usage: Record<string, unknown> | null;
  model: string | null;
}

export interface ParsedSseStream {
  events: SseEvent[];
  assembled: AssembledStream;
}

/** True when a captured body is raw SSE text rather than a JSON document. */
export function isSseStream(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const head = value.trimStart();
  return head.startsWith("data:") || head.startsWith("event:");
}

interface WireEvent {
  event: string | null;
  data: string;
}

/** Split raw SSE text into events per the spec: blank line separates events,
 * multiple `data:` lines within one event join with `\n`. Comment lines (`:`)
 * and unknown fields are ignored. */
function splitWireEvents(raw: string): WireEvent[] {
  const events: WireEvent[] = [];
  let event: string | null = null;
  let data: string[] = [];

  const flush = (): void => {
    if (event !== null || data.length > 0) {
      events.push({ event, data: data.join("\n") });
    }
    event = null;
    data = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue; // SSE comment (e.g. keep-alive)
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
    // other fields (id:, retry:) carry nothing we render — skip
  }
  flush();
  return events;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface Accumulator {
  assembled: AssembledStream;
  // OpenAI chat.completion tool_calls arrive fragmented and keyed by index.
  toolsByIndex: Map<number, AssembledToolCall>;
  // OpenAI Responses tool items are keyed by their `item_id`: a stream can open
  // several tool calls, and their *.delta events interleave — routing by item_id
  // (not "the last opened call") keeps each body with its own call.
  responseToolsById: Map<string, AssembledToolCall>;
}

/** The Responses tool call a `*.delta`/`*.done` event belongs to: by `item_id`
 * when present, else the last-opened call (handles captures lacking item_id). */
function responseTool(
  acc: Accumulator,
  payload: Record<string, unknown>,
): AssembledToolCall | undefined {
  const id = str(payload.item_id);
  const byId = id ? acc.responseToolsById.get(id) : undefined;
  return byId ?? acc.assembled.toolCalls[acc.assembled.toolCalls.length - 1];
}

function mergeUsage(acc: Accumulator, usage: unknown): void {
  const u = asRecord(usage);
  if (!u) return;
  acc.assembled.usage = { ...(acc.assembled.usage ?? {}), ...u };
}

function extractOutputText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";

  const direct = str(record.text);
  if (direct !== null) return direct;

  const content = Array.isArray(record.content) ? record.content : [];
  let out = "";
  for (const part of content) out += extractOutputText(part);

  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) out += extractOutputText(item);

  return out;
}

function fillContentFromFinalText(acc: Accumulator, value: unknown): string {
  const text = extractOutputText(value);
  // Responses API sends both token deltas and authoritative done snapshots. The
  // snapshot is a fallback for truncated captures, not another delta to append.
  if (text && !acc.assembled.content) acc.assembled.content = text;
  return text;
}

/** Classify + accumulate one OpenAI `chat.completion.chunk`. */
function consumeOpenAiChunk(
  chunk: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, "index" | "event" | "data" | "raw"> {
  acc.assembled.protocol = "openai";
  acc.assembled.model ??= str(chunk.model);
  if (chunk.usage) mergeUsage(acc, chunk.usage);

  const choice = asRecord((chunk.choices as unknown[] | undefined)?.[0]);
  const delta = asRecord(choice?.delta) ?? {};
  const finish = str(choice?.finish_reason);
  const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
  const content = str(delta.content);
  const refusal = str(delta.refusal);
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : null;

  // Some providers attach finish_reason to the SAME chunk that carries the final
  // content/refusal/tool token (not a trailing empty chunk). Record it up front so
  // the content-first early returns below never drop the terminal status.
  if (finish) acc.assembled.finishReason = finish;

  if (toolCalls) {
    let label = "";
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall);
      if (!call) continue;
      const idx = typeof call.index === "number" ? call.index : 0;
      const fn = asRecord(call.function) ?? {};
      let merged = acc.toolsByIndex.get(idx);
      if (!merged) {
        merged = { id: null, name: "", arguments: "" };
        acc.toolsByIndex.set(idx, merged);
        acc.assembled.toolCalls.push(merged);
      }
      merged.id ??= str(call.id);
      if (str(fn.name)) merged.name += fn.name as string;
      if (str(fn.arguments)) merged.arguments += fn.arguments as string;
      label += (str(fn.name) ?? "") + (str(fn.arguments) ?? "");
    }
    return { kind: "tool_call", text: label };
  }
  if (reasoning) {
    acc.assembled.reasoning += reasoning;
    return { kind: "reasoning", text: reasoning };
  }
  if (content) {
    acc.assembled.content += content;
    return { kind: "content", text: content };
  }
  if (refusal) {
    // Safety refusal — visible output in place of an answer (mirrors content).
    acc.assembled.content += refusal;
    return { kind: "content", text: refusal };
  }
  if (finish) {
    acc.assembled.finishReason = finish;
    return { kind: "finish", text: finish };
  }
  // role opener / empty keep-alive chunk
  return { kind: "meta", text: str(delta.role) ?? "" };
}

/** Classify + accumulate OpenAI Responses API `response.*` SSE events. */
function consumeOpenAiResponseEvent(
  payload: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, "index" | "event" | "data" | "raw"> {
  acc.assembled.protocol = "openai";
  const type = str(payload.type) ?? "";
  const response = asRecord(payload.response);
  acc.assembled.model ??= str(response?.model);
  if (payload.usage) mergeUsage(acc, payload.usage);
  if (response?.usage) mergeUsage(acc, response.usage);

  switch (type) {
    case "response.output_text.delta": {
      const delta = str(payload.delta) ?? "";
      acc.assembled.content += delta;
      return { kind: "content", text: delta };
    }
    case "response.output_text.done": {
      const text = str(payload.text) ?? "";
      if (text && !acc.assembled.content) acc.assembled.content = text;
      return { kind: "content", text };
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const delta = str(payload.delta) ?? "";
      acc.assembled.reasoning += delta;
      return { kind: "reasoning", text: delta };
    }
    case "response.reasoning_summary_text.done":
    case "response.reasoning_text.done": {
      const text = str(payload.text) ?? "";
      if (text && !acc.assembled.reasoning) acc.assembled.reasoning = text;
      return { kind: "reasoning", text };
    }
    // Refusals are visible output shown in place of an answer — without these a
    // safety-refused turn assembles empty and renders "No visible output".
    case "response.refusal.delta": {
      const delta = str(payload.delta) ?? "";
      acc.assembled.content += delta;
      return { kind: "content", text: delta };
    }
    case "response.refusal.done": {
      const text = str(payload.refusal) ?? "";
      if (text && !acc.assembled.content) acc.assembled.content = text;
      return { kind: "content", text };
    }
    // Tool-input deltas across ALL Responses tool flavors stream the same way:
    // append the delta to the open tool call. function_call = JSON args;
    // custom_tool_call (Codex apply_patch) = freeform text; mcp_call = JSON args;
    // code_interpreter = generated code. Miss any flavor and a 16K tool body is
    // lost as `meta` (the apply_patch bug). output_item.added opened the call.
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
    case "response.mcp_call_arguments.delta":
    case "response.code_interpreter_call_code.delta": {
      const delta = str(payload.delta) ?? "";
      const call = responseTool(acc, payload);
      if (call) call.arguments += delta;
      return { kind: "tool_call", text: delta };
    }
    // Authoritative full-body snapshot — the field name varies per tool flavor.
    case "response.function_call_arguments.done":
    case "response.custom_tool_call_input.done":
    case "response.mcp_call_arguments.done":
    case "response.code_interpreter_call_code.done": {
      const full =
        str(payload.arguments) ?? str(payload.input) ?? str(payload.code) ?? "";
      const call = responseTool(acc, payload);
      if (call && full && !call.arguments) call.arguments = full;
      return { kind: "tool_call", text: full };
    }
    case "response.output_item.added": {
      const item = asRecord(payload.item);
      const itemType = str(item?.type);
      // Every tool-call item type opens a tool call; its body arrives via the
      // *.delta events above. code_interpreter_call carries no `name` → label it.
      if (
        itemType === "function_call" ||
        itemType === "custom_tool_call" ||
        itemType === "mcp_call" ||
        itemType === "code_interpreter_call"
      ) {
        const call: AssembledToolCall = {
          id: str(item?.call_id) ?? str(item?.id),
          name:
            str(item?.name) ??
            (itemType === "code_interpreter_call" ? "code_interpreter" : ""),
          // function_call → `arguments`; custom_tool_call → `input`;
          // code_interpreter_call → `code` (usually empty here, filled by deltas).
          arguments:
            str(item?.arguments) ?? str(item?.input) ?? str(item?.code) ?? "",
        };
        acc.assembled.toolCalls.push(call);
        // Key by item_id so interleaved *.delta events route to the right call.
        const itemId = str(item?.id);
        if (itemId) acc.responseToolsById.set(itemId, call);
        return { kind: "tool_call", text: str(item?.name) ?? itemType };
      }
      return { kind: "meta", text: type };
    }
    case "response.content_part.done": {
      const text = fillContentFromFinalText(acc, payload.part);
      return text ? { kind: "content", text } : { kind: "meta", text: type };
    }
    case "response.output_item.done": {
      const text = fillContentFromFinalText(acc, payload.item);
      return text ? { kind: "content", text } : { kind: "meta", text: type };
    }
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      fillContentFromFinalText(acc, response);
      acc.assembled.finishReason =
        str(response?.status) ?? type.replace("response.", "");
      return { kind: "finish", text: acc.assembled.finishReason };
    }
    default:
      return { kind: "meta", text: type };
  }
}

/** Classify + accumulate one Anthropic stream event (by its `type`). */
function consumeAnthropicEvent(
  payload: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, "index" | "event" | "data" | "raw"> {
  acc.assembled.protocol = "anthropic";
  const type = str(payload.type) ?? "";

  switch (type) {
    case "message_start": {
      const message = asRecord(payload.message);
      acc.assembled.model ??= str(message?.model);
      if (message?.usage) mergeUsage(acc, message.usage);
      return { kind: "meta", text: type };
    }
    case "content_block_delta": {
      const delta = asRecord(payload.delta) ?? {};
      const thinking = str(delta.thinking);
      const text = str(delta.text);
      const partialJson = str(delta.partial_json);
      if (thinking !== null) {
        acc.assembled.reasoning += thinking;
        return { kind: "reasoning", text: thinking };
      }
      if (text !== null) {
        acc.assembled.content += text;
        return { kind: "content", text };
      }
      if (partialJson !== null) {
        // input_json_delta — append to the latest tool call
        const last =
          acc.assembled.toolCalls[acc.assembled.toolCalls.length - 1];
        if (last) last.arguments += partialJson;
        return { kind: "tool_call", text: partialJson };
      }
      return { kind: "other", text: str(delta.type) ?? type };
    }
    case "content_block_start": {
      const block = asRecord(payload.content_block);
      const blockType = str(block?.type);
      // `tool_use` = client tool; `server_tool_use` = Anthropic-run tool (native
      // web_search/code-execution). Both stream args via input_json_delta below,
      // which appends to the last tool call — so both must open one here or the
      // args vanish.
      if (blockType === "tool_use" || blockType === "server_tool_use") {
        acc.assembled.toolCalls.push({
          id: str(block?.id),
          name: str(block?.name) ?? "",
          arguments: "",
        });
        return { kind: "tool_call", text: str(block?.name) ?? "" };
      }
      return { kind: "meta", text: type };
    }
    case "message_delta": {
      if (payload.usage) mergeUsage(acc, payload.usage);
      const stop = str(asRecord(payload.delta)?.stop_reason);
      if (stop) {
        acc.assembled.finishReason = stop;
        return { kind: "finish", text: stop };
      }
      return { kind: "meta", text: type };
    }
    case "content_block_stop":
    case "message_stop":
    case "ping":
      return { kind: "meta", text: type };
    case "error":
      return { kind: "other", text: JSON.stringify(payload.error ?? payload) };
    default:
      return { kind: "other", text: type };
  }
}

/** Classify + accumulate one Gemini-native streamGenerateContent chunk.
 * Gemini chunks carry no `type`/`event:` field — they are bare `data:` JSON with
 * a `candidates[]` array whose `content.parts[]` hold text (`thought: true` marks
 * reasoning), `functionCall` tool calls (args is an *object*, not a string), and
 * the candidate's `finishReason`; usage is the top-level `usageMetadata`. */
function consumeGeminiEvent(
  payload: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, "index" | "event" | "data" | "raw"> {
  acc.assembled.protocol = "gemini";
  acc.assembled.model ??= str(payload.modelVersion);
  if (payload.usageMetadata) mergeUsage(acc, payload.usageMetadata);

  const candidate = asRecord(
    (payload.candidates as unknown[] | undefined)?.[0],
  );
  const parts = Array.isArray(asRecord(candidate?.content)?.parts)
    ? (asRecord(candidate?.content)?.parts as unknown[])
    : [];

  // A chunk can carry several parts; accumulate all, then report the highest-
  // priority kind for the chunk table (tool_call > reasoning > content).
  let kind: SseEventKind | null = null;
  let label = "";
  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (!part) continue;
    const fnCall = asRecord(part.functionCall);
    // Gemini code execution: the model-written code and its run output ride as
    // dedicated parts (not `text`) — without these a code-exec turn loses them.
    const execCode = asRecord(part.executableCode);
    const execResult = asRecord(part.codeExecutionResult);
    const text = str(part.text);
    if (fnCall) {
      const args = fnCall.args;
      const call: AssembledToolCall = {
        id: null,
        name: str(fnCall.name) ?? "",
        arguments: args === undefined ? "" : JSON.stringify(args),
      };
      acc.assembled.toolCalls.push(call);
      kind = "tool_call";
      label = call.name;
    } else if (execCode || execResult) {
      const code = str(execCode?.code) ?? str(execResult?.output) ?? "";
      acc.assembled.content += code;
      if (kind === null) kind = "content";
      if (kind === "content") label = code;
    } else if (part.thought === true && text !== null) {
      acc.assembled.reasoning += text;
      if (kind !== "tool_call") kind = "reasoning";
      if (kind === "reasoning") label = text;
    } else if (text !== null) {
      acc.assembled.content += text;
      if (kind === null) kind = "content";
      if (kind === "content") label = text;
    }
  }

  const finish = str(candidate?.finishReason);
  if (finish) acc.assembled.finishReason = finish;

  if (kind) return { kind, text: label };
  if (finish) return { kind: "finish", text: finish };
  return { kind: "meta", text: "" };
}

/** Parse a raw SSE body into classified events + the assembled final message.
 * Never throws: broken lines become `other` events and assembly continues. */
export function parseSseStream(raw: string): ParsedSseStream {
  const acc: Accumulator = {
    assembled: {
      protocol: "unknown",
      reasoning: "",
      content: "",
      toolCalls: [],
      finishReason: null,
      usage: null,
      model: null,
    },
    toolsByIndex: new Map(),
    responseToolsById: new Map(),
  };

  const events: SseEvent[] = [];
  for (const wire of splitWireEvents(raw)) {
    const base = { index: events.length, event: wire.event, raw: wire.data };
    if (wire.data === "[DONE]") {
      events.push({ ...base, kind: "done", text: "[DONE]", data: null });
      continue;
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(wire.data));
    } catch {
      // fall through — kept as 'other' below
    }
    if (!payload) {
      events.push({ ...base, kind: "other", text: wire.data, data: null });
      continue;
    }
    // OpenAI Responses API events and Anthropic events both carry `event:` /
    // `type`; route `response.*` first so Responses streams do not get mistaken
    // for Anthropic and render as "No visible output".
    const type = str(payload.type);
    const isResponsesEvent =
      type?.startsWith("response.") || wire.event?.startsWith("response.");
    // Gemini native: bare `data:` JSON (no `type`, no `event:`) with a
    // `candidates[]` array — route before the OpenAI fallback, which would find
    // no `choices` and render "No visible output".
    const isGeminiEvent =
      type === null && wire.event === null && Array.isArray(payload.candidates);
    const consumed = isResponsesEvent
      ? consumeOpenAiResponseEvent(payload, acc)
      : isGeminiEvent
        ? consumeGeminiEvent(payload, acc)
        : typeof payload.type === "string" || wire.event !== null
          ? consumeAnthropicEvent(payload, acc)
          : consumeOpenAiChunk(payload, acc);
    events.push({ ...base, ...consumed, data: payload });
  }

  return { events, assembled: acc.assembled };
}
