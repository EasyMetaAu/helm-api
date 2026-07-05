import { describe, expect, it } from 'vitest';
import { detectProtocol, extractConversation, type ConversationTurn } from './conversation.js';

// The normalizer folds a captured request body (one of four native wire protocols)
// plus its response (parsed JSON, or a raw SSE string for streamed calls) into an
// ordered ConversationTurn[]. It powers the admin "chat" view of a request. Like
// sse.ts / imageData.ts it is PURE and FAIL-SOFT: a malformed/partial/unknown body
// must yield a best-effort partial (or []) and NEVER throw — a bad payload can never
// blank the detail page. These tests pin structural output (roles, order, part kinds,
// tool-id pairing, image-not-as-text, reasoning-separated) — not rendered markup.

// A base64 PNG long enough to pass imageData's MIN_BASE64_LEN sniff (iVBORw0KGgo…).
const PNG_B64 = `iVBORw0KGgo${'A'.repeat(40)}`;
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// Reused verbatim from sse.test.ts — the response side is folded via parseSseStream.
const OPENAI_STREAM = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', role: 'assistant' } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think.' } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello there!' } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('');

const RESPONSES_STREAM = [
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'item_0', delta: '我在' })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', status: 'completed' } })}\n\n`,
].join('');

const GEMINI_STREAM = [
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello! I am Gemini.' }] } }], modelVersion: 'gemini-3.5-flash' })}\n\n`,
].join('');

const GEMINI_TOOL_STREAM = [
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }] })}\n\n`,
].join('');

// ── helpers ────────────────────────────────────────────────────────────────
function kinds(turn: ConversationTurn): string[] {
  return turn.parts.map((p) => p.kind);
}
function firstText(turn: ConversationTurn): string | undefined {
  const p = turn.parts.find((x) => x.kind === 'text');
  return p?.kind === 'text' ? p.text : undefined;
}
function findPart(turns: ConversationTurn[], kind: string): ConversationTurn['parts'][number] | undefined {
  for (const t of turns) for (const p of t.parts) if (p.kind === kind) return p;
  return undefined;
}
/** No text part may contain a raw base64 image wall (C6/C2 guard). */
function noBase64InText(turns: ConversationTurn[]): boolean {
  for (const t of turns)
    for (const p of t.parts)
      if (p.kind === 'text' && (p.text.includes(PNG_B64) || p.text.length > 5000 && /^[A-Za-z0-9+/]+=*$/.test(p.text.trim())))
        return false;
  return true;
}

// ── protocol detection ──────────────────────────────────────────────────────
describe('detectProtocol', () => {
  it('anthropic: messages[] + top-level system', () => {
    expect(detectProtocol({ system: 'be precise', messages: [{ role: 'user', content: 'hi' }] })).toBe('anthropic');
  });
  it('anthropic: messages[] with tool_use/tool_result blocks', () => {
    expect(
      detectProtocol({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] }] }),
    ).toBe('anthropic');
  });
  it('openai-chat: messages[] + tool_calls / role:tool', () => {
    expect(
      detectProtocol({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }] }),
    ).toBe('openai-chat');
  });
  it('openai-chat: plain messages[] with string content', () => {
    expect(detectProtocol({ messages: [{ role: 'user', content: 'hi' }] })).toBe('openai-chat');
  });
  it('responses: input / instructions', () => {
    expect(detectProtocol({ instructions: 'sys', input: 'hi' })).toBe('responses');
    expect(detectProtocol({ input: [{ type: 'message', role: 'user', content: 'hi' }] })).toBe('responses');
  });
  it('gemini: contents[] / systemInstruction', () => {
    expect(detectProtocol({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })).toBe('gemini');
  });
  it('unknown shape → unknown', () => {
    expect(detectProtocol({ foo: 1 })).toBe('unknown');
    expect(detectProtocol(null)).toBe('unknown');
    expect(detectProtocol(42)).toBe('unknown');
  });
  it('ambiguity: messages + contents picks a deterministic winner (anthropic/openai over gemini)', () => {
    // Pin the documented precedence so it is not order-dependent.
    const p = detectProtocol({ messages: [{ role: 'user', content: 'hi' }], contents: [] });
    expect(p).toBe('openai-chat');
  });
});

// ── per-protocol folding (same invariant matrix each) ────────────────────────
describe('extractConversation — OpenAI Chat', () => {
  it('C1 string content → one user text turn', () => {
    const turns = extractConversation({ messages: [{ role: 'user', content: 'hi' }] }, null);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(firstText(turns[0])).toBe('hi');
    expect(turns[0].raw).toEqual({ role: 'user', content: 'hi' });
    expect(turns[0].origin).toBe('request');
  });
  it('C2 parts-array content (text+image) → ordered parts, image not base64 text', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_DATA_URL } }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['text', 'image']);
    expect(noBase64InText(turns)).toBe(true);
  });
  it('C2b http(s) image URL renders as an image part, not "unknown"', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }] }] },
      null,
    );
    const img = turns[0].parts[0];
    expect(img.kind).toBe('image');
    expect(img.kind === 'image' && img.url).toBe('https://example.com/cat.png');
  });
  it('C3 leading system message → first turn role system', () => {
    const turns = extractConversation(
      { messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: 'hi' }] },
      null,
    );
    expect(turns[0].role).toBe('system');
    expect(turns[1].role).toBe('user');
  });
  it('C4 tool_call paired to role:tool result by tool_call_id', () => {
    const turns = extractConversation(
      {
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_weather', arguments: '{"c":"P"}' } }] },
          { role: 'tool', tool_call_id: 'call_0', content: '18C' },
        ],
      },
      null,
    );
    // call + result fold into ONE tool_exchange on the call's turn (result consumed)
    const ex = findPart(turns, 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.id).toBe('call_0');
    expect(ex?.kind === 'tool_exchange' && ex.name).toBe('get_weather');
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(true);
    expect(ex?.kind === 'tool_exchange' && ex.output).toBe('18C');
    // args carried un-stringified (raw string here — normalizer must not parse)
    expect(ex?.kind === 'tool_exchange' && ex.args).toBe('{"c":"P"}');
    // the standalone tool_result turn was consumed → not double-rendered
    expect(findPart(turns, 'tool_result')).toBeUndefined();
  });
  it('C4b lone role:tool result with no matching call stays an orphan tool_result (not dropped)', () => {
    const turns = extractConversation(
      { messages: [{ role: 'tool', tool_call_id: 'call_0', content: '18C' }] },
      null,
    );
    // exactly one part — the orphan tool_result — never a duplicate text bubble
    expect(kinds(turns[0])).toEqual(['tool_result']);
    const r = turns[0].parts[0];
    expect(r.kind === 'tool_result' && r.output).toBe('18C');
  });
  it('C5 multiple tool_calls each become a tool_exchange (no result → hasResult false)', () => {
    const turns = extractConversation(
      {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'a', function: { name: 'f1', arguments: '{}' } },
              { id: 'b', function: { name: 'f2', arguments: '{}' } },
            ],
          },
        ],
      },
      null,
    );
    const exchanges = turns[0].parts.filter((p) => p.kind === 'tool_exchange');
    expect(exchanges).toHaveLength(2);
    expect(exchanges.every((p) => p.kind === 'tool_exchange' && !p.hasResult)).toBe(true);
  });
  it('C8 streamed response folded as final assistant turn', () => {
    const turns = extractConversation({ messages: [{ role: 'user', content: 'hi' }] }, OPENAI_STREAM);
    const last = turns[turns.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.origin).toBe('response');
    expect(firstText(last)).toBe('Hi!');
  });
  it('C9 non-stream JSON response → final assistant from choices[0].message', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: 'hi' }] },
      { choices: [{ message: { role: 'assistant', content: 'Hello' } }] },
    );
    const last = turns[turns.length - 1];
    expect(last.role).toBe('assistant');
    expect(firstText(last)).toBe('Hello');
  });
});

describe('extractConversation — Anthropic', () => {
  it('C3 top-level system string → leading system turn', () => {
    const turns = extractConversation({ system: 'Be precise.', messages: [{ role: 'user', content: 'hi' }] }, null);
    expect(turns[0].role).toBe('system');
    expect(firstText(turns[0])).toBe('Be precise.');
  });
  it('C2 user text+image blocks', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['text', 'image']);
    expect(noBase64InText(turns)).toBe(true);
  });
  it('C4 tool_use in assistant paired to tool_result in user by id', () => {
    const turns = extractConversation(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
        ],
      },
      null,
    );
    const ex = findPart(turns, 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.id).toBe('toolu_1');
    expect(ex?.kind === 'tool_exchange' && ex.name).toBe('search');
    expect(ex?.kind === 'tool_exchange' && ex.args).toEqual({ q: 'x' }); // object kept as object
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(true);
    expect(ex?.kind === 'tool_exchange' && ex.output).toBe('done');
    expect(findPart(turns, 'tool_result')).toBeUndefined(); // folded into the exchange
  });
  it('C7 thinking block → reasoning part, separate from text', () => {
    const turns = extractConversation(
      { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['reasoning', 'text']);
  });
  it('C8 streamed anthropic response folds thinking + text', () => {
    const turns = extractConversation({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, ANTHROPIC_STREAM);
    const last = turns[turns.length - 1];
    expect(last.role).toBe('assistant');
    expect(firstText(last)).toBe('Hello there!');
    expect(last.parts.some((p) => p.kind === 'reasoning')).toBe(true);
  });
  it('C9 non-stream anthropic response object', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' },
    );
    expect(firstText(turns[turns.length - 1])).toBe('Hello');
  });
});

describe('extractConversation — OpenAI Responses', () => {
  it('C1 string input → single user turn', () => {
    const turns = extractConversation({ input: 'plain string' }, null);
    expect(turns[0].role).toBe('user');
    expect(firstText(turns[0])).toBe('plain string');
  });
  it('C3 instructions → leading system turn', () => {
    const turns = extractConversation({ instructions: 'sys', input: [{ type: 'message', role: 'user', content: 'hi' }] }, null);
    expect(turns[0].role).toBe('system');
    expect(firstText(turns[0])).toBe('sys');
  });
  it('C4 function_call paired to function_call_output by call_id', () => {
    const turns = extractConversation(
      {
        input: [
          { type: 'function_call', call_id: 'fc_1', name: 'lookup', arguments: '{"x":1}' },
          { type: 'function_call_output', call_id: 'fc_1', output: 'ok' },
        ],
      },
      null,
    );
    const ex = findPart(turns, 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.id).toBe('fc_1');
    expect(ex?.kind === 'tool_exchange' && ex.name).toBe('lookup');
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(true);
    expect(ex?.kind === 'tool_exchange' && ex.output).toBe('ok');
  });
  it('C7 reasoning item → reasoning part', () => {
    const turns = extractConversation(
      { input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'because' }] }, { type: 'message', role: 'user', content: 'hi' }] },
      null,
    );
    expect(findPart(turns, 'reasoning')).toBeDefined();
  });
  it('C8 streamed responses folded', () => {
    const turns = extractConversation({ input: 'hi' }, RESPONSES_STREAM);
    expect(firstText(turns[turns.length - 1])).toBe('我在');
  });
  it('C9 non-stream responses object (output[])', () => {
    const turns = extractConversation(
      { input: 'hi' },
      { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], status: 'completed' },
    );
    expect(firstText(turns[turns.length - 1])).toBe('done');
  });
});

describe('extractConversation — Gemini', () => {
  it('C3 systemInstruction → leading system turn; role model→assistant', () => {
    const turns = extractConversation(
      { systemInstruction: { parts: [{ text: 'sys' }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'yo' }] }] },
      null,
    );
    expect(turns[0].role).toBe('system');
    expect(turns[1].role).toBe('user');
    expect(turns[2].role).toBe('assistant');
  });
  it('C2 inlineData image part not base64 text', () => {
    const turns = extractConversation(
      { contents: [{ role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['text', 'image']);
    expect(noBase64InText(turns)).toBe(true);
  });
  it('C4 functionCall paired to functionResponse by name+ordinal (no id)', () => {
    const turns = extractConversation(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 18 } } }] },
        ],
      },
      null,
    );
    // Gemini has no call id — paired by synthesized name#ordinal into one exchange
    const ex = findPart(turns, 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.name).toBe('get_weather');
    expect(ex?.kind === 'tool_exchange' && ex.args).toEqual({ city: 'Paris' });
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(true);
    expect(ex?.kind === 'tool_exchange' && ex.output).toEqual({ temp: 18 });
  });
  it('C7 thought:true part → reasoning', () => {
    const turns = extractConversation(
      { contents: [{ role: 'model', parts: [{ thought: true, text: 'hmm' }, { text: 'answer' }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['reasoning', 'text']);
  });
  it('C8 streamed gemini folded', () => {
    const turns = extractConversation({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, GEMINI_STREAM);
    expect(firstText(turns[turns.length - 1])).toBe('Hello! I am Gemini.');
  });
  it('C8b streamed gemini tool args are folded back to an object, not a JSON string', () => {
    const turns = extractConversation({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, GEMINI_TOOL_STREAM);
    // streamed response tool call → tool_exchange with no result
    const ex = findPart(turns, 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.args).toEqual({ city: 'Paris' });
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(false);
  });
  it('C9 non-stream gemini object (candidates[])', () => {
    const turns = extractConversation(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] },
    );
    expect(firstText(turns[turns.length - 1])).toBe('done');
  });
});

// ── ordering (C10) ───────────────────────────────────────────────────────────
describe('ordering', () => {
  it('C10 preserves message order, response appended last', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] },
      { choices: [{ message: { role: 'assistant', content: 'd' } }] },
    );
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.map(firstText)).toEqual(['a', 'b', 'c', 'd']);
    expect(turns[turns.length - 1].origin).toBe('response');
  });
});

// ── fail-soft resilience (never blank/crash the page) ────────────────────────
describe('resilience — never throws', () => {
  it('C11 empty / nullish → []', () => {
    expect(extractConversation(undefined, undefined)).toEqual([]);
    expect(extractConversation(null, null)).toEqual([]);
    expect(extractConversation({}, {})).toEqual([]);
  });
  it('garbage scalars → [] without throwing', () => {
    expect(() => extractConversation(42, 'nope')).not.toThrow();
    expect(extractConversation(42, 'nope')).toEqual([]);
    expect(() => extractConversation('', '')).not.toThrow();
  });
  it('unknown protocol object → []', () => {
    expect(extractConversation({ foo: 'bar' }, null)).toEqual([]);
  });
  it('C12 malformed turn (missing role/content) → best-effort, other turns kept, no throw', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: 'ok' }, { garbage: true }, null, { role: 'assistant', content: 'fine' }] },
      null,
    );
    // the two good turns survive
    expect(turns.some((t) => firstText(t) === 'ok')).toBe(true);
    expect(turns.some((t) => firstText(t) === 'fine')).toBe(true);
  });
  it('malformed SSE response string → assistant turn appears, no throw', () => {
    expect(() => extractConversation({ messages: [{ role: 'user', content: 'hi' }] }, 'data: {broken json')).not.toThrow();
  });
  it('partial capture: request present, response undefined → request turns only, no fabricated assistant', () => {
    const turns = extractConversation({ messages: [{ role: 'user', content: 'hi' }] }, undefined);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
  });
  it('a single message with a pathologically huge content array is bounded (no hang)', () => {
    const parts = Array.from({ length: 5000 }, () => ({ type: 'text', text: 'x' }));
    const turns = extractConversation({ messages: [{ role: 'user', content: parts }] }, null);
    // capped at MAX_PARTS (2000) — never renders all 5000
    expect(turns[0].parts.length).toBeLessThanOrEqual(2000);
  });
  it('a message with thousands of tool_calls is bounded (MAX_PARTS)', () => {
    const tool_calls = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, function: { name: 'f', arguments: '{}' } }));
    const turns = extractConversation({ messages: [{ role: 'assistant', content: null, tool_calls }] }, null);
    expect(turns[0].parts.length).toBeLessThanOrEqual(2000);
  });
  it('a turn with huge content AND huge tool_calls is bounded to MAX_PARTS total', () => {
    const content = Array.from({ length: 3000 }, () => ({ type: 'text', text: 'x' }));
    const tool_calls = Array.from({ length: 3000 }, (_, i) => ({ id: `c${i}`, function: { name: 'f', arguments: '{}' } }));
    const turns = extractConversation({ messages: [{ role: 'assistant', content, tool_calls }] }, null);
    // final aggregate cap — not 2000 content + 2000 tool_calls = 4000
    expect(turns[0].parts.length).toBeLessThanOrEqual(2000);
  });
  it('request capped at MAX_TURNS still leaves room — total never exceeds MAX_TURNS after response', () => {
    const messages = Array.from({ length: 2500 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const turns = extractConversation({ messages }, { choices: [{ message: { role: 'assistant', content: 'final' } }] });
    expect(turns.length).toBeLessThanOrEqual(2000);
  });
  it('a collapsed Responses output cannot exceed MAX_PARTS in one bubble', () => {
    const output = Array.from({ length: 3000 }, (_, i) => ({ type: 'message', role: 'assistant', content: `m${i}` }));
    const turns = extractConversation({ input: 'hi' }, { output, status: 'completed' });
    const last = turns[turns.length - 1];
    expect(last.parts.length).toBeLessThanOrEqual(2000);
  });
  it('per-field delete fuzz across canonical fixtures never throws', () => {
    const fixtures: unknown[] = [
      { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
      { messages: [{ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }] },
      { input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] },
      { contents: [{ role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] }] },
    ];
    for (const fx of fixtures) {
      const obj = fx as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const clone: Record<string, unknown> = { ...obj };
        delete clone[key];
        expect(() => extractConversation(clone, null)).not.toThrow();
      }
    }
  });
});

// ── clarity pass: empty suppression + tool pairing ───────────────────────────
describe('clarity pass', () => {
  it('drops an empty reasoning part (no empty Reasoning block)', () => {
    const turns = extractConversation(
      { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }, { type: 'text', text: 'hi' }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['text']); // reasoning stripped, text kept
  });
  it('drops a whitespace-only text part', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: [{ type: 'text', text: '  ' }, { type: 'text', text: 'real' }] }] },
      null,
    );
    expect(kinds(turns[0])).toEqual(['text']);
    expect(firstText(turns[0])).toBe('real');
  });
  it('drops a turn that folds to nothing (empty content → no bubble)', () => {
    const turns = extractConversation(
      { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '   ' }, { role: 'user', content: 'bye' }] },
      null,
    );
    // the empty assistant turn is suppressed entirely
    expect(turns.map((t) => t.role)).toEqual(['user', 'user']);
    expect(turns.map(firstText)).toEqual(['hello', 'bye']);
  });
  it('a pure-reasoning assistant turn survives only if the reasoning is non-empty', () => {
    const kept = extractConversation(
      { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'real reasoning' }] }] },
      null,
    );
    expect(kept).toHaveLength(1);
    expect(kinds(kept[0])).toEqual(['reasoning']);
    const gone = extractConversation(
      { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }] },
      null,
    );
    expect(gone).toEqual([]); // nothing to show
  });
  it('two same-name Gemini calls each pair with their OWN result in order (no cross-pair)', () => {
    const turns = extractConversation(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'a' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'search', response: 'RES-A' } }] },
          { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'b' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'search', response: 'RES-B' } }] },
        ],
      },
      null,
    );
    const exchanges = turns.flatMap((t) => t.parts).filter((p) => p.kind === 'tool_exchange');
    expect(exchanges).toHaveLength(2);
    // first call → first result, second call → second result (document order)
    expect(exchanges[0].kind === 'tool_exchange' && exchanges[0].output).toBe('RES-A');
    expect(exchanges[1].kind === 'tool_exchange' && exchanges[1].output).toBe('RES-B');
  });
  it('duplicate call ids: each result consumed at most once (one-result-per-call)', () => {
    const turns = extractConversation(
      {
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'dup', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'dup', content: 'R1' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'dup', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'dup', content: 'R2' },
        ],
      },
      null,
    );
    const ex = turns.flatMap((t) => t.parts).filter((p) => p.kind === 'tool_exchange');
    expect(ex).toHaveLength(2);
    expect(ex[0].kind === 'tool_exchange' && ex[0].output).toBe('R1');
    expect(ex[1].kind === 'tool_exchange' && ex[1].output).toBe('R2'); // NOT R1 twice
    // both results consumed → no orphan tool_result survives
    expect(turns.flatMap((t) => t.parts).some((p) => p.kind === 'tool_result')).toBe(false);
  });
  it('a result that precedes all its calls stays an orphan (never folded)', () => {
    const turns = extractConversation(
      {
        messages: [
          { role: 'tool', tool_call_id: 'x', content: 'early' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{}' } }] },
        ],
      },
      null,
    );
    const parts = turns.flatMap((t) => t.parts);
    // the early result can't answer a later call → orphan kept; call has no result
    expect(parts.some((p) => p.kind === 'tool_result')).toBe(true);
    const ex = parts.find((p) => p.kind === 'tool_exchange');
    expect(ex?.kind === 'tool_exchange' && ex.hasResult).toBe(false);
  });
  it('a call and its result across turns collapse into ONE tool_exchange (result turn dropped)', () => {
    const turns = extractConversation(
      {
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'result' },
        ],
      },
      null,
    );
    // one turn (assistant) with a tool_exchange; the tool turn was consumed+dropped
    expect(turns).toHaveLength(1);
    const ex = turns[0].parts[0];
    expect(ex.kind).toBe('tool_exchange');
    expect(ex.kind === 'tool_exchange' && ex.hasResult).toBe(true);
  });
});
