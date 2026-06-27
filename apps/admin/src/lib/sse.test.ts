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

const RESPONSES_STREAM = [
  `event: response.created\ndata: ${JSON.stringify({
    type: 'response.created',
    sequence_number: 0,
    response: { id: 'resp_1', object: 'response', model: 'gpt-5.5', status: 'in_progress' },
  })}\n\n`,
  `event: response.output_item.added\ndata: ${JSON.stringify({
    type: 'response.output_item.added',
    sequence_number: 1,
    output_index: 0,
    item: { type: 'message', id: 'item_0', status: 'in_progress', role: 'assistant' },
  })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    sequence_number: 2,
    item_id: 'item_0',
    output_index: 0,
    content_index: 0,
    delta: '我',
  })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    sequence_number: 3,
    item_id: 'item_0',
    output_index: 0,
    content_index: 0,
    delta: '在',
  })}\n\n`,
  `event: response.output_text.done\ndata: ${JSON.stringify({
    type: 'response.output_text.done',
    sequence_number: 4,
    item_id: 'item_0',
    output_index: 0,
    content_index: 0,
    text: '我在',
  })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    sequence_number: 5,
    response: {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5.5',
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  })}\n\n`,
].join('');

// Codex apply_patch: a short preamble message, then a *custom* (freeform) tool
// call whose body streams as raw text via `custom_tool_call_input.delta` — NOT
// `function_call_arguments`. The 16K document lives in those deltas.
const RESPONSES_CUSTOM_TOOL_STREAM = [
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: 'response.output_text.delta',
    output_index: 0,
    delta: 'Writing the doc now.',
  })}\n\n`,
  `event: response.output_item.added\ndata: ${JSON.stringify({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: '' },
  })}\n\n`,
  `event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({
    type: 'response.custom_tool_call_input.delta',
    item_id: 'ctc_1',
    output_index: 1,
    delta: '*** Begin Patch\n',
  })}\n\n`,
  `event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({
    type: 'response.custom_tool_call_input.delta',
    item_id: 'ctc_1',
    output_index: 1,
    delta: '+the whole document\n',
  })}\n\n`,
  `event: response.custom_tool_call_input.done\ndata: ${JSON.stringify({
    type: 'response.custom_tool_call_input.done',
    item_id: 'ctc_1',
    output_index: 1,
    input: '*** Begin Patch\n+the whole document\n',
  })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: { id: 'resp_2', model: 'gpt-5.5', status: 'completed' },
  })}\n\n`,
].join('');

// Gemini native streaming: bare `data:` lines (no `event:`, no top-level `type`)
// whose payload carries `candidates[].content.parts[]`. Reasoning parts are
// flagged `thought: true`; tool calls are `functionCall` with an *object* `args`;
// usage is the top-level `usageMetadata`; model is `modelVersion`. This is the
// format a Gemini-CLI client speaks end-to-end — the gateway stores it verbatim.
const GEMINI_STREAM = [
  `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'Hello!' }] }, index: 0 }],
    modelVersion: 'gemini-3.5-flash',
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: ' I am Gemini.' }] }, index: 0 }],
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {
      promptTokenCount: 10051,
      candidatesTokenCount: 321,
      totalTokenCount: 10372,
    },
  })}\n\n`,
].join('');

const GEMINI_TOOL_STREAM = [
  `data: ${JSON.stringify({
    candidates: [
      { content: { role: 'model', parts: [{ thought: true, text: 'Need the weather.' }] }, index: 0 },
    ],
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
  })}\n\n`,
].join('');

describe('isSseStream', () => {
  it('detects OpenAI-style data: streams', () => {
    expect(isSseStream(OPENAI_STREAM)).toBe(true);
  });

  it('detects Anthropic-style event: streams', () => {
    expect(isSseStream(ANTHROPIC_STREAM)).toBe(true);
  });

  it('detects OpenAI Responses API event streams', () => {
    expect(isSseStream(RESPONSES_STREAM)).toBe(true);
  });

  it('detects Gemini-native data: streams', () => {
    expect(isSseStream(GEMINI_STREAM)).toBe(true);
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

  it('assembles a streamed refusal as visible content', () => {
    const stream = [
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { refusal: 'I cannot ' } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { refusal: 'do that.' }, finish_reason: 'stop' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.content).toBe('I cannot do that.');
    expect(parsed.assembled.finishReason).toBe('stop'); // finish on the refusal chunk is kept
    expect(parsed.events.map((e) => e.kind)).toEqual(['content', 'content', 'done']);
  });

  it('keeps finish_reason when it rides the same chunk as the final content token', () => {
    const stream = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.content).toBe('Hi!');
    expect(parsed.assembled.finishReason).toBe('stop');
    // The combined chunk still reports as content (content-first), not finish.
    expect(parsed.events.map((e) => e.kind)).toEqual(['content', 'content', 'done']);
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

  it('opens a tool call for server_tool_use blocks so input_json_delta is kept', () => {
    const stream = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"helm"}' },
      })}\n\n`,
    ].join('');
    const parsed2 = parseSseStream(stream);
    expect(parsed2.assembled.toolCalls).toEqual([
      { id: 'srvtoolu_1', name: 'web_search', arguments: '{"query":"helm"}' },
    ]);
  });
});

describe('parseSseStream — OpenAI Responses API events', () => {
  const parsed = parseSseStream(RESPONSES_STREAM);

  it('assembles output_text deltas into the visible final content', () => {
    expect(parsed.assembled.protocol).toBe('openai');
    expect(parsed.assembled.content).toBe('我在');
  });

  it('captures model, usage, completion status and per-event kinds', () => {
    expect(parsed.assembled.model).toBe('gpt-5.5');
    expect(parsed.assembled.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    expect(parsed.assembled.finishReason).toBe('completed');
    expect(parsed.events.map((e) => e.kind)).toEqual([
      'meta',
      'meta',
      'content',
      'content',
      'content',
      'finish',
    ]);
  });
});

describe('parseSseStream — OpenAI Responses custom tool (apply_patch)', () => {
  const parsed = parseSseStream(RESPONSES_CUSTOM_TOOL_STREAM);

  it('keeps the preamble as content and captures the full custom-tool body', () => {
    expect(parsed.assembled.content).toBe('Writing the doc now.');
    expect(parsed.assembled.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'apply_patch',
        arguments: '*** Begin Patch\n+the whole document\n',
      },
    ]);
    expect(parsed.assembled.finishReason).toBe('completed');
  });

  it('classifies the input deltas as tool_call, not meta', () => {
    expect(parsed.events.map((e) => e.kind)).toEqual([
      'content', // preamble
      'tool_call', // output_item.added(custom_tool_call)
      'tool_call', // input.delta
      'tool_call', // input.delta
      'tool_call', // input.done
      'finish',
    ]);
  });
});

describe('parseSseStream — OpenAI Responses refusal + mcp/code tools', () => {
  it('assembles a streamed refusal as visible content (not "No visible output")', () => {
    const stream = [
      `event: response.refusal.delta\ndata: ${JSON.stringify({
        type: 'response.refusal.delta',
        delta: "I can't help ",
      })}\n\n`,
      `event: response.refusal.delta\ndata: ${JSON.stringify({
        type: 'response.refusal.delta',
        delta: 'with that.',
      })}\n\n`,
      `event: response.refusal.done\ndata: ${JSON.stringify({
        type: 'response.refusal.done',
        refusal: "I can't help with that.",
      })}\n\n`,
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.content).toBe("I can't help with that.");
    expect(parsed.events.map((e) => e.kind)).toEqual(['content', 'content', 'content']);
  });

  it('captures mcp_call and code_interpreter tool bodies', () => {
    const stream = [
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'mcp_call', id: 'mcp_1', name: 'search', server_label: 'docs' },
      })}\n\n`,
      `event: response.mcp_call_arguments.delta\ndata: ${JSON.stringify({
        type: 'response.mcp_call_arguments.delta',
        item_id: 'mcp_1',
        delta: '{"q":"helm"}',
      })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'code_interpreter_call', id: 'ci_1' },
      })}\n\n`,
      `event: response.code_interpreter_call_code.delta\ndata: ${JSON.stringify({
        type: 'response.code_interpreter_call_code.delta',
        item_id: 'ci_1',
        delta: 'print(1)',
      })}\n\n`,
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.toolCalls).toEqual([
      { id: 'mcp_1', name: 'search', arguments: '{"q":"helm"}' },
      { id: 'ci_1', name: 'code_interpreter', arguments: 'print(1)' },
    ]);
  });

  it('routes interleaved tool-arg deltas to the right call by item_id', () => {
    // Two function_call items opened back-to-back, THEN their deltas interleave —
    // "append to the last call" would corrupt call A with call B's args.
    const stream = [
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'a' },
      })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'b' },
      })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_a',
        delta: '{"x":1}',
      })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_b',
        delta: '{"y":2}',
      })}\n\n`,
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.toolCalls).toEqual([
      { id: 'call_a', name: 'a', arguments: '{"x":1}' },
      { id: 'call_b', name: 'b', arguments: '{"y":2}' },
    ]);
  });
});

describe('parseSseStream — Gemini native events', () => {
  const parsed = parseSseStream(GEMINI_STREAM);

  it('assembles parts[].text into the visible final content', () => {
    expect(parsed.assembled.protocol).toBe('gemini');
    expect(parsed.assembled.content).toBe('Hello! I am Gemini.');
    expect(parsed.assembled.reasoning).toBe('');
  });

  it('captures finishReason, usageMetadata and modelVersion', () => {
    expect(parsed.assembled.finishReason).toBe('STOP');
    expect(parsed.assembled.usage).toMatchObject({ totalTokenCount: 10372 });
    expect(parsed.assembled.model).toBe('gemini-3.5-flash');
  });

  it('classifies each event for the chunk table', () => {
    expect(parsed.events.map((e) => e.kind)).toEqual(['content', 'content', 'finish']);
    expect(parsed.events[0]?.text).toBe('Hello!');
    expect(parsed.events[2]?.text).toBe('STOP');
  });

  it('separates thought parts as reasoning and serializes functionCall args', () => {
    const tools = parseSseStream(GEMINI_TOOL_STREAM);
    expect(tools.assembled.reasoning).toBe('Need the weather.');
    expect(tools.assembled.content).toBe('');
    expect(tools.assembled.toolCalls).toEqual([
      { id: null, name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(tools.assembled.finishReason).toBe('STOP');
    expect(tools.events.map((e) => e.kind)).toEqual(['reasoning', 'tool_call']);
  });

  it('captures executableCode and codeExecutionResult parts as content', () => {
    const stream = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ executableCode: { language: 'PYTHON', code: 'print(2+2)' } }],
            },
            index: 0,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ codeExecutionResult: { outcome: 'OUTCOME_OK', output: '4' } }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      })}\n\n`,
    ].join('');
    const parsed = parseSseStream(stream);
    expect(parsed.assembled.content).toBe('print(2+2)4');
    expect(parsed.events.map((e) => e.kind)).toEqual(['content', 'content']);
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
