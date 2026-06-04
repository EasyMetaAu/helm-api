import { describe, expect, it } from 'vitest';
import { isSseStream, parseSseStream } from './sse.js';

// Captured streaming responses are stored verbatim as raw SSE text (the storage
// layer keeps the immutable wire format — Principle 7). These tests pin the
// client-side parser that turns that wall of `data:` lines into (a) a per-event
// breakdown and (b) the assembled final message. Both client protocols the
// gateway speaks (docs/05) must round-trip: OpenAI `chat.completion.chunk` and
// Anthropic `event:`-typed messages. Streaming is the #1 risk (CLAUDE.md §8),
// so edge cases (split tool_call args, [DONE], unparseable lines) get cases.

function openaiChunk(delta: Record<string, unknown>, extra?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1780000000,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null, ...extra }],
    usage: null,
  })}\n\n`;
}

const OPENAI_STREAM = [
  openaiChunk({ role: 'assistant', content: null, reasoning_content: '' }),
  openaiChunk({ content: null, reasoning_content: 'We need' }),
  openaiChunk({ content: null, reasoning_content: ' to greet.' }),
  openaiChunk({ content: 'Hi', reasoning_content: null }),
  openaiChunk({ content: '!', reasoning_content: null }),
  `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1780000000,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 6, completion_tokens: 54, total_tokens: 60 },
  })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const OPENAI_TOOL_STREAM = [
  openaiChunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
    ],
  }),
  openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
  openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
  `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1780000000,
    model: 'gpt-x',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: null,
  })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'User wants a greeting.' },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Hello' },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: ' there!' },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 9 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('');

describe('isSseStream', () => {
  it('detects OpenAI-style data: streams', () => {
    expect(isSseStream(OPENAI_STREAM)).toBe(true);
  });

  it('detects Anthropic-style event: streams', () => {
    expect(isSseStream(ANTHROPIC_STREAM)).toBe(true);
  });

  it('rejects plain JSON bodies, objects, and unrelated strings', () => {
    expect(isSseStream('{"id":"cmpl-1","choices":[]}')).toBe(false);
    expect(isSseStream({ id: 'cmpl-1' })).toBe(false);
    expect(isSseStream('hello world')).toBe(false);
    expect(isSseStream(null)).toBe(false);
    expect(isSseStream('')).toBe(false);
  });
});

describe('parseSseStream — OpenAI chat.completion.chunk', () => {
  const parsed = parseSseStream(OPENAI_STREAM);

  it('assembles reasoning and content separately', () => {
    expect(parsed.assembled.reasoning).toBe('We need to greet.');
    expect(parsed.assembled.content).toBe('Hi!');
  });

  it('captures finish_reason, usage, model and chunk count', () => {
    expect(parsed.assembled.finishReason).toBe('stop');
    expect(parsed.assembled.usage).toMatchObject({ total_tokens: 60 });
    expect(parsed.assembled.model).toBe('deepseek-v4-flash');
    // 6 data chunks + [DONE]
    expect(parsed.events).toHaveLength(7);
  });

  it('classifies each event for the chunk table', () => {
    const kinds = parsed.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'meta', // role-only opener
      'reasoning',
      'reasoning',
      'content',
      'content',
      'finish',
      'done',
    ]);
    expect(parsed.events[1]?.text).toBe('We need');
    expect(parsed.events[3]?.text).toBe('Hi');
    expect(parsed.events[5]?.text).toBe('stop');
  });

  it('merges fragmented tool_call deltas by index', () => {
    const tools = parseSseStream(OPENAI_TOOL_STREAM);
    expect(tools.assembled.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(tools.assembled.finishReason).toBe('tool_calls');
    expect(tools.events[0]?.kind).toBe('tool_call');
  });
});

describe('parseSseStream — Anthropic events', () => {
  const parsed = parseSseStream(ANTHROPIC_STREAM);

  it('assembles thinking and text blocks separately', () => {
    expect(parsed.assembled.reasoning).toBe('User wants a greeting.');
    expect(parsed.assembled.content).toBe('Hello there!');
  });

  it('captures stop_reason, merged usage and model', () => {
    expect(parsed.assembled.finishReason).toBe('end_turn');
    expect(parsed.assembled.usage).toMatchObject({ input_tokens: 12, output_tokens: 9 });
    expect(parsed.assembled.model).toBe('claude-sonnet-4-6');
  });

  it('classifies thinking vs text deltas', () => {
    const kinds = parsed.events.map((e) => e.kind);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('content');
    expect(kinds[kinds.length - 2]).toBe('finish'); // message_delta w/ stop_reason
  });
});

describe('parseSseStream — resilience (fail-soft, never throw)', () => {
  it('keeps unparseable data lines as "other" events instead of throwing', () => {
    const parsed = parseSseStream('data: {broken json\n\ndata: [DONE]\n\n');
    expect(parsed.events[0]?.kind).toBe('other');
    expect(parsed.events[1]?.kind).toBe('done');
    expect(parsed.assembled.content).toBe('');
  });

  it('handles an empty string', () => {
    const parsed = parseSseStream('');
    expect(parsed.events).toHaveLength(0);
    expect(parsed.assembled.content).toBe('');
    expect(parsed.assembled.reasoning).toBe('');
    expect(parsed.assembled.toolCalls).toEqual([]);
  });

  it('handles multi-line data fields per the SSE spec (data: a\\ndata: b)', () => {
    const chunk = { choices: [{ index: 0, delta: { content: 'ok' } }] };
    const json = JSON.stringify(chunk, null, 1); // multi-line JSON
    const wire = `${json
      .split('\n')
      .map((l) => `data: ${l}`)
      .join('\n')}\n\n`;
    const parsed = parseSseStream(wire);
    expect(parsed.assembled.content).toBe('ok');
  });
});
