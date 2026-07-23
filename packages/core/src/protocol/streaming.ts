import { Buffer } from "node:buffer";
import { UpstreamError } from "../provider/openai.js";
import { runtimeMemoryBudget } from "../runtime/memory-budget.js";
import {
  type ResponseWorkAdmission,
  runtimeResponseWorkAdmission,
} from "../runtime/response-work-admission.js";
import type { IRResponse } from "./ir.js";

// Streaming primitives for the protocol layer (docs/05). Streaming correctness is
// Helm's #1 risk (CLAUDE.md principle 8): protocol translation of SSE events is
// NEVER passthrough — it is an explicit state machine. This module is the shared
// FRAMEWORK-AGNOSTIC foundation that every per-direction streaming transformer
// (OpenAI/Anthropic/Gemini) builds on. It contains three things:
//
//   1. `readSSE` — a generic byte-stream → SSE-frame splitter that survives chunk
//      boundaries landing on any byte (half-lines), CRLF/LF mixes, multiple events
//      crammed in one chunk, and the `[DONE]` sentinel.
//   2. `StreamState` + guards — the SHARED state object whose invariants every
//      direction obeys: a monotonic content-block index allocator, an
//      openai-index→block-index map, a temp-id→real-id upgrade table, and
//      `started/finished/closed` idempotent guards that prevent the
//      "controller already closed" bug (docs/05 pit #4) and the lost
//      `input_json_delta` class of bug (litellm #25561).
//   3. `synthesizeSSE` — a JSON→SSE synthesizer for cache hits / non-streaming
//      upstreams: it deterministically explodes ONE complete IR response into a
//      legal SSE event sequence so a streaming client is none the wiser.
//
// Per CLAUDE.md principle 1, core imports NO web framework: we use the Web-standard
// `ReadableStream`, never Hono's `streamSSE` (that wiring lives in the gateway).
// No `any`.

// —— Generic SSE reader/splitter (protocol-agnostic) ————————————————————————

/** A single decoded SSE frame: an optional `event:` name plus the joined `data:` payload. */
export interface SSEFrame {
  event?: string;
  data: string;
}

function assertSSEFrameFits(frame: string, maxFrameBytes: number): void {
  if (Buffer.byteLength(frame) <= maxFrameBytes) return;
  throw new UpstreamError("upstream_error", "upstream SSE frame exceeds the runtime memory budget");
}

function responseWorkError(): UpstreamError {
  return new UpstreamError(
    "upstream_error",
    "upstream response memory capacity is temporarily exhausted",
  );
}

// Per the SSE spec a frame ends at a BLANK line. `data:`/`event:` fields may
// repeat; multiple `data:` lines join with "\n". A leading single space after the
// colon is stripped. `[DONE]` is just another data payload (the caller decides).
function parseFrame(block: string): SSEFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  // Normalize CRLF → LF so a mixed stream splits cleanly.
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (event === undefined && dataLines.length === 0) return null;
  return { ...(event !== undefined ? { event } : {}), data: dataLines.join("\n") };
}

/**
 * Generic byte-stream → SSE-frame splitter. Tolerates chunk boundaries at ANY
 * byte (half-lines across chunks), CRLF/LF mixes, and multiple events packed into
 * one chunk. Yields one `SSEFrame` per blank-line-delimited block.
 */
export async function* readSSE(
  stream: ReadableStream<Uint8Array>,
  maxFrameBytes = runtimeMemoryBudget().maxWireBytes,
  workAdmission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): AsyncIterable<SSEFrame> {
  const reader = stream.getReader();
  const acquired = workAdmission.acquire(0);
  if (!acquired.ok) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw responseWorkError();
  }
  const { lease } = acquired;
  const decoder = new TextDecoder();
  let buffer = "";
  const resize = (wireBytes: number): void => {
    if (!lease.resize(wireBytes).ok) throw responseWorkError();
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resize(Buffer.byteLength(buffer) + value.byteLength);
      // `stream: true` keeps multibyte chars split across chunks intact.
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF so we can split on a single blank line.
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        assertSSEFrameFits(block, maxFrameBytes);
        const frame = parseFrame(block);
        if (frame !== null) yield frame;
        resize(Buffer.byteLength(buffer));
        sep = buffer.indexOf("\n\n");
      }
      assertSSEFrameFits(buffer, maxFrameBytes);
    }
    // Flush any trailing frame that wasn't terminated by a blank line.
    const decodedTail = decoder.decode();
    resize(Buffer.byteLength(buffer) + Buffer.byteLength(decodedTail));
    buffer += decodedTail;
    buffer = buffer.replace(/\r\n/g, "\n");
    assertSSEFrameFits(buffer, maxFrameBytes);
    const tail = parseFrame(buffer);
    if (tail !== null) yield tail;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    // Abort / client-disconnect cleanup: release the lock without throwing.
    reader.releaseLock();
    lease.release();
  }
}

/**
 * Parse one SSE `data` payload per a protocol's split pattern. Returns `null` for
 * the `[DONE]` sentinel and any non-JSON line instead of throwing, so a strict
 * consumer can skip junk frames safely.
 */
export function parseSSEData<T = unknown>(data: string): T | null {
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

// —— Per-direction streaming state machine (shared invariants) ————————————————

/**
 * The shared state object every per-direction streaming transformer threads
 * through. Its invariants are defined ONCE here so OpenAI/Anthropic/Gemini cannot
 * diverge on them (docs/05). Any content block MUST go `start → delta* → stop`;
 * a delta before `started` or before its block is open is illegal and a strict
 * consumer drops it (pit #4). `closed` makes every further controller op a no-op.
 */
export interface StreamState {
  /** Monotonic content-block index allocator (never reused, never decremented). */
  contentIndex: number;
  /** OpenAI integer stream index → assigned content-block index (stable). */
  openaiIndexToBlockIndex: Map<number, number>;
  /** Temporary tool-call id → real id upgrade table (pit #3). */
  toolCallIdUpgrade: Map<string, string>;
  /** Whether `message_start` has been emitted. */
  started: boolean;
  /** Whether the terminal `message_delta(stop)` has been emitted. */
  finished: boolean;
  /** Whether the controller has been closed (idempotent guard, pit #4). */
  closed: boolean;
  /** Blocks that have been `start`ed but not yet `stop`ped (enforces ordering). */
  openBlocks: Set<number>;
}

/** Create a fresh, empty streaming state with all guards down. */
export function createStreamState(): StreamState {
  return {
    contentIndex: 0,
    openaiIndexToBlockIndex: new Map(),
    toolCallIdUpgrade: new Map(),
    started: false,
    finished: false,
    closed: false,
    openBlocks: new Set(),
  };
}

/**
 * Minimal controller contract — the Web-standard `ReadableStreamDefaultController`
 * surface the guards need. Declared structurally (not imported) so core stays
 * framework-agnostic and the gateway's Hono `streamSSE` controller satisfies it.
 */
export interface Controller {
  enqueue(chunk: unknown): void;
  close(): void;
}

/**
 * Idempotent enqueue guard: a no-op once the stream is `closed`, so a late event
 * (e.g. after a client disconnect) never hits a closed controller (pit #4's
 * "controller already closed").
 */
export function safeEnqueue(c: Controller, state: StreamState, chunk: unknown): void {
  if (state.closed) return;
  c.enqueue(chunk);
}

/** Idempotent close guard: closes exactly once; subsequent calls are no-ops. */
export function safeClose(c: Controller, state: StreamState): void {
  if (state.closed) return;
  state.closed = true;
  c.close();
}

// —— JSON → SSE synthesizer (cache hit / non-streaming upstream) ——————————————

const encoder = new TextEncoder();

/** Serialize one frame onto the SSE wire: optional `event:` line + `data:` line(s). */
function frameToWire(frame: SSEFrame): string {
  let out = "";
  if (frame.event !== undefined) out += `event: ${frame.event}\n`;
  // Each data line is emitted as its own `data:` field (SSE spec for multiline).
  for (const line of frame.data.split("\n")) out += `data: ${line}\n`;
  return `${out}\n`;
}

/**
 * Synthesize a complete IR response into a legal, DETERMINISTIC SSE byte stream
 * for cache hits / non-streaming upstreams. The protocol supplies `toNativeEvents`
 * (its own start → delta(s) → tool_call(s) → finish split); this function appends
 * the `[DONE]` sentinel and serializes to the wire. The client cannot tell it from
 * a real upstream stream (lossless: a consumer reassembles an equivalent response).
 */
export function synthesizeSSE(
  res: IRResponse,
  toNativeEvents: (res: IRResponse) => SSEFrame[],
): ReadableStream<Uint8Array> {
  const frames = [...toNativeEvents(res), { data: "[DONE]" }];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[i];
      if (frame !== undefined) {
        controller.enqueue(encoder.encode(frameToWire(frame)));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}
