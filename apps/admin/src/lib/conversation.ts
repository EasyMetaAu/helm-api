// Fold a captured request body + its response into an ordered chat transcript for
// the admin "conversation" view. The gateway speaks four native client protocols
// (docs/05): OpenAI Chat, Anthropic Messages, OpenAI Responses, and Gemini. Each has
// its own message container, role vocabulary, content-block shapes, and tool-call /
// tool-result correlation. This module is the pure, framework-free normalizer that
// hides all of that behind one `ConversationTurn[]` model — the sibling of sse.ts
// (which assembles a streamed response) and imageData.ts (which sniffs images).
//
// Contract, mirroring those two:
//   * PURE — no Svelte, no I/O; safe to unit-test in isolation.
//   * FAIL-SOFT — NEVER throws. A malformed / partial / unknown body yields a
//     best-effort partial (or []), so a bad payload can never blank the detail page.
//   * REUSE — streamed responses fold via parseSseStream; images resolve via
//     imageDataUrl. We recompute nothing those already own.

import { imageDataUrl } from './components/imageData.js';
import { type AssembledStream, isSseStream, parseSseStream } from './sse.js';

export type ClientProtocol = 'openai-chat' | 'anthropic' | 'responses' | 'gemini' | 'unknown';

export type TurnRole = 'system' | 'user' | 'assistant' | 'tool';

export type TurnPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string } // thinking / reasoning / thought:true
  | { kind: 'image'; url: string } // already a renderable data:/http url
  // args/output kept as-is (object OR raw JSON string) — the viewer parses, not us.
  | { kind: 'tool_call'; id: string | null; name: string; args: unknown }
  | { kind: 'tool_result'; callId: string | null; name: string | null; output: unknown }
  // A call paired with its result — the shape the UI renders (one block: fn → status,
  // args in, result out). Produced by the post-fold pairing pass; either side may be
  // absent (truncated capture) but never both.
  | {
      kind: 'tool_exchange';
      id: string | null;
      name: string;
      args: unknown;
      hasResult: boolean;
      output: unknown;
    }
  | { kind: 'unknown'; value: unknown }; // fail-soft catch-all — never dropped

export interface ConversationTurn {
  role: TurnRole;
  parts: TurnPart[];
  /** The original wire object for this turn — rendered by JsonViewer on "view source". */
  raw: unknown;
  /** Where the turn came from, so the UI can label the folded final reply. */
  origin: 'request' | 'response';
}

// Defensive caps (mirror imageData.ts's MAX_IMAGES / MAX_WALK_DEPTH posture): a
// pathological or hostile body can never spawn unbounded turns.
const MAX_TURNS = 2000;
// Also bound the parts WITHIN a single turn: one message can carry a huge
// content/parts array (many image or tool chunks), which would otherwise slip past
// the per-turn cap and hang the page (Codex round-2 MEDIUM).
const MAX_PARTS = 2000;

// ── narrowing helpers (copied from sse.ts's fail-soft style) ─────────────────
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
// A message/content array bounded to MAX_TURNS at the SOURCE, so a pathological body
// can never make the fold loop build unbounded turns before the final cap (Codex #3).
function boundedArray(value: unknown): unknown[] {
  const arr = asArray(value);
  if (!arr) return [];
  return arr.length > MAX_TURNS ? arr.slice(0, MAX_TURNS) : arr;
}
// Cap ANY iterable of parts (tool_calls[], assembled toolCalls, summary[]) so no
// single message can spawn unbounded parts past MAX_PARTS (Codex #Q-B/#Q-C).
function capParts<T>(arr: T[]): T[] {
  return arr.length > MAX_PARTS ? arr.slice(0, MAX_PARTS) : arr;
}
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ── protocol detection ───────────────────────────────────────────────────────
// Sniff the REQUEST body's top-level container. Precedence when shapes overlap:
// OpenAI/Anthropic `messages[]` win over Gemini `contents[]` (a body carrying both
// is malformed; we pick deterministically rather than leave it order-dependent).
export function detectProtocol(request: unknown): ClientProtocol {
  const rec = asRecord(request);
  if (!rec) return 'unknown';
  if (asArray(rec.messages)) return isAnthropicMessages(rec) ? 'anthropic' : 'openai-chat';
  if ('input' in rec || 'instructions' in rec) return 'responses';
  if (asArray(rec.contents) || 'systemInstruction' in rec) return 'gemini';
  return 'unknown';
}

// Anthropic vs OpenAI Chat both use `messages[]`. Anthropic carries a top-level
// `system` and/or content-block arrays whose `type` is tool_use/tool_result/thinking
// (never present in OpenAI Chat, which uses `tool_calls[]` + a `role:'tool'` message).
function isAnthropicMessages(rec: Record<string, unknown>): boolean {
  if ('system' in rec) return true;
  // Bounded scan: the protocol is decided by the first messages/blocks; a huge body
  // must not freeze the sniffer before MAX_TURNS/MAX_PARTS ever apply (Codex #Q-B).
  for (const m of boundedArray(rec.messages)) {
    const msg = asRecord(m);
    if (!msg) continue;
    if (Array.isArray(msg.tool_calls)) return false; // OpenAI assistant tool calls
    if (msg.role === 'tool') return false; // OpenAI tool result message
    const blocks = asArray(msg.content);
    if (blocks) {
      for (const b of blocks.length > MAX_PARTS ? blocks.slice(0, MAX_PARTS) : blocks) {
        const t = asRecord(b)?.type;
        if (t === 'tool_use' || t === 'tool_result' || t === 'thinking' || t === 'redacted_thinking') return true;
        if (t === 'image' && asRecord(asRecord(b)?.source)) return true; // Anthropic image shape
      }
    }
  }
  return false;
}

// ── shared content-part mapping ──────────────────────────────────────────────
// Resolve an image reference to a renderable src. Two paths:
//   * base64 / data: bytes → imageDataUrl sniffs + builds a data: URL.
//   * a ready http(s) URL (production models are often given images by URL, not
//     inline base64) → passed through directly; ImagePreview renders any src.
// Handles OpenAI image_url (string | {url}), Anthropic source ({data} | {url}),
// Responses input_image, Gemini inlineData/fileData.
function httpUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}
function resolveImage(part: Record<string, unknown>): string | null {
  const imageUrl = part.image_url;
  if (typeof imageUrl === 'string') return imageDataUrl(imageUrl) ?? httpUrl(imageUrl);
  const iu = asRecord(imageUrl);
  if (iu) return imageDataUrl(iu.url) ?? httpUrl(iu.url);
  const src = asRecord(part.source);
  if (src) return imageDataUrl(src.data) ?? imageDataUrl(src.url) ?? httpUrl(src.url);
  const inline = asRecord(part.inlineData) ?? asRecord(part.inline_data);
  if (inline) return imageDataUrl(inline.data);
  const file = asRecord(part.fileData) ?? asRecord(part.file_data);
  if (file) return httpUrl(file.fileUri) ?? httpUrl(file.file_uri);
  return null;
}

/** Map an OpenAI/Responses/Anthropic content-part object to a TurnPart. */
function mapContentPart(part: unknown): TurnPart | null {
  const p = asRecord(part);
  if (!p) {
    const s = str(part);
    return s !== null ? { kind: 'text', text: s } : null;
  }
  const type = str(p.type);
  // text-bearing part types across protocols
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return { kind: 'text', text: str(p.text) ?? '' };
  }
  if (type === 'thinking') return { kind: 'reasoning', text: str(p.thinking) ?? '' };
  if (type === 'redacted_thinking') return { kind: 'reasoning', text: '[redacted thinking]' };
  if (type === 'refusal') return { kind: 'text', text: str(p.refusal) ?? '' };
  if (type === 'image' || type === 'image_url' || type === 'input_image') {
    const url = resolveImage(p);
    return url ? { kind: 'image', url } : { kind: 'unknown', value: part };
  }
  // Unknown/opaque part (document, input_file, input_audio…): keep, never drop.
  return { kind: 'unknown', value: part };
}

/** Normalize a message `content` that is a string OR an array of parts. */
function mapContent(content: unknown): TurnPart[] {
  const s = str(content);
  if (s !== null) return s === '' ? [] : [{ kind: 'text', text: s }];
  const arr = asArray(content);
  if (!arr) return content == null ? [] : [{ kind: 'unknown', value: content }];
  const parts: TurnPart[] = [];
  for (const item of arr.length > MAX_PARTS ? arr.slice(0, MAX_PARTS) : arr) {
    const mapped = mapContentPart(item);
    if (mapped) parts.push(mapped);
  }
  return parts;
}

// A running index of tool-call id/name so a tool_result can display the fn name
// even when the wire only echoes the id (OpenAI/Anthropic/Responses).
type ToolIndex = Map<string, string>;

// ── OpenAI Chat ──────────────────────────────────────────────────────────────
function foldOpenAiChat(rec: Record<string, unknown>): ConversationTurn[] {
  const messages = boundedArray(rec.messages);
  const toolNames: ToolIndex = new Map();
  const turns: ConversationTurn[] = [];
  for (const m of messages) {
    const msg = asRecord(m);
    if (!msg) continue;
    const role = normalizeRole(str(msg.role));
    // For a role:'tool' message the `content` IS the tool result — render it once as
    // a tool_result part, not also as a plain-text bubble (would double the output).
    const isToolResult = msg.role === 'tool';
    const parts: TurnPart[] = isToolResult ? [] : mapContent(msg.content);
    // assistant tool_calls[]
    for (const call of capParts(asArray(msg.tool_calls) ?? [])) {
      const c = asRecord(call);
      if (!c) continue;
      const fn = asRecord(c.function);
      const id = str(c.id);
      const name = str(fn?.name) ?? '';
      if (id) toolNames.set(id, name);
      parts.push({ kind: 'tool_call', id, name, args: fn?.arguments });
    }
    if (isToolResult) {
      const callId = str(msg.tool_call_id);
      parts.push({ kind: 'tool_result', callId, name: callId ? (toolNames.get(callId) ?? null) : null, output: msg.content });
    }
    turns.push({ role, parts, raw: m, origin: 'request' });
  }
  return turns;
}

// ── Anthropic Messages ────────────────────────────────────────────────────────
function foldAnthropic(rec: Record<string, unknown>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const systemTurn = systemFromValue(rec.system);
  if (systemTurn) turns.push(systemTurn);
  const toolNames: ToolIndex = new Map();
  for (const m of boundedArray(rec.messages)) {
    const msg = asRecord(m);
    if (!msg) continue;
    const role = normalizeRole(str(msg.role));
    const parts: TurnPart[] = [];
    const blocks = asArray(msg.content);
    if (blocks) {
      for (const b of blocks.length > MAX_PARTS ? blocks.slice(0, MAX_PARTS) : blocks) {
        const block = asRecord(b);
        if (!block) {
          const s = str(b);
          if (s !== null) parts.push({ kind: 'text', text: s });
          continue;
        }
        const type = str(block.type);
        if (type === 'tool_use') {
          const id = str(block.id);
          const name = str(block.name) ?? '';
          if (id) toolNames.set(id, name);
          parts.push({ kind: 'tool_call', id, name, args: block.input });
        } else if (type === 'tool_result') {
          const callId = str(block.tool_use_id);
          parts.push({ kind: 'tool_result', callId, name: callId ? (toolNames.get(callId) ?? null) : null, output: block.content });
        } else {
          const mapped = mapContentPart(block);
          if (mapped) parts.push(mapped);
        }
      }
    } else {
      parts.push(...mapContent(msg.content));
    }
    turns.push({ role, parts, raw: m, origin: 'request' });
  }
  return turns;
}

// ── OpenAI Responses ──────────────────────────────────────────────────────────
function foldResponses(rec: Record<string, unknown>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const systemTurn = systemFromValue(rec.instructions);
  if (systemTurn) turns.push(systemTurn);

  const input = rec.input;
  const inputStr = str(input);
  if (inputStr !== null) {
    if (inputStr !== '') turns.push({ role: 'user', parts: [{ kind: 'text', text: inputStr }], raw: input, origin: 'request' });
    return turns;
  }
  const items = asArray(input);
  if (items) turns.push(...foldResponseItems(items, 'request'));
  return turns;
}

// The Responses item stream (used for both request `input` and response `output`).
function foldResponseItems(items: unknown[], origin: 'request' | 'response'): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const toolNames: ToolIndex = new Map();
  for (const it of items.length > MAX_TURNS ? items.slice(0, MAX_TURNS) : items) {
    const item = asRecord(it);
    if (!item) continue;
    const type = str(item.type) ?? 'message';
    if (type === 'message') {
      turns.push({ role: normalizeRole(str(item.role)), parts: mapContent(item.content), raw: it, origin });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const id = str(item.call_id) ?? str(item.id);
      const name = str(item.name) ?? '';
      if (id) toolNames.set(id, name);
      // function_call → `arguments` (JSON string); custom_tool_call → `input` (raw text)
      const args = 'arguments' in item ? item.arguments : item.input;
      turns.push({ role: 'assistant', parts: [{ kind: 'tool_call', id, name, args }], raw: it, origin });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = str(item.call_id);
      turns.push({
        role: 'tool',
        parts: [{ kind: 'tool_result', callId, name: callId ? (toolNames.get(callId) ?? null) : null, output: item.output }],
        raw: it,
        origin,
      });
    } else if (type === 'reasoning') {
      turns.push({ role: 'assistant', parts: [{ kind: 'reasoning', text: summaryText(item.summary) }], raw: it, origin });
    } else {
      turns.push({ role: 'assistant', parts: [{ kind: 'unknown', value: it }], raw: it, origin });
    }
  }
  return turns;
}

function summaryText(summary: unknown): string {
  const arr = asArray(summary);
  if (!arr) return str(summary) ?? '';
  return capParts(arr)
    .map((s) => str(asRecord(s)?.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

// ── Gemini ─────────────────────────────────────────────────────────────────────
function foldGemini(rec: Record<string, unknown>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const sysInstr = asRecord(rec.systemInstruction) ?? asRecord(rec.system_instruction);
  if (sysInstr) {
    const parts = geminiParts(sysInstr.parts, new Map(), []);
    if (parts.length) turns.push({ role: 'system', parts, raw: sysInstr, origin: 'request' });
  }
  // functionCall has no id — pair to functionResponse by name + occurrence order.
  const callOrder: string[] = [];
  const seenResults = new Map<string, number>();
  for (const c of boundedArray(rec.contents)) {
    const content = asRecord(c);
    if (!content) continue;
    const role: TurnRole = content.role === 'model' ? 'assistant' : 'user';
    const parts = geminiParts(content.parts, seenResults, callOrder);
    turns.push({ role, parts, raw: c, origin: 'request' });
  }
  return turns;
}

function geminiParts(rawParts: unknown, seenResults: Map<string, number>, callOrder: string[]): TurnPart[] {
  const arr = asArray(rawParts);
  if (!arr) return [];
  const parts: TurnPart[] = [];
  for (const p of arr.length > MAX_PARTS ? arr.slice(0, MAX_PARTS) : arr) {
    const part = asRecord(p);
    if (!part) continue;
    if (part.thought === true) {
      parts.push({ kind: 'reasoning', text: str(part.text) ?? '' });
    } else if ('text' in part) {
      parts.push({ kind: 'text', text: str(part.text) ?? '' });
    } else if (asRecord(part.functionCall)) {
      const fc = asRecord(part.functionCall) as Record<string, unknown>;
      const name = str(fc.name) ?? '';
      // Gemini functionCall has no id — synthesize a stable `name#ordinal` key so the
      // Nth call of a name pairs with the Nth response (callOrder tracks occurrence).
      const ordinal = callOrder.filter((n) => n === name).length;
      callOrder.push(name);
      parts.push({ kind: 'tool_call', id: `${name}#${ordinal}`, name, args: fc.args });
    } else if (asRecord(part.functionResponse)) {
      const fr = asRecord(part.functionResponse) as Record<string, unknown>;
      const name = str(fr.name) ?? '';
      const ordinal = seenResults.get(name) ?? 0;
      seenResults.set(name, ordinal + 1);
      parts.push({ kind: 'tool_result', callId: `${name}#${ordinal}`, name, output: fr.response });
    } else {
      const img = resolveImage(part);
      if (img) parts.push({ kind: 'image', url: img });
      else parts.push({ kind: 'unknown', value: p });
    }
  }
  return parts;
}

// ── shared bits ────────────────────────────────────────────────────────────────
function normalizeRole(role: string | null): TurnRole {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
    case 'model':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    case 'system':
    case 'developer':
      return 'system';
    default:
      return 'user';
  }
}

/** A top-level system prompt (string OR text-block array) → one leading system turn. */
function systemFromValue(value: unknown): ConversationTurn | null {
  const s = str(value);
  if (s !== null) return s === '' ? null : { role: 'system', parts: [{ kind: 'text', text: s }], raw: value, origin: 'request' };
  const arr = asArray(value);
  if (!arr) return null;
  const parts = mapContent(arr);
  return parts.length ? { role: 'system', parts, raw: value, origin: 'request' } : null;
}

// ── the folded final reply (response side) ──────────────────────────────────────
function foldResponse(response: unknown): ConversationTurn[] {
  if (response == null) return [];
  // Streamed body: raw SSE text — reuse the assembler, don't re-parse.
  if (isSseStream(response)) {
    const assembled = parseSseStream(response).assembled;
    return [assistantTurnFromAssembled(assembled, response)];
  }
  const rec = asRecord(response);
  if (!rec) return [];
  return foldResponseObject(rec);
}

function assistantTurnFromAssembled(a: AssembledStream, raw: unknown): ConversationTurn {
  const parts: TurnPart[] = [];
  if (a.reasoning) parts.push({ kind: 'reasoning', text: a.reasoning });
  if (a.content) parts.push({ kind: 'text', text: a.content });
  // AssembledStream normalizes every protocol's tool args to a STRING (sse.ts
  // JSON.stringifies Gemini/Anthropic objects). Coerce a complete JSON string back
  // to its object so the streamed path matches the non-stream object path; a
  // partial/non-JSON string (e.g. apply_patch freeform body) is kept verbatim.
  for (const call of capParts(a.toolCalls)) parts.push({ kind: 'tool_call', id: call.id, name: call.name, args: coerceJson(call.arguments) });
  return { role: 'assistant', parts, raw, origin: 'response' };
}

/** Parse a complete JSON string back to its value; return the input unchanged otherwise. */
function coerceJson(value: string): unknown {
  const s = value.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function foldResponseObject(rec: Record<string, unknown>): ConversationTurn[] {
  // OpenAI Chat: choices[0].message
  const choices = asArray(rec.choices);
  if (choices && choices.length) {
    const msg = asRecord(asRecord(choices[0])?.message);
    if (msg) {
      const parts = mapContent(msg.content);
      for (const call of capParts(asArray(msg.tool_calls) ?? [])) {
        const c = asRecord(call);
        const fn = asRecord(c?.function);
        parts.push({ kind: 'tool_call', id: str(c?.id), name: str(fn?.name) ?? '', args: fn?.arguments });
      }
      const rc = str(msg.reasoning_content);
      if (rc) parts.unshift({ kind: 'reasoning', text: rc });
      return [{ role: 'assistant', parts, raw: rec, origin: 'response' }];
    }
  }
  // OpenAI Responses: output[] item stream
  const output = asArray(rec.output);
  if (output) {
    const turns = foldResponseItems(output, 'response');
    return turns.length ? [collapseAssistant(turns, rec)] : [];
  }
  // Gemini: candidates[0].content.parts[]
  const candidates = asArray(rec.candidates);
  if (candidates && candidates.length) {
    const content = asRecord(asRecord(candidates[0])?.content);
    const parts = geminiParts(content?.parts, new Map(), []);
    return [{ role: 'assistant', parts, raw: rec, origin: 'response' }];
  }
  // Anthropic: top-level { role, content:[blocks] }
  if (asArray(rec.content)) {
    const turns = foldAnthropic({ messages: [rec] }).map((t) => ({ ...t, raw: rec, origin: 'response' as const }));
    return turns;
  }
  return [];
}

// Merge a multi-item Responses `output[]` into a single assistant reply turn so the
// final bubble is one unit (its raw is the whole response object for "view source").
function collapseAssistant(turns: ConversationTurn[], raw: unknown): ConversationTurn {
  const parts: TurnPart[] = [];
  for (const t of turns) {
    if (parts.length >= MAX_PARTS) break; // total cap — a collapsed reply can't exceed MAX_PARTS (Codex #Q-C)
    parts.push(...t.parts);
  }
  return { role: 'assistant', parts: capParts(parts), raw, origin: 'response' };
}

// ── entry point ──────────────────────────────────────────────────────────────
/**
 * Fold a captured request body + its response into an ordered chat transcript.
 * Never throws; returns [] for an unrecognized/empty body.
 */
export function extractConversation(request: unknown, response: unknown): ConversationTurn[] {
  try {
    const protocol = detectProtocol(request);
    const rec = asRecord(request);
    let turns: ConversationTurn[] = [];
    if (rec) {
      switch (protocol) {
        case 'openai-chat':
          turns = foldOpenAiChat(rec);
          break;
        case 'anthropic':
          turns = foldAnthropic(rec);
          break;
        case 'responses':
          turns = foldResponses(rec);
          break;
        case 'gemini':
          turns = foldGemini(rec);
          break;
      }
    }
    // Only append a response turn when we recognized the request (protocol drives the
    // response shape); an unknown request with a stray response stays empty.
    if (protocol !== 'unknown') turns.push(...foldResponse(response));
    // Final aggregate caps: total turns AND each turn's parts are bounded here, so a
    // hostile payload (huge content + huge tool_calls on one turn, or request+response
    // together) can never exceed MAX_TURNS/MAX_PARTS regardless of the fold path.
    if (turns.length > MAX_TURNS) turns = turns.slice(0, MAX_TURNS);
    for (const turn of turns) {
      if (turn.parts.length > MAX_PARTS) turn.parts = capParts(turn.parts);
    }
    // Post-fold cleanup (drives clarity — the viewer only draws what survives here):
    //   1. pair tool_call ↔ tool_result across turns into one tool_exchange part
    //   2. drop empty parts (whitespace text / empty reasoning / valueless unknown)
    //   3. drop turns that end up with nothing to show
    return cleanTurns(pairToolExchanges(turns));
  } catch {
    // Fail-soft: a bad payload can never blank the page.
    return [];
  }
}

// ── post-fold clarity pass ───────────────────────────────────────────────────

// Pair each tool_call with the tool_result that answers it (by id/callId) and fold
// the two into a single `tool_exchange` part on the CALL's turn. The result turn's
// paired part is removed; if that empties the turn it's dropped by cleanTurns. A
// call with no matching result becomes a tool_exchange with hasResult:false; an
// orphan result (no matching call) is left as-is so it's never silently lost.
function pairToolExchanges(turns: ConversationTurn[]): ConversationTurn[] {
  // Pair in DOCUMENT ORDER, one result per call: each call takes the FIRST not-yet-
  // consumed result with the same id that appears AT OR AFTER it. This is robust to
  // (a) ids that are only locally unique — Gemini synthesizes per-turn `name#ordinal`
  // keys that can repeat across turns, (b) duplicate ids in a malformed body, and
  // (c) a result that precedes all its calls (it stays an orphan). A result consumed
  // by a call is dropped from its own turn; an unmatched result is kept, never lost.
  //
  // Build a flat list of every result's linear position so a call can claim the next
  // free one for its id without O(n²) rescans.
  type Loc = { ti: number; pi: number };
  const resultsById = new Map<string, Loc[]>(); // id → result locations, in order
  turns.forEach((turn, ti) =>
    turn.parts.forEach((p, pi) => {
      if (p.kind === 'tool_result' && p.callId) {
        const list = resultsById.get(p.callId) ?? [];
        list.push({ ti, pi });
        resultsById.set(p.callId, list);
      }
    }),
  );
  const nextFree = new Map<string, number>(); // id → index into resultsById[id]
  const consumed = new Set<string>(); // "ti:pi" of results folded into a call
  const outputAt = (loc: Loc): unknown => {
    const p = turns[loc.ti]?.parts[loc.pi];
    return p && p.kind === 'tool_result' ? p.output : null;
  };

  // Pass 1: walk calls in order, claim each one's next free same-id result.
  const claimed = new Map<string, Loc | null>(); // "callTi:callPi" → result loc
  turns.forEach((turn, ti) =>
    turn.parts.forEach((p, pi) => {
      if (p.kind !== 'tool_call') return;
      const key = `${ti}:${pi}`;
      const list = p.id ? resultsById.get(p.id) : undefined;
      if (!list) {
        claimed.set(key, null);
        return;
      }
      let idx = nextFree.get(p.id as string) ?? 0;
      // skip results that appear strictly BEFORE this call (can't answer it)
      while (idx < list.length && (list[idx].ti < ti || (list[idx].ti === ti && list[idx].pi < pi))) idx++;
      if (idx < list.length) {
        const loc = list[idx];
        nextFree.set(p.id as string, idx + 1);
        consumed.add(`${loc.ti}:${loc.pi}`);
        claimed.set(key, loc);
      } else {
        claimed.set(key, null);
      }
    }),
  );

  // Pass 2: emit tool_exchange for each call; drop consumed results; keep the rest.
  return turns.map((turn, ti) => {
    const parts: TurnPart[] = [];
    turn.parts.forEach((p, pi) => {
      if (p.kind === 'tool_call') {
        const loc = claimed.get(`${ti}:${pi}`) ?? null;
        parts.push({
          kind: 'tool_exchange',
          id: p.id,
          name: p.name,
          args: p.args,
          hasResult: loc !== null,
          output: loc ? outputAt(loc) : null,
        });
      } else if (p.kind === 'tool_result' && consumed.has(`${ti}:${pi}`)) {
        // folded into its call's tool_exchange — drop
      } else {
        parts.push(p);
      }
    });
    return { ...turn, parts };
  });
}

/** A part carries no signal and should not render. */
function isEmptyPart(p: TurnPart): boolean {
  switch (p.kind) {
    case 'text':
    case 'reasoning':
      return p.text.trim() === '';
    case 'image':
      return !p.url;
    case 'unknown':
      return p.value == null || p.value === '';
    default:
      return false; // tool_call / tool_result / tool_exchange always carry signal
  }
}

// Drop empty parts, then drop turns left with nothing. Exception: an assistant turn
// whose only content was reasoning that got hidden should not silently vanish — but
// reasoning parts are non-empty here (empty ones are dropped as noise), so a truly
// empty assistant turn genuinely has nothing to show and is correctly removed.
function cleanTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    const parts = turn.parts.filter((p) => !isEmptyPart(p));
    if (parts.length === 0) continue;
    out.push({ ...turn, parts });
  }
  return out;
}
