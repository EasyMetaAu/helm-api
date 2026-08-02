import type { DecisionRecord, TelemetryStore } from "@helm/core";
import {
  billedCostFromBody,
  PERSISTED_SESSION_MAX_REVISIONS,
  usageFromBody as parseUsage,
  runtimeMemoryBudget,
  splitSessionRequestJson,
} from "@helm/core";
import type { RequestContentMode, TokenUsageBreakdown } from "@helm/shared";
import { countTokens as countO200kHarmonyTokens } from "gpt-tokenizer/encoding/o200k_harmony";
import { CONCURRENCY_LEASE_LOST_REASON } from "../request-cancellation.js";
import type { WriteQueue } from "../runtime/write-queue.js";

// Shared full request/response capture + streamed-cost backfill helpers, used by
// BOTH the OpenAI (chat.ts) and Anthropic (messages-pipeline.ts) routes.
//
// Capture is gated by the runtime setting `capture_payloads` (admin "System
// Settings", default OFF). When off, nothing is written. The stored bodies are
// VERBATIM (not redacted) — they carry no plaintext API key because the bearer
// lives in the request's Authorization header, never in the chat body.
//
// Everything here is FAIL-OPEN: a capture or cost-backfill failure must never
// turn a served request into a 5xx or break an in-flight stream.

export interface PayloadCaptureDeps {
  telemetry: TelemetryStore;
  /** Live getter for the capture_payloads runtime setting. */
  capturePayloads?: () => boolean;
  /** Live getter for the incremental per-session request transcript setting. */
  captureSessions?: () => boolean;
  /** Monotonic generation for live capture-mode changes. Deferred body writes
   * from an older generation are discarded while telemetry still lands. */
  captureGeneration?: () => number;
  /** Optional test/embedding override. Production derives this from the V8 heap. */
  captureBodyLimitBytes?: number;
  /** Resolve the served attempt's USD cost from the trailing usage chunk: an
   *  upstream-BILLED cost in it (`cost_usd` / OpenRouter `cost`) OVERRIDES the
   *  catalog estimate, else tokens × `alias`'s pricing; null when neither is
   *  available. Closed over the catalog + resolveCostUsd in the composition root. */
  costOf?: (alias: string, usage: StreamUsage) => number | null;
}

/** Apply one authenticated key's override without mutating the shared live deps. */
export function withRequestContentMode<T extends PayloadCaptureDeps>(
  deps: T,
  mode: RequestContentMode | null | undefined,
): T {
  if (mode == null) return deps;
  const globallyEnabled = () =>
    deps.capturePayloads?.() === true || deps.captureSessions?.() === true;
  return {
    ...deps,
    capturePayloads: () => globallyEnabled() && mode === "payload",
    captureSessions: () => globallyEnabled() && mode === "session",
  };
}

export interface StreamUsage {
  /** Helm provenance for locally reconstructed partial-stream usage. Provider
   * usage objects omit this and therefore remain authoritative `reported`. */
  measurement?: "reported" | "estimated_partial";
  cost_basis?: "catalog_api_equivalent_estimate";
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string;
  inference_geo?: string;
  input_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
    cached_audio_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_tokens?: number;
    cache_creation_input_tokens?: number;
    [k: string]: unknown;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
    cached_audio_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_tokens?: number;
    cache_creation_input_tokens?: number;
    [k: string]: unknown;
  };
  output_tokens_details?: {
    image_tokens?: number;
    [k: string]: unknown;
  };
  completion_tokens_details?: {
    image_tokens?: number;
    [k: string]: unknown;
  };
  /** Upstream-billed cost, when the relay reports it in the usage chunk. OpenRouter
   *  uses `cost`; others `cost_usd`. resolveCostUsd prefers these over the estimate. */
  cost?: number;
  cost_usd?: number;
}

/** Inspect one native Responses event without retaining the whole SSE body. */
export function inspectResponsesStreamEvent(data: string): {
  delta: string | null;
  outcome: "completed" | "incomplete" | "failed" | null;
  sequenceNumber: number | null;
  channel: string | null;
} {
  let event: {
    type?: unknown;
    delta?: unknown;
    sequence_number?: unknown;
    item_id?: unknown;
    output_index?: unknown;
    content_index?: unknown;
  };
  try {
    event = JSON.parse(data) as { type?: unknown; delta?: unknown };
  } catch {
    return { delta: null, outcome: null, sequenceNumber: null, channel: null };
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { delta: null, outcome: null, sequenceNumber: null, channel: null };
  }
  const sequenceNumber =
    typeof event.sequence_number === "number" && Number.isInteger(event.sequence_number)
      ? event.sequence_number
      : null;
  if (event.type === "response.completed") {
    return { delta: null, outcome: "completed", sequenceNumber, channel: null };
  }
  if (event.type === "response.incomplete") {
    return { delta: null, outcome: "incomplete", sequenceNumber, channel: null };
  }
  if (
    event.type === "response.failed" ||
    event.type === "response.cancelled" ||
    event.type === "error"
  ) {
    return { delta: null, outcome: "failed", sequenceNumber, channel: null };
  }
  const tokenBearingDelta =
    event.type === "response.output_text.delta" ||
    event.type === "response.refusal.delta" ||
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.reasoning_summary_text.delta" ||
    event.type === "response.function_call_arguments.delta" ||
    event.type === "response.custom_tool_call_input.delta" ||
    event.type === "response.code_interpreter_call_code.delta";
  const channelIdentity = [
    typeof event.item_id === "string" ? event.item_id : null,
    typeof event.output_index === "number" ? `output-${event.output_index}` : null,
    typeof event.content_index === "number" ? `content-${event.content_index}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(":");
  return {
    delta: tokenBearingDelta && typeof event.delta === "string" ? event.delta : null,
    outcome: null,
    sequenceNumber,
    channel: tokenBearingDelta ? `${event.type}:${channelIdentity || "default"}` : null,
  };
}

export interface ResponsesDeltaAccumulator {
  observe(data: string): void;
  channels(): string[];
  overflowBytes(): number;
  outcome(): "completed" | "incomplete" | "failed" | null;
}

/** Collect semantic Responses deltas independently of network fragmentation. */
export function createResponsesDeltaAccumulator(): ResponsesDeltaAccumulator {
  const maxRetainedChars = 65_536;
  const channels = new Map<string, string[]>();
  let retainedChars = 0;
  let droppedBytes = 0;
  let lastSequenceNumber: number | null = null;
  let terminalOutcome: "completed" | "incomplete" | "failed" | null = null;
  return {
    observe(data): void {
      const inspected = inspectResponsesStreamEvent(data);
      if (
        inspected.sequenceNumber !== null &&
        lastSequenceNumber !== null &&
        inspected.sequenceNumber <= lastSequenceNumber
      ) {
        return;
      }
      if (inspected.sequenceNumber !== null) lastSequenceNumber = inspected.sequenceNumber;
      if (inspected.delta !== null && inspected.channel !== null) {
        const available = Math.max(0, maxRetainedChars - retainedChars);
        const retained = inspected.delta.slice(0, available);
        const dropped = inspected.delta.slice(available);
        if (retained.length > 0) {
          const chunks = channels.get(inspected.channel) ?? [];
          chunks.push(retained);
          channels.set(inspected.channel, chunks);
          retainedChars += retained.length;
        }
        if (dropped.length > 0) droppedBytes += Buffer.byteLength(dropped, "utf8");
      }
      if (inspected.outcome !== null) terminalOutcome = inspected.outcome;
    },
    channels(): string[] {
      return [...channels.values()].map((chunks) => chunks.join(""));
    },
    overflowBytes(): number {
      return droppedBytes;
    },
    outcome(): "completed" | "incomplete" | "failed" | null {
      return terminalOutcome;
    },
  };
}

function semanticResponsesRequestText(raw: string): string {
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    request = parsed as Record<string, unknown>;
  } catch {
    return raw;
  }

  const sanitize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      const binaryLikeKey = /(?:image|audio|file|data|base64)/i.test(key);
      const dataUrl = value.startsWith("data:") && value.includes(";base64,");
      return binaryLikeKey && (dataUrl || value.length > 4096) ? "[binary content]" : value;
    }
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          sanitize(child, childKey),
        ]),
      );
    }
    return value;
  };

  // Token-bearing request dimensions only. Transport controls are excluded;
  // opaque previous_response_id history remains unobservable, so this is an estimate.
  return JSON.stringify({
    instructions: sanitize(request.instructions, "instructions"),
    input: sanitize(request.input, "input"),
    tools: sanitize(request.tools, "tools"),
    tool_choice: sanitize(request.tool_choice, "tool_choice"),
    response_format: sanitize(request.response_format, "response_format"),
  });
}

/**
 * Reconstruct partial usage when a native Responses stream ends before a terminal
 * usage event. Prompt tokens are an o200k-harmony estimate over the serialized
 * upstream wire request. Completion tokens are estimated from the semantic
 * text/reasoning/tool deltas Helm actually received. Cache hits, hidden
 * reasoning and provider-side adjustments remain unknowable, hence
 * `measurement="estimated_partial"` rather than an exact claim.
 */
export function estimateInterruptedResponsesUsage(
  upstreamRequest: string | null | undefined,
  observedDeltas: readonly string[],
  observedOverflowBytes = 0,
): StreamUsage | null {
  const requestText = upstreamRequest ? semanticResponsesRequestText(upstreamRequest) : "";
  if (
    requestText.length === 0 &&
    observedOverflowBytes === 0 &&
    observedDeltas.every((delta) => delta.length === 0)
  )
    return null;

  const estimate = (text: string): number => {
    if (text.length === 0) return 0;
    const byteEstimate = (): number => Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
    // gpt-tokenizer becomes disproportionately expensive on very large prompts.
    // Interrupted streams must never turn accounting into an event-loop stall, so
    // large semantic payloads use Helm's existing deterministic byte estimate.
    if (text.length > 16_384) return byteEstimate();
    try {
      // Treat marker-looking user text as ordinary content, not tokenizer control
      // tokens. An empty disallowed set disables special-token recognition.
      return countO200kHarmonyTokens(text, { disallowedSpecial: new Set() });
    } catch {
      // The estimator itself must stay fail-open. UTF-8 bytes/4 is the same
      // deterministic fallback used by the Responses /input_tokens surface.
      return byteEstimate();
    }
  };
  const promptTokens = estimate(requestText);
  // Each entry is one semantic output channel after all of its network fragments
  // were joined. Sum channels separately so unrelated text/tool/reasoning content
  // cannot create artificial BPE merges at their boundaries.
  const completionTokens =
    observedDeltas.reduce((total, channel) => total + estimate(channel), 0) +
    Math.ceil(observedOverflowBytes / 4);
  return {
    measurement: "estimated_partial",
    cost_basis: "catalog_api_equivalent_estimate",
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export function captureEnabled(deps: PayloadCaptureDeps): boolean {
  return deps.capturePayloads?.() === true;
}

export function sessionCaptureEnabled(deps: PayloadCaptureDeps): boolean {
  return deps.captureSessions?.() === true;
}

function capturedResponseObject(value: unknown): {
  responseId: string;
  responseJson: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const response =
    (candidate.type === "response.completed" ||
      candidate.type === "response.incomplete" ||
      candidate.type === "response.failed") &&
    candidate.response &&
    typeof candidate.response === "object" &&
    !Array.isArray(candidate.response)
      ? (candidate.response as Record<string, unknown>)
      : candidate;
  if (typeof response.id !== "string" || response.id.trim() === "") return null;
  if (!Array.isArray(response.output)) return null;
  return { responseId: response.id, responseJson: JSON.stringify(response) };
}

/** Retain only a usable native Responses snapshot for continuation recovery. */
export function capturedResponsesResponse(
  protocol: DecisionRecord["protocol"],
  raw: string | null,
): { responseId: string | null; responseJson: string | null } {
  if (protocol !== "openai_responses" || raw === null) {
    return { responseId: null, responseJson: null };
  }
  try {
    const direct = capturedResponseObject(JSON.parse(raw) as unknown);
    if (direct) return direct;
  } catch {
    // A streamed response is SSE, not one JSON document; inspect data lines below.
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const captured = capturedResponseObject(JSON.parse(data) as unknown);
      if (captured) return captured;
    } catch {
      // Ignore keepalives and malformed non-terminal frames.
    }
  }
  return { responseId: null, responseJson: null };
}

const defaultMemoryBudget = runtimeMemoryBudget();

function captureBodyLimitBytes(deps: PayloadCaptureDeps): number {
  return deps.captureBodyLimitBytes ?? defaultMemoryBudget.responseCaptureBytes;
}

const saturatedSessionRefs = new WeakMap<TelemetryStore, Set<string>>();

function saturatedSessions(store: TelemetryStore): Set<string> {
  const existing = saturatedSessionRefs.get(store);
  if (existing) return existing;
  const created = new Set<string>();
  saturatedSessionRefs.set(store, created);
  return created;
}

function markSaturatedSession(store: TelemetryStore, sessionRef: string, maxBytes: number): void {
  const refs = saturatedSessions(store);
  refs.delete(sessionRef);
  refs.add(sessionRef);
  const maxEntries = Math.max(1, Math.floor(maxBytes / 1024));
  while (refs.size > maxEntries) {
    const oldest = refs.values().next().value;
    if (oldest === undefined) break;
    refs.delete(oldest);
  }
}

export function clearSessionCaptureCache(store: TelemetryStore): void {
  saturatedSessionRefs.delete(store);
}

export async function persistSessionRequest(
  deps: PayloadCaptureDeps,
  args: {
    requestId: string;
    accountId: string;
    apiKeyId: string;
    decision: DecisionRecord;
    requestJson: string;
    responseId: string | null;
    responseJson: string | null;
    now: number;
  },
  log: (msg: string) => void,
): Promise<void> {
  const session = args.decision.session;
  const get = deps.telemetry.getSessionByRef;
  const getByResponseId = deps.telemetry.findSessionRequestIdByResponseId;
  const upsert = deps.telemetry.upsertSessionRevision;
  if (!sessionCaptureEnabled(deps)) {
    clearSessionCaptureCache(deps.telemetry);
    return;
  }
  if (!session?.label || !get || !upsert) return;
  try {
    if (Buffer.byteLength(args.requestJson, "utf8") > captureBodyLimitBytes(deps)) {
      log("session.capture_limited");
      return;
    }
    const head = await get.call(deps.telemetry, session.ref);
    if (head && head.revisionCount >= PERSISTED_SESSION_MAX_REVISIONS) {
      markSaturatedSession(deps.telemetry, session.ref, defaultMemoryBudget.sessionCacheBytes);
      log("session.capture_limited");
      return;
    }
    const currentBase = splitSessionRequestJson(
      args.requestJson,
      head?.eventHead && head.eventHead.requestId === head.headRequestId
        ? {
            eventKey: head.eventHead.eventKey,
            eventCount: head.eventHead.eventCount,
            eventHash: head.eventHead.eventHash,
          }
        : undefined,
    );
    const previousResponseId = currentBase.previousResponseId;
    let parentRequestId: string | null = null;
    let fidelity: "semantic" | "partial" = "semantic";
    if (previousResponseId !== null) {
      const parent = getByResponseId
        ? await getByResponseId.call(deps.telemetry, session.ref, previousResponseId)
        : null;
      parentRequestId = parent?.requestId ?? null;
      if (parent?.responseBodyStored !== true) fidelity = "partial";
    } else {
      parentRequestId = head?.headRequestId ?? null;
    }
    const delta = currentBase;
    await upsert.call(deps.telemetry, {
      sessionRef: session.ref,
      accountId: args.accountId,
      apiKeyId: args.apiKeyId,
      source: session.source,
      externalSessionId: session.label,
      requestId: args.requestId,
      parentRequestId,
      retainCount: delta.retainCount,
      requestDeltaJson: delta.eventsJson,
      requestEnvelopeJson: delta.envelopeJson,
      responseId: args.responseId,
      responseJson: args.responseJson,
      fidelity: fidelity === "partial" ? fidelity : delta.fidelity,
      createdAt: new Date(args.now),
      eventHead: {
        eventKey: delta.eventKey,
        eventCount: delta.eventCount,
        eventHash: delta.eventHash,
      },
    });
    if ((head?.revisionCount ?? 0) + 1 >= PERSISTED_SESSION_MAX_REVISIONS) {
      markSaturatedSession(deps.telemetry, session.ref, defaultMemoryBudget.sessionCacheBytes);
    }
  } catch {
    log("session.capture_failed");
  }
}

export async function queueOrPersistSessionRequest(
  deps: PayloadCaptureDeps & { writes?: WriteQueue },
  args: Parameters<typeof persistSessionRequest>[1],
  log: (msg: string) => void,
): Promise<void> {
  if (Buffer.byteLength(args.requestJson, "utf8") > captureBodyLimitBytes(deps)) {
    log("session.capture_limited");
    return;
  }
  const sessionRef = args.decision.session?.ref;
  if (sessionRef && saturatedSessions(deps.telemetry).has(sessionRef)) {
    log("session.capture_limited");
    return;
  }
  const responseJson =
    args.responseJson !== null &&
    Buffer.byteLength(args.responseJson, "utf8") > captureBodyLimitBytes(deps)
      ? null
      : args.responseJson;
  if (args.responseJson !== null && responseJson === null) log("session.response_limited");
  const boundedArgs = responseJson === args.responseJson ? args : { ...args, responseJson };
  if (deps.writes && sessionCaptureEnabled(deps) && args.decision.session?.label) {
    const generation = deps.captureGeneration?.();
    await deps.writes.enqueueSession(
      () => {
        if (
          generation !== undefined &&
          (deps.captureGeneration?.() !== generation || !sessionCaptureEnabled(deps))
        )
          return Promise.resolve();
        return persistSessionRequest(deps, boundedArgs, log);
      },
      Buffer.byteLength(args.requestJson, "utf8") +
        (responseJson === null ? 0 : Buffer.byteLength(responseJson, "utf8")),
    );
    return;
  }
  await persistSessionRequest(deps, boundedArgs, log);
}

export interface SseCapture {
  push(chunk: string): void;
  /** The retained text: the FULL body when capturing, else a bounded trailing tail. */
  value(): string;
  /** Exact payload body, or null when capture is off / exceeded the runtime budget. */
  payloadValue(): string | null;
  limited(): boolean;
  release(): void;
}

export async function withSseCaptureRelease<T>(
  capture: SseCapture | null,
  bookkeeping: () => Promise<T>,
): Promise<T> {
  try {
    return await bookkeeping();
  } finally {
    capture?.release();
  }
}

let retainedSseCaptureBytes = 0;

// Accumulate forwarded SSE chunks for end-of-stream use (verbatim capture +
// streamed-cost backfill) WITHOUT pinning the whole response in memory when capture
// is off. `full=true` keeps everything (it will be persisted verbatim). `full=false`
// keeps only a bounded trailing tail — enough for usageFromSSE, which scans from the
// END — so a large stream under high concurrency costs O(tail), not O(response). The
// caller always feeds a COPY after writing the chunk downstream, so this never
// touches the bytes forwarded to the client (principle 8).
export function createSseCapture(
  full: boolean,
  tailChars: number = runtimeMemoryBudget().sseTailChars,
  maxFullBytes: number = Math.max(1, Math.floor(runtimeMemoryBudget().responseCaptureBytes / 2)),
  totalCaptureBytes: number = runtimeMemoryBudget().responseCaptureBytes,
): SseCapture {
  const parts: string[] = [];
  const tailLimit = Math.max(0, Math.floor(tailChars));
  const captureLimit = Math.max(0, Math.floor(totalCaptureBytes));
  let tail = "";
  let tailReservation = 0;
  let fullBytes = 0;
  let fullReservation = 0;
  let captureLimited = false;
  let fullValue: string | undefined;
  let released = false;
  const releaseFullReservation = () => {
    retainedSseCaptureBytes -= fullReservation;
    fullReservation = 0;
    fullBytes = 0;
    parts.length = 0;
    fullValue = undefined;
  };
  const releaseTailReservation = () => {
    retainedSseCaptureBytes -= tailReservation;
    tailReservation = 0;
    tail = "";
  };
  const joinedFullValue = () => {
    if (fullValue === undefined) fullValue = parts.join("");
    return fullValue;
  };
  return {
    push(chunk: string): void {
      if (released) return;
      const slicedTail =
        tailLimit === 0
          ? ""
          : chunk.length >= tailLimit
            ? chunk.slice(-tailLimit)
            : `${tail}${chunk}`.slice(-tailLimit);
      // V8 may represent `slice()` as a SlicedString that keeps the entire source
      // chunk alive. Round-trip the bounded suffix through an owned Buffer so the
      // retained JS string has independent backing storage. UTF-16LE preserves exact
      // JS code units even when the character limit lands between a surrogate pair.
      const nextTail =
        slicedTail === "" ? "" : Buffer.from(slicedTail, "utf16le").toString("utf16le");
      // A JS string can retain two bytes per code unit, and replacing/reading the
      // tail can briefly keep both old and new strings alive. Reserve that peak.
      const nextTailReservation = nextTail.length * 4;
      const tailDelta = nextTailReservation - tailReservation;
      if (tailDelta <= 0 || retainedSseCaptureBytes + tailDelta <= captureLimit) {
        retainedSseCaptureBytes += tailDelta;
        tailReservation = nextTailReservation;
        tail = nextTail;
      }
      if (!full || captureLimited) return;
      const nextBytes = Buffer.byteLength(chunk, "utf8");
      const nextReservation = nextBytes * 2;
      if (
        fullBytes + nextBytes > maxFullBytes ||
        retainedSseCaptureBytes + nextReservation > captureLimit
      ) {
        captureLimited = true;
        releaseFullReservation();
        return;
      }
      parts.push(chunk);
      fullBytes += nextBytes;
      fullReservation += nextReservation;
      retainedSseCaptureBytes += nextReservation;
      fullValue = undefined;
    },
    value(): string {
      if (full && !captureLimited) return joinedFullValue();
      return tail;
    },
    payloadValue(): string | null {
      if (!full || captureLimited) return null;
      return joinedFullValue();
    },
    limited(): boolean {
      return captureLimited;
    },
    release(): void {
      if (released) return;
      released = true;
      releaseFullReservation();
      releaseTailReservation();
    },
  };
}

export interface RecordServedDeps extends PayloadCaptureDeps {
  /** Redactor for the decision before it is persisted to telemetry (never store a
   *  plaintext key / secret). Same redactor the chat route uses. */
  redact: (decision: DecisionRecord) => DecisionRecord;
  now: () => number;
  /** Deferred + batched write queue (perf). ABSENT = today's behavior (the
   *  telemetry + payload writes are awaited inline). PRESENT = both are enqueued to
   *  run AFTER the response, batched off the request's critical path. Fail-open
   *  either way. Wired in the composition root for the three pipeline faces. */
  writes?: WriteQueue;
}

export function decisionForTimedOutRequest(decision: DecisionRecord): DecisionRecord {
  if (
    decision.stream_outcome === "truncated" &&
    decision.final.error_reason === CONCURRENCY_LEASE_LOST_REASON
  ) {
    return decision;
  }
  return {
    ...decision,
    final: {
      ...decision.final,
      status: "error",
      error_reason: "timeout",
    },
    serving_account: null,
  };
}

/** Removes the potentially identifying raw client Session ID before telemetry persistence. */
export function redactDecisionForTelemetry(
  redact: (decision: DecisionRecord) => unknown,
  decision: DecisionRecord,
): DecisionRecord {
  const bodyFreeDecision = decision.session
    ? {
        ...decision,
        session: { ref: decision.session.ref, source: decision.session.source },
      }
    : decision;
  return redact(bodyFreeDecision) as DecisionRecord;
}

export function stampRequestBodyBytes(
  decision: DecisionRecord,
  requestJson: string,
  requestBodyBytes = Buffer.byteLength(requestJson, "utf8"),
): DecisionRecord {
  return { ...decision, request_body_bytes: requestBodyBytes };
}

// Record ONE served request: the telemetry row (always — this is what makes the
// request appear in /admin/requests) plus the verbatim request/response payload
// (gated by capture_payloads). Shared by the three pipeline faces (/v1/responses,
// /v1/messages, gemini) so the recording logic can never drift between them again.
// Fully FAIL-OPEN: a telemetry/payload failure must never turn a served response
// into a 5xx or break a stream.
export async function recordServed(
  deps: RecordServedDeps,
  args: {
    requestId: string;
    accountId?: string;
    apiKeyId: string;
    decision: DecisionRecord;
    requestJson: string;
    requestBodyBytes?: number;
    responseJson: string | null;
    timedOut?: boolean;
    // The exact body forwarded upstream (post inject + translation); null when no
    // provider served or capture context lacks it.
    upstreamRequestJson?: string | null;
  },
  log: (msg: string) => void,
): Promise<void> {
  // Enforce the ownership join key at this shared persistence boundary. Route
  // pipelines may carry a separate client trace_id for response/log correlation,
  // but telemetry.request_id and request_payloads.request_id must always use the
  // server-generated context request_id passed in args.
  const storageDecision: DecisionRecord = {
    ...stampRequestBodyBytes(args.decision, args.requestJson, args.requestBodyBytes),
    request_id: args.requestId,
  };
  const decision =
    args.timedOut === true ? decisionForTimedOutRequest(storageDecision) : storageDecision;
  const responseJson = args.timedOut === true ? null : args.responseJson;
  const sessionResponse =
    decision.protocol === "openai_responses"
      ? capturedResponsesResponse(decision.protocol, responseJson)
      : { responseId: null, responseJson };
  const sessionArgs = {
    requestId: args.requestId,
    accountId: args.accountId ?? args.apiKeyId,
    apiKeyId: args.apiKeyId,
    decision,
    requestJson: args.requestJson,
    responseId: sessionResponse.responseId,
    responseJson: sessionResponse.responseJson,
    now: deps.now(),
  };
  // Deferred + batched path: enqueue both writes to run AFTER the response, off the
  // hot path. The redaction is done HERE (synchronously) so the enqueued snapshot is
  // independent of anything that touches the decision later.
  const w = deps.writes;
  if (w !== undefined) {
    await w.enqueueTelemetry({
      decision: redactDecisionForTelemetry(deps.redact, decision),
      apiKeyId: args.apiKeyId,
      createdAt: new Date(deps.now()),
    });
    await queueOrPersistSessionRequest(deps, sessionArgs, log);
    if (captureEnabled(deps)) {
      const generation = deps.captureGeneration?.();
      await w.enqueuePayload(
        {
          requestId: args.requestId,
          requestJson: args.requestJson,
          responseJson,
          upstreamRequestJson: args.upstreamRequestJson ?? null,
          createdAt: new Date(deps.now()),
        },
        generation === undefined
          ? undefined
          : () => deps.captureGeneration?.() === generation && captureEnabled(deps),
      );
      // Retention is NOT pruned on the request path — the scheduled cleanup runner
      // owns payload retention (archive-first), governed by the cleanup settings.
    }
    return;
  }

  // Inline path (no write queue): today's behavior, byte-for-byte.
  await queueOrPersistSessionRequest(deps, sessionArgs, log);
  await persistPayload(
    deps,
    {
      requestId: args.requestId,
      requestJson: args.requestJson,
      responseJson,
      upstreamRequestJson: args.upstreamRequestJson ?? null,
      now: deps.now(),
    },
    log,
  );
  try {
    await deps.telemetry.insert({
      decision: redactDecisionForTelemetry(deps.redact, decision),
      apiKeyId: args.apiKeyId,
      createdAt: new Date(deps.now()),
    });
  } catch {
    log("telemetry.insert_failed");
  }
}

// Total served tokens (prompt + completion) from an OpenAI-style usage object, for
// the per-key token budget (docs/06). Tolerant of a missing/partial usage: a field
// absent counts as 0. Used by every face's post-served budget settle — the usage
// always rides the UPSTREAM OpenAI stream/body, so one extractor serves all.
export function tokensFromUsage(usage: StreamUsage | null | undefined): number {
  if (!usage) return 0;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const anthropicSeparateCache =
    usage.prompt_tokens === undefined && usage.input_tokens !== undefined
      ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : 0;
  return prompt + completion + anthropicSeparateCache;
}

// Extract the OpenAI `usage` object from a NON-streaming response body (the
// assembled chat.completion / equivalent). Mirrors usageFromSSE for the buffered
// path. null when the body has no usage object.
export function usageFromBody(body: unknown): StreamUsage | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (usage && typeof usage === "object") return usage as StreamUsage;
  return null;
}

// Native-protocol-passthrough cost (#217 C-cost): normalize a VERBATIM Anthropic
// non-stream response's usage block into the OpenAI-shaped StreamUsage the gateway's
// costOf/resolveCostUsd already understand. The token math MIRRORS core's
// anthropicToOpenAIResponse (anthropic.ts: prompt = input_tokens + cache_read +
// cache_creation; completion = output_tokens; prompt_tokens_details carries the
// cached/cache_creation split) so a passthrough attempt is priced identically to a
// translated one. Missing token counts stay absent so metadata-only usage remains
// unmeasured; null when the body carries no usage object at all.
export function usageFromAnthropicResponse(body: unknown): StreamUsage | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inTok = count(u.input_tokens);
  const outTok = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  const cacheCreationDetails =
    u.cache_creation && typeof u.cache_creation === "object"
      ? (u.cache_creation as Record<string, unknown>)
      : undefined;
  const cacheCreation5m = count(cacheCreationDetails?.ephemeral_5m_input_tokens);
  const cacheCreation1h = count(cacheCreationDetails?.ephemeral_1h_input_tokens);
  const cacheCreation =
    count(u.cache_creation_input_tokens) ??
    (cacheCreation5m !== undefined || cacheCreation1h !== undefined
      ? (cacheCreation5m ?? 0) + (cacheCreation1h ?? 0)
      : undefined);
  const promptTokens =
    inTok !== undefined || cacheRead !== undefined || cacheCreation !== undefined
      ? (inTok ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
      : undefined;
  const normalized: StreamUsage = {
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(outTok !== undefined ? { completion_tokens: outTok } : {}),
    ...(promptTokens !== undefined || outTok !== undefined
      ? { total_tokens: (promptTokens ?? 0) + (outTok ?? 0) }
      : {}),
    ...(typeof u.speed === "string" ? { service_tier: u.speed } : {}),
    ...(typeof u.inference_geo === "string" ? { inference_geo: u.inference_geo } : {}),
  };
  if (cacheRead !== undefined || cacheCreation !== undefined) {
    normalized.prompt_tokens_details = {
      cached_tokens: cacheRead ?? 0,
      ...(cacheCreation !== undefined ? { cache_creation_tokens: cacheCreation } : {}),
      ...(cacheCreation5m !== undefined ? { ephemeral_5m_input_tokens: cacheCreation5m } : {}),
      ...(cacheCreation1h !== undefined ? { ephemeral_1h_input_tokens: cacheCreation1h } : {}),
    };
  }
  return normalized;
}

// Native-protocol-passthrough cost for openai_responses (#217 Phase 3): normalize a
// VERBATIM Codex Responses NON-stream response's usage block into the OpenAI-shaped
// StreamUsage the gateway's costOf/resolveCostUsd already understand. The token math
// MIRRORS core's aggregateResponsesStream (openai-responses.ts): Responses already
// COUNTS the cache hit INSIDE input_tokens (unlike Anthropic, where cache is separate),
// so prompt_tokens = input_tokens directly; completion_tokens = output_tokens; the
// cache split (cached_tokens / cache_creation_input_tokens) rides input_tokens_details
// and is surfaced under prompt_tokens_details for the dashboard. Missing token counts
// stay absent so metadata-only usage remains unmeasured; null when the body carries no
// usage object at all.
export function usageFromResponsesResponse(body: unknown): StreamUsage | null {
  const response = body as { usage?: unknown; service_tier?: unknown } | null;
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  return normalizeResponsesUsage(
    usage as Record<string, unknown>,
    typeof response?.service_tier === "string" ? response.service_tier : undefined,
  );
}

// Shared Responses-usage normalization for the non-stream body and the terminal SSE
// event (both carry the identical `usage` shape). Cache is already included in
// input_tokens, so the budget total is simply prompt + completion.
function normalizeResponsesUsage(u: Record<string, unknown>, serviceTier?: string): StreamUsage {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inTok = count(u.input_tokens);
  const outTok = count(u.output_tokens);
  const details = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead = count(details.cached_tokens);
  const cacheCreation =
    count(details.cache_write_tokens) ??
    count(details.cache_creation_tokens) ??
    count(details.cache_creation_input_tokens);
  const cacheCreation5m = count(details.ephemeral_5m_input_tokens);
  const cacheCreation1h = count(details.ephemeral_1h_input_tokens);
  const audioPrompt = count(details.audio_tokens);
  const cachedAudioPrompt = count(details.cached_audio_tokens);
  const outputDetails =
    u.output_tokens_details && typeof u.output_tokens_details === "object"
      ? (u.output_tokens_details as Record<string, unknown>)
      : undefined;
  const imageOutput = count(outputDetails?.image_tokens);
  const billedCost = count(u.cost);
  const billedCostUsd = count(u.cost_usd);
  const normalized: StreamUsage = {
    ...(inTok !== undefined ? { prompt_tokens: inTok } : {}),
    ...(outTok !== undefined ? { completion_tokens: outTok } : {}),
    ...(inTok !== undefined || outTok !== undefined
      ? { total_tokens: (inTok ?? 0) + (outTok ?? 0) }
      : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
    ...(billedCost !== undefined ? { cost: billedCost } : {}),
    ...(billedCostUsd !== undefined ? { cost_usd: billedCostUsd } : {}),
  };
  if (
    cacheRead !== undefined ||
    cacheCreation !== undefined ||
    cacheCreation5m !== undefined ||
    cacheCreation1h !== undefined ||
    audioPrompt !== undefined ||
    cachedAudioPrompt !== undefined
  ) {
    normalized.prompt_tokens_details = {
      cached_tokens: cacheRead ?? 0,
      ...(cacheCreation !== undefined ? { cache_creation_tokens: cacheCreation } : {}),
      ...(cacheCreation5m !== undefined ? { ephemeral_5m_input_tokens: cacheCreation5m } : {}),
      ...(cacheCreation1h !== undefined ? { ephemeral_1h_input_tokens: cacheCreation1h } : {}),
      ...(audioPrompt !== undefined ? { audio_tokens: audioPrompt } : {}),
      ...(cachedAudioPrompt !== undefined ? { cached_audio_tokens: cachedAudioPrompt } : {}),
    };
  }
  if (imageOutput !== undefined) {
    normalized.completion_tokens_details = { image_tokens: imageOutput };
  }
  return normalized;
}

// Native-protocol-passthrough cost for Gemini (P2-GEM-01 governance): normalize a
// VERBATIM Gemini GenerateContent NON-stream response's `usageMetadata` into the
// OpenAI-shaped StreamUsage the gateway's costOf/resolveCostUsd already understand.
// Token math MIRRORS core's gemini transformResponseIn: Gemini's promptTokenCount
// ALREADY INCLUDES the cached slice (like Responses, unlike Anthropic), so
// prompt_tokens = promptTokenCount and the cache rides prompt_tokens_details;
// thoughtsTokenCount (reasoning) is billed as output, so it folds into
// completion_tokens. Missing token counts stay absent so metadata-only usage remains
// unmeasured; null when the body carries no usageMetadata object at all.
export function usageFromGeminiResponse(body: unknown): StreamUsage | null {
  const um = (body as { usageMetadata?: unknown } | null)?.usageMetadata;
  if (!um || typeof um !== "object") return null;
  return normalizeGeminiUsage(um as Record<string, unknown>);
}

// Shared Gemini-usage normalization for the non-stream body and the streamed
// cumulative usageMetadata (identical shape). Cache is already included in
// promptTokenCount, so the budget total is simply prompt + completion.
function normalizeGeminiUsage(um: Record<string, unknown>): StreamUsage {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const prompt = count(um.promptTokenCount);
  const candidates = count(um.candidatesTokenCount);
  const thoughts = count(um.thoughtsTokenCount);
  const cached = count(um.cachedContentTokenCount);
  const completion =
    candidates !== undefined || thoughts !== undefined
      ? (candidates ?? 0) + (thoughts ?? 0)
      : undefined;
  const modalityDetails = (details: unknown): Record<string, number> | undefined => {
    if (!Array.isArray(details)) return undefined;
    const out: Record<string, number> = {};
    for (const item of details) {
      if (!item || typeof item !== "object") continue;
      const row = item as { modality?: unknown; tokenCount?: unknown };
      if (typeof row.modality !== "string" || typeof row.tokenCount !== "number") continue;
      if (!Number.isFinite(row.tokenCount) || row.tokenCount < 0) continue;
      const key = `${row.modality.toLowerCase()}_tokens`;
      out[key] = (out[key] ?? 0) + row.tokenCount;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const promptModalities = modalityDetails(um.promptTokensDetails);
  const cacheModalities = modalityDetails(um.cacheTokensDetails);
  const candidateModalities = modalityDetails(um.candidatesTokensDetails);
  const promptAudio =
    promptModalities !== undefined ? (promptModalities.audio_tokens ?? 0) : undefined;
  const cachedAudio =
    cacheModalities !== undefined ? (cacheModalities.audio_tokens ?? 0) : undefined;
  const normalized: StreamUsage = {
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    ...(prompt !== undefined || completion !== undefined
      ? { total_tokens: (prompt ?? 0) + (completion ?? 0) }
      : {}),
    ...(typeof um.serviceTier === "string" ? { service_tier: um.serviceTier } : {}),
  };
  if (cached !== undefined || promptModalities !== undefined || cacheModalities !== undefined) {
    normalized.prompt_tokens_details = {
      ...(cached !== undefined ? { cached_tokens: cached } : {}),
      ...(promptModalities ?? {}),
      ...(promptAudio !== undefined ? { audio_tokens: promptAudio } : {}),
      ...(cachedAudio !== undefined ? { cached_audio_tokens: cachedAudio } : {}),
    };
  }
  if (candidateModalities !== undefined) {
    normalized.completion_tokens_details = {
      ...candidateModalities,
      image_tokens: candidateModalities.image_tokens ?? 0,
    };
  }
  return normalized;
}

// Native-protocol-passthrough STREAMING cost for Gemini. The streamGenerateContent
// SSE emits nameless `data:` frames carrying CUMULATIVE `usageMetadata` (the final
// frame holds the complete count), so cost extraction scans the accumulated SSE and
// keeps the LAST usageMetadata seen. Frames split on the SSE record separator (\n\n);
// the `data:` line is read with a tolerant JSON.parse so keepalive / `[DONE]` / non-
// JSON lines are skipped. null when no usageMetadata frame is present.
export function usageFromGeminiSSE(raw: string): StreamUsage | null {
  let last: StreamUsage | null = null;
  for (const frame of raw.split("\n\n")) {
    let payload: string | null = null;
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        payload = trimmed.slice("data:".length).trim();
        break;
      }
    }
    if (payload === null || payload === "" || payload === "[DONE]") continue;
    let evt: { usageMetadata?: unknown };
    try {
      evt = JSON.parse(payload);
    } catch {
      // ping / keepalive / non-JSON line — ignore
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    const um = evt.usageMetadata;
    if (um && typeof um === "object") last = normalizeGeminiUsage(um as Record<string, unknown>);
  }
  return last;
}

// Native-protocol-passthrough STREAMING cost for openai_responses (#217 Phase 3).
// Unlike Anthropic (usage split across message_start/message_delta), the Codex
// Responses SSE carries the totals on a TERMINAL event — `response.completed`,
// `response.incomplete`, or `response.failed` — under `response.usage`. The
// byte-faithful passthrough forwards these frames VERBATIM, so cost extraction scans
// the accumulated SSE for that event and normalizes its usage the SAME way as the
// non-stream extractor (mirroring aggregateResponsesStream). Frames are split on the
// SSE record separator (\n\n); the `data:` line is read with a tolerant JSON.parse so
// ping / keepalive / `[DONE]` / non-JSON lines are skipped. null when no terminal
// usage-bearing event is present.
export function usageFromResponsesSSE(raw: string): StreamUsage | null {
  for (const frame of raw.split("\n\n")) {
    // Each frame may have multiple lines (event:/data:); read the data line only.
    let payload: string | null = null;
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        payload = trimmed.slice("data:".length).trim();
        break;
      }
    }
    if (payload === null || payload === "" || payload === "[DONE]") continue;
    let evt: { type?: unknown; response?: unknown };
    try {
      evt = JSON.parse(payload);
    } catch {
      // ping / keepalive / non-JSON line — ignore
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    if (
      evt.type !== "response.completed" &&
      evt.type !== "response.incomplete" &&
      evt.type !== "response.failed"
    ) {
      continue;
    }
    const response = (evt.response ?? {}) as Record<string, unknown>;
    const usage = response.usage;
    if (!usage || typeof usage !== "object") continue;
    return normalizeResponsesUsage(
      usage as Record<string, unknown>,
      typeof response.service_tier === "string" ? response.service_tier : undefined,
    );
  }
  return null;
}

// Persist the verbatim request/response bodies + opportunistically prune expired
// rows. Never throws — logs via the provided sink on failure.
export async function persistPayload(
  deps: PayloadCaptureDeps,
  args: {
    requestId: string;
    requestJson: string;
    responseJson: string | null;
    upstreamRequestJson?: string | null;
    now: number;
  },
  log: (msg: string) => void,
): Promise<void> {
  if (!captureEnabled(deps)) return;
  try {
    await deps.telemetry.insertPayload({
      requestId: args.requestId,
      requestJson: args.requestJson,
      responseJson: args.responseJson,
      upstreamRequestJson: args.upstreamRequestJson ?? null,
      createdAt: new Date(args.now),
    });
    // Retention is owned by the scheduled cleanup runner (archive-first), not the
    // request path — so capture never deletes bodies behind the cleanup settings.
  } catch {
    log("payload.capture_failed");
  }
}

// Extract the OpenAI `usage` object from accumulated streaming SSE text. With
// `stream_options.include_usage` the upstream emits a final `data:` chunk that
// carries a top-level `usage`. Scan data lines last-to-first and return the first
// one that has it; null if the stream never reported usage. Non-JSON keepalive
// lines are skipped.
export function usageFromSSE(raw: string): StreamUsage | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as { usage?: unknown; service_tier?: unknown };
      if (obj && typeof obj === "object" && obj.usage && typeof obj.usage === "object") {
        return {
          ...(obj.usage as StreamUsage),
          ...(typeof obj.service_tier === "string" ? { service_tier: obj.service_tier } : {}),
        };
      }
    } catch {
      // keepalive / non-JSON line — ignore
    }
  }
  return null;
}

// Native-protocol-passthrough STREAMING cost (#217 Phase 2). Unlike OpenAI's single
// trailing usage chunk, the Anthropic SSE carries usage SPLIT across events:
//   - `message_start` → message.usage.input_tokens (+ cache_read / cache_creation)
//   - the LAST `message_delta` → usage.output_tokens (Anthropic may RESTATE cache_*)
// Byte-faithful passthrough forwards these frames verbatim, so cost extraction scans
// the accumulated SSE itself. The accumulation MIRRORS core's translateAnthropicSSE
// (anthropic.ts: input/cache on message_start, output on message_delta, cache_* via
// max). Returns an Anthropic-shaped StreamUsage — tokensFromUsage already sums it
// (input + output + cache_read + cache_creation). null when no usage event is present.
export function usageFromAnthropicSSE(raw: string): StreamUsage | null {
  let seenUsage = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let cacheCreation5m = 0;
  let cacheCreation1h = 0;
  let speed: string | undefined;
  let inferenceGeo: string | undefined;
  for (const frame of raw.split("\n\n")) {
    // Each frame may have multiple lines (event:/data:); read the data line only.
    let payload: string | null = null;
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        payload = trimmed.slice("data:".length).trim();
        break;
      }
    }
    if (payload === null || payload === "" || payload === "[DONE]") continue;
    let evt: { type?: unknown; message?: unknown; usage?: unknown };
    try {
      evt = JSON.parse(payload);
    } catch {
      // ping / keepalive / non-JSON line — ignore
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    if (evt.type === "message_start") {
      const u = ((evt.message as { usage?: unknown } | undefined)?.usage ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof u.speed === "string") speed = u.speed;
      if (typeof u.inference_geo === "string") inferenceGeo = u.inference_geo;
      if (typeof u.input_tokens === "number") {
        input = u.input_tokens;
        seenUsage = true;
      }
      if (typeof u.cache_read_input_tokens === "number") {
        cacheRead = u.cache_read_input_tokens;
        seenUsage = true;
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        cacheCreation = u.cache_creation_input_tokens;
        seenUsage = true;
      }
      const creation =
        u.cache_creation && typeof u.cache_creation === "object"
          ? (u.cache_creation as Record<string, unknown>)
          : undefined;
      if (typeof creation?.ephemeral_5m_input_tokens === "number") {
        cacheCreation5m = creation.ephemeral_5m_input_tokens;
        seenUsage = true;
      }
      if (typeof creation?.ephemeral_1h_input_tokens === "number") {
        cacheCreation1h = creation.ephemeral_1h_input_tokens;
        seenUsage = true;
      }
    } else if (evt.type === "message_delta") {
      const u = (evt.usage ?? {}) as Record<string, unknown>;
      if (typeof u.speed === "string") speed = u.speed;
      if (typeof u.inference_geo === "string") inferenceGeo = u.inference_geo;
      if (typeof u.output_tokens === "number") {
        output = Math.max(output, u.output_tokens);
        seenUsage = true;
      }
      if (typeof u.cache_read_input_tokens === "number") {
        cacheRead = Math.max(cacheRead, u.cache_read_input_tokens);
        seenUsage = true;
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        cacheCreation = Math.max(cacheCreation, u.cache_creation_input_tokens);
        seenUsage = true;
      }
      const creation =
        u.cache_creation && typeof u.cache_creation === "object"
          ? (u.cache_creation as Record<string, unknown>)
          : undefined;
      if (typeof creation?.ephemeral_5m_input_tokens === "number") {
        cacheCreation5m = Math.max(cacheCreation5m, creation.ephemeral_5m_input_tokens);
        seenUsage = true;
      }
      if (typeof creation?.ephemeral_1h_input_tokens === "number") {
        cacheCreation1h = Math.max(cacheCreation1h, creation.ephemeral_1h_input_tokens);
        seenUsage = true;
      }
    }
  }
  if (!seenUsage) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    ...(speed !== undefined ? { service_tier: speed } : {}),
    ...(inferenceGeo !== undefined ? { inference_geo: inferenceGeo } : {}),
    ...(cacheCreation5m > 0 || cacheCreation1h > 0
      ? {
          prompt_tokens_details: {
            ...(cacheCreation5m > 0 ? { ephemeral_5m_input_tokens: cacheCreation5m } : {}),
            ...(cacheCreation1h > 0 ? { ephemeral_1h_input_tokens: cacheCreation1h } : {}),
          },
        }
      : {}),
  };
}

// Map the served upstream usage tail to the DecisionRecord token block (dashboard
// token accounting). Reuses CORE's usageFromBody — the single source of truth for
// the OpenAI/Anthropic cache-field precedence — so the gateway never re-implements
// that parsing (its LOCAL usageFromBody only unwraps the raw usage object). Each
// leaf is null when not reported, kept DISTINCT from a measured 0.
export function tokenBreakdownFromUsage(
  u: StreamUsage | Record<string, unknown>,
): TokenUsageBreakdown {
  const t = parseUsage({ usage: u });
  return {
    measurement: u.measurement === "estimated_partial" ? "estimated_partial" : "reported",
    cost_basis:
      u.cost_basis === "catalog_api_equivalent_estimate" ? "catalog_api_equivalent_estimate" : null,
    prompt_tokens: t.promptTokens ?? null,
    completion_tokens: t.completionTokens ?? null,
    cached_tokens: t.cachedPromptTokens ?? null,
    cache_creation_tokens: t.cacheCreationPromptTokens ?? null,
    service_tier: t.serviceTier ?? null,
    inference_geo: t.inferenceGeo ?? null,
    cache_creation_5m_tokens: t.cacheCreation5mPromptTokens ?? null,
    cache_creation_1h_tokens: t.cacheCreation1hPromptTokens ?? null,
    audio_prompt_tokens: t.audioPromptTokens ?? null,
    cached_audio_prompt_tokens: t.cachedAudioPromptTokens ?? null,
    image_output_tokens: t.imageOutputTokens ?? null,
    billed_cost_usd: billedCostFromBody({ usage: u }),
  };
}

// Wall-clock generation-window timer for a SERVED stream: the true-TPS denominator.
// The route calls `mark()` once per FORWARDED chunk (first chunk → last chunk); the
// window is last − first. A single mark (or all marks at one instant) has no span →
// null, kept DISTINCT from a measured value so TPS renders "—" rather than dividing
// by zero. The clock is injected for determinism (tests; mirrors recordServed.now).
// Cheap + allocation-free per chunk: two numbers and a comparison.
export interface StreamGenerationTimer {
  /** Record that a chunk was forwarded to the client at `now()`. */
  mark(): void;
  /** Span from the first to the last marked chunk (ms); null when < 2 distinct instants. */
  generationMs(): number | null;
}

export function createStreamGenerationTimer(now: () => number): StreamGenerationTimer {
  let first: number | null = null;
  let last: number | null = null;
  return {
    mark(): void {
      const t = now();
      if (first === null) first = t;
      last = t;
    },
    generationMs(): number | null {
      if (first === null || last === null || last <= first) return null;
      return last - first;
    },
  };
}

// Backfill the streamed completion cost AND the served token counts onto the
// decision record IN PLACE (#6: streamed usage is unknown at peek time, so
// execute() recorded cost null). The three stamps are DECOUPLED: the token stamp
// rides `usage` and needs no pricing, so it lands whenever a usage tail is present
// (dashboard accounting must work even when pricing is unwired); the cost stamp is
// a no-op when `cost` is null (pricing unknown) — the record keeps its honest
// "not measured" null rather than a misleading 0; the generation-window stamp
// (`generationMs`, true-TPS denominator) lands only on the streaming path that
// measured one. Pass null cost + a usage tail to stamp tokens only (non-stream
// paths, where execute() already settled the cost and there is no stream window).
export function backfillCompletionCost(
  decision: DecisionRecord,
  alias: string | null,
  cost: number | null,
  usage?: StreamUsage | null,
  generationMs?: number | null,
): void {
  if (usage) decision.usage = tokenBreakdownFromUsage(usage);
  // Streaming generation window (true TPS = completion_tokens / (generation_ms/1000)).
  // `!= null` skips both undefined (non-stream callers) and null (no measurable span),
  // leaving the record's honest null.
  if (generationMs != null) decision.generation_ms = generationMs;
  if (cost === null) return;
  if (alias) {
    for (const a of decision.provider_attempts) {
      if (a.alias === alias && a.status === "ok") a.cost_usd = cost;
    }
  }
  const evalUsd = decision.cost_breakdown.eval_usd;
  decision.cost_breakdown.completion_usd = cost;
  decision.cost_breakdown.total_usd = (evalUsd ?? 0) + cost;
}
