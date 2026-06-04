// Client-side SSE stream parsing for captured streaming responses.
//
// The payload store keeps streaming bodies verbatim (the raw `data:` wire text —
// immutable source of truth, Principle 7). This module is the *view* layer's pure
// counterpart: it never throws (fail-soft like JsonViewer), recomputes nothing the
// gateway decided, and understands both client protocols the gateway speaks
// (docs/05): OpenAI `chat.completion.chunk` and Anthropic `event:`-typed messages.

/** How a single SSE event participates in the stream, for the chunk table. */
export type SseEventKind =
  | 'reasoning' // thinking / reasoning_content delta
  | 'content' // visible text delta
  | 'tool_call' // tool/function call fragment
  | 'finish' // finish_reason / stop_reason carrier
  | 'meta' // structural event (role opener, message_start, block start/stop, ping)
  | 'done' // OpenAI `[DONE]` sentinel
  | 'other'; // unparseable or unrecognized — shown as-is, never dropped

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
  protocol: 'openai' | 'anthropic' | 'unknown';
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
  if (typeof value !== 'string') return false;
  const head = value.trimStart();
  return head.startsWith('data:') || head.startsWith('event:');
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
      events.push({ event, data: data.join('\n') });
    }
    event = null;
    data = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment (e.g. keep-alive)
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trimStart();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
    // other fields (id:, retry:) carry nothing we render — skip
  }
  flush();
  return events;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface Accumulator {
  assembled: AssembledStream;
  // OpenAI tool_calls arrive fragmented and keyed by index.
  toolsByIndex: Map<number, AssembledToolCall>;
}

function mergeUsage(acc: Accumulator, usage: unknown): void {
  const u = asRecord(usage);
  if (!u) return;
  acc.assembled.usage = { ...(acc.assembled.usage ?? {}), ...u };
}

/** Classify + accumulate one OpenAI `chat.completion.chunk`. */
function consumeOpenAiChunk(
  chunk: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, 'index' | 'event' | 'data' | 'raw'> {
  acc.assembled.protocol = 'openai';
  acc.assembled.model ??= str(chunk.model);
  if (chunk.usage) mergeUsage(acc, chunk.usage);

  const choice = asRecord((chunk.choices as unknown[] | undefined)?.[0]);
  const delta = asRecord(choice?.delta) ?? {};
  const finish = str(choice?.finish_reason);
  const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
  const content = str(delta.content);
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : null;

  if (toolCalls) {
    let label = '';
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall);
      if (!call) continue;
      const idx = typeof call.index === 'number' ? call.index : 0;
      const fn = asRecord(call.function) ?? {};
      let merged = acc.toolsByIndex.get(idx);
      if (!merged) {
        merged = { id: null, name: '', arguments: '' };
        acc.toolsByIndex.set(idx, merged);
        acc.assembled.toolCalls.push(merged);
      }
      merged.id ??= str(call.id);
      if (str(fn.name)) merged.name += fn.name as string;
      if (str(fn.arguments)) merged.arguments += fn.arguments as string;
      label += (str(fn.name) ?? '') + (str(fn.arguments) ?? '');
    }
    return { kind: 'tool_call', text: label };
  }
  if (reasoning) {
    acc.assembled.reasoning += reasoning;
    return { kind: 'reasoning', text: reasoning };
  }
  if (content) {
    acc.assembled.content += content;
    return { kind: 'content', text: content };
  }
  if (finish) {
    acc.assembled.finishReason = finish;
    return { kind: 'finish', text: finish };
  }
  // role opener / empty keep-alive chunk
  return { kind: 'meta', text: str(delta.role) ?? '' };
}

/** Classify + accumulate one Anthropic stream event (by its `type`). */
function consumeAnthropicEvent(
  payload: Record<string, unknown>,
  acc: Accumulator,
): Omit<SseEvent, 'index' | 'event' | 'data' | 'raw'> {
  acc.assembled.protocol = 'anthropic';
  const type = str(payload.type) ?? '';

  switch (type) {
    case 'message_start': {
      const message = asRecord(payload.message);
      acc.assembled.model ??= str(message?.model);
      if (message?.usage) mergeUsage(acc, message.usage);
      return { kind: 'meta', text: type };
    }
    case 'content_block_delta': {
      const delta = asRecord(payload.delta) ?? {};
      const thinking = str(delta.thinking);
      const text = str(delta.text);
      const partialJson = str(delta.partial_json);
      if (thinking !== null) {
        acc.assembled.reasoning += thinking;
        return { kind: 'reasoning', text: thinking };
      }
      if (text !== null) {
        acc.assembled.content += text;
        return { kind: 'content', text };
      }
      if (partialJson !== null) {
        // input_json_delta — append to the latest tool call
        const last = acc.assembled.toolCalls[acc.assembled.toolCalls.length - 1];
        if (last) last.arguments += partialJson;
        return { kind: 'tool_call', text: partialJson };
      }
      return { kind: 'other', text: str(delta.type) ?? type };
    }
    case 'content_block_start': {
      const block = asRecord(payload.content_block);
      if (str(block?.type) === 'tool_use') {
        acc.assembled.toolCalls.push({
          id: str(block?.id),
          name: str(block?.name) ?? '',
          arguments: '',
        });
        return { kind: 'tool_call', text: str(block?.name) ?? '' };
      }
      return { kind: 'meta', text: type };
    }
    case 'message_delta': {
      if (payload.usage) mergeUsage(acc, payload.usage);
      const stop = str(asRecord(payload.delta)?.stop_reason);
      if (stop) {
        acc.assembled.finishReason = stop;
        return { kind: 'finish', text: stop };
      }
      return { kind: 'meta', text: type };
    }
    case 'content_block_stop':
    case 'message_stop':
    case 'ping':
      return { kind: 'meta', text: type };
    case 'error':
      return { kind: 'other', text: JSON.stringify(payload.error ?? payload) };
    default:
      return { kind: 'other', text: type };
  }
}

/** Parse a raw SSE body into classified events + the assembled final message.
 * Never throws: broken lines become `other` events and assembly continues. */
export function parseSseStream(raw: string): ParsedSseStream {
  const acc: Accumulator = {
    assembled: {
      protocol: 'unknown',
      reasoning: '',
      content: '',
      toolCalls: [],
      finishReason: null,
      usage: null,
      model: null,
    },
    toolsByIndex: new Map(),
  };

  const events: SseEvent[] = [];
  for (const wire of splitWireEvents(raw)) {
    const base = { index: events.length, event: wire.event, raw: wire.data };
    if (wire.data === '[DONE]') {
      events.push({ ...base, kind: 'done', text: '[DONE]', data: null });
      continue;
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(wire.data));
    } catch {
      // fall through — kept as 'other' below
    }
    if (!payload) {
      events.push({ ...base, kind: 'other', text: wire.data, data: null });
      continue;
    }
    // Anthropic events carry a `type` discriminator (or an `event:` field);
    // OpenAI chunks carry `choices`. Prefer the explicit discriminator.
    const consumed =
      typeof payload.type === 'string' || wire.event !== null
        ? consumeAnthropicEvent(payload, acc)
        : consumeOpenAiChunk(payload, acc);
    events.push({ ...base, ...consumed, data: payload });
  }

  return { events, assembled: acc.assembled };
}
