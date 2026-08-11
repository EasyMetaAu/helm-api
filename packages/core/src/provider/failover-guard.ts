import { Buffer } from "node:buffer";
import type { Protocol } from "@helm/shared";
import { nextSSEFrameBoundary } from "../protocol/streaming.js";
import { UpstreamError } from "./openai.js";

// The guard must retain preamble bytes verbatim until the first real output, so
// cap that replay window independently of the upstream's total response size.
export const MAX_PRE_OUTPUT_BUFFER_BYTES = 1_048_576;

// provider.failover-guard — pre-output streaming failure detector (CLAUDE.md
// principle 5 + 8: streaming correctness is the #1 risk; classification fallback ≠
// execution fallback). A native upstream that returns HTTP 200 and OPENS an SSE
// stream, then fails IN-BAND before producing any model output — e.g. OpenAI
// Responses emits the unconditional `response.created` / `response.in_progress`
// preamble, then `error` / `response.failed` with `server_is_overloaded` — must
// count as a FAILED attempt so the executor falls back to the next candidate, not
// stream the error frame to the client as a 200 success.
//
// WHY this is needed: the executor commits an attempt (breaker.recordSuccess, no
// further fallback) on the FIRST chunk peekStream pulls. For a stream that emits
// preamble before any output, that first chunk is meaningless preamble — the commit
// fires too early, and a later terminal error can only surface as a mid-stream
// truncation (client already "succeeded"). This guard sits BETWEEN the provider
// stream and peekStream and moves the commit point to the first REAL output:
//   • preamble events are BUFFERED, not yielded;
//   • on the first OUTPUT event → commit: flush the buffered bytes VERBATIM (byte-
//     for-byte, in order) then relay the rest of the stream untouched;
//   • on a terminal ERROR event seen BEFORE any output → throw UpstreamError, which
//     peekStream surfaces as a pre-first-chunk failure → the executor records a
//     breaker failure and advances the chain (exactly like a non-2xx upstream).
// Once committed it does ZERO parsing: a terminal error AFTER real output is a
// truncation (the client already holds bytes — falling back would double-send), so
// it is relayed verbatim, identical to today.

export type ChunkClass = "preamble" | "output" | "error";

export interface PreOutputClassifier {
  // Classify ONE complete SSE event by its `data:` payload (the JSON string, or the
  // literal "[DONE]"). Unparseable / unknown payloads default to "output" so a healthy
  // stream is never falsely failed (non-regressive: today everything commits at once).
  classify(dataPayload: string): ChunkClass;
  // Human-readable message for a terminal error event, for the thrown UpstreamError.
  errorMessage(dataPayload: string): string;
}

// Pull the `data:` payload out of one SSE event block (everything before a blank
// line). Joins multiple `data:` lines with "\n" per the SSE spec; returns null for an
// event with no data line (comments, bare `event:`/`: keep-alive`) so the guard skips
// it without committing.
function extractData(event: string): string | null {
  let data: string | null = null;
  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === null ? value : `${data}\n${value}`;
    }
  }
  return data;
}

function tryParse(data: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function errorFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["type", "code", "message", "param"] as const) {
    const field = value[key];
    if (typeof field === "string" || typeof field === "number" || field === null) {
      out[key] = field;
    }
  }
  return out;
}

function errorProviderRaw(data: string): Record<string, unknown> | null {
  const obj = tryParse(data);
  if (!obj) return null;
  const out = errorFields(obj);
  const error = asRecord(obj.error);
  if (error) out.error = errorFields(error);
  else if (typeof obj.error === "string") out.error = obj.error;
  const responseError = asRecord(asRecord(obj.response)?.error);
  if (responseError) out.response = { error: errorFields(responseError) };
  return out;
}

export function streamErrorFromData(classifier: PreOutputClassifier, data: string): UpstreamError {
  return new UpstreamError("upstream_error", classifier.errorMessage(data), errorProviderRaw(data));
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────
// Preamble: response.created / response.in_progress (emitted unconditionally before
// any model work). Error: error / response.failed. Everything else (deltas,
// output_item.added, response.completed/incomplete) is committing output.
const responsesClassifier: PreOutputClassifier = {
  classify(data) {
    if (data === "[DONE]") return "output";
    const obj = tryParse(data);
    if (!obj) return "output";
    const t = obj.type;
    if (t === "response.created" || t === "response.in_progress") return "preamble";
    if (t === "error" || t === "response.failed") return "error";
    return "output";
  },
  errorMessage(data) {
    const obj = tryParse(data) ?? {};
    const top = (obj.error ?? obj) as { message?: string };
    const nested = (((obj.response ?? {}) as Record<string, unknown>).error ?? {}) as {
      message?: string;
    };
    return top.message || nested.message || "upstream responses stream error";
  },
};

// ── Anthropic Messages ───────────────────────────────────────────────────────
// Preamble: message_start / ping / empty block lifecycle events. Error: error.
// Output: real content only — text/thinking deltas, tool_use starts, tool input
// deltas, or redacted/signature content. Terminal message_delta/message_stop alone
// must not commit; otherwise an upstream can "succeed" with no client-visible output.
const anthropicClassifier: PreOutputClassifier = {
  classify(data) {
    if (data === "[DONE]") return "output";
    const obj = tryParse(data);
    if (!obj) return "output";
    const t = obj.type;
    if (t === "message_start" || t === "ping") return "preamble";
    if (t === "error") return "error";
    if (t === "content_block_start") {
      const block = asRecord(obj.content_block);
      if (!block) return "preamble";
      switch (block.type) {
        case "tool_use":
          return nonEmptyString(block.id) && nonEmptyString(block.name) ? "output" : "preamble";
        case "text":
          return nonEmptyString(block.text) ? "output" : "preamble";
        case "thinking":
          return nonEmptyString(block.thinking) ? "output" : "preamble";
        case "redacted_thinking":
          return nonEmptyString(block.data) ? "output" : "preamble";
        default:
          return "output";
      }
    }
    if (t === "content_block_delta") {
      const delta = asRecord(obj.delta);
      if (!delta) return "preamble";
      if (nonEmptyString(delta.text)) return "output";
      if (nonEmptyString(delta.partial_json)) return "output";
      if (nonEmptyString(delta.thinking)) return "output";
      if (nonEmptyString(delta.signature)) return "output";
      switch (delta.type) {
        case "text_delta":
        case "input_json_delta":
        case "thinking_delta":
        case "signature_delta":
          return "preamble";
        default:
          return "output";
      }
    }
    if (t === "content_block_stop" || t === "message_delta" || t === "message_stop") {
      return "preamble";
    }
    return "output";
  },
  errorMessage(data) {
    const obj = tryParse(data) ?? {};
    const err = (obj.error ?? {}) as { message?: string };
    return err.message || "upstream anthropic stream error";
  },
};

// ── OpenAI Chat ──────────────────────────────────────────────────────────────
// Used both for native openai_chat passthrough AND for the translate path (whose
// generators always emit OpenAI-Chat frames). Preamble: a role-only / empty delta
// with no finish_reason. Error: a `{"error":{…}}` frame. Output: any real delta
// (content/tool_calls/function_call/reasoning_content/refusal), a finish_reason, a
// usage-only terminal frame, or [DONE].
const chatClassifier: PreOutputClassifier = {
  classify(data) {
    if (data === "[DONE]") return "output";
    const obj = tryParse(data);
    if (!obj) return "output";
    if (obj.error) return "error";
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    // No choices at all (a bare frame, or a usage-only terminal frame) → committing
    // output, never preamble: only a positively-recognized role announcement defers.
    if (choices.length === 0) return "output";
    const choice = (choices[0] ?? {}) as {
      delta?: Record<string, unknown>;
      finish_reason?: unknown;
    };
    if (choice.finish_reason != null) return "output";
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const hasContent =
      (typeof delta.content === "string" && delta.content.length > 0) ||
      delta.tool_calls != null ||
      delta.function_call != null ||
      (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
      delta.refusal != null;
    if (hasContent) return "output";
    // Content-less choice: defer ONLY if it is a role announcement — the translate
    // path's `{role,content:""}` preamble or an OpenAI first role-only chunk. Any other
    // content-less frame commits (conservative, non-regressive default).
    return delta.role != null ? "preamble" : "output";
  },
  errorMessage(data) {
    const obj = tryParse(data) ?? {};
    const err = (obj.error ?? {}) as { message?: string };
    return err.message || "upstream stream error";
  },
};

// Select the classifier for a native wire protocol. Returns null for gemini: its SSE
// has no separate preamble, so guarding it would add risk with no payoff — the caller
// skips the wrapper and keeps the unchanged commit-on-first-chunk behavior.
export function preOutputClassifierFor(protocol: Protocol): PreOutputClassifier | null {
  switch (protocol) {
    case "openai_responses":
      return responsesClassifier;
    case "anthropic_messages":
      return anthropicClassifier;
    case "openai_chat":
      return chatClassifier;
    default:
      return null;
  }
}

/**
 * Wrap a provider SSE string stream so a pre-output upstream failure becomes a
 * pre-first-chunk throw (→ executor fallback) instead of a relayed "success". See the
 * module header for the contract. Byte-for-byte on the commit path; ZERO parsing once
 * committed.
 */
export async function* guardPreOutputFailure(
  source: AsyncIterable<string>,
  classifier: PreOutputClassifier,
): AsyncGenerator<string> {
  const buffered: string[] = [];
  let bufferedBytes = 0;
  let sse = "";
  let committed = false;

  for await (const chunk of source) {
    if (committed) {
      yield chunk;
      continue;
    }
    const nextBufferedBytes = bufferedBytes + Buffer.byteLength(chunk);
    if (nextBufferedBytes > MAX_PRE_OUTPUT_BUFFER_BYTES) {
      throw new UpstreamError(
        "upstream_error",
        "upstream pre-output buffer exceeds the memory budget",
      );
    }
    // Hold the raw bytes for verbatim replay; accumulate a parallel text buffer only
    // to frame complete SSE events (split on the blank-line terminator).
    buffered.push(chunk);
    bufferedBytes = nextBufferedBytes;
    sse += chunk;
    let boundary = nextSSEFrameBoundary(sse);
    while (boundary !== null) {
      const data = extractData(sse.slice(0, boundary.index));
      sse = sse.slice(boundary.index + boundary.length);
      if (data !== null) {
        const cls = classifier.classify(data);
        if (cls === "error") throw streamErrorFromData(classifier, data);
        if (cls === "output") {
          committed = true;
          for (const b of buffered) yield b;
          buffered.length = 0;
          bufferedBytes = 0;
          break;
        }
      }
      boundary = nextSSEFrameBoundary(sse);
    }
  }

  // Source ended having emitted only preamble (no output, no error): an abnormal
  // close. Throw so the caller records a failure and falls back, rather than serving
  // an empty body as success.
  if (!committed) {
    throw new UpstreamError("upstream_error", "upstream stream ended before producing any output");
  }
}
