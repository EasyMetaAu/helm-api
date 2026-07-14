import type { DecisionRecord, TelemetryStore } from "@helm/core";
import { billedCostFromBody, usageFromBody as parseUsage } from "@helm/core";
import type { TokenUsageBreakdown } from "@helm/shared";
import type { WriteQueue } from "../runtime/write-queue.js";

// Shared full request/response capture + streamed-cost backfill helpers, used by
// BOTH the OpenAI (chat.ts) and Anthropic (messages-pipeline.ts) routes.
//
// Capture is gated by the runtime setting `capture_payloads` (admin "System
// Settings", default ON). When off, nothing is written. The stored bodies are
// VERBATIM (not redacted) — they carry no plaintext API key because the bearer
// lives in the request's Authorization header, never in the chat body.
//
// Everything here is FAIL-OPEN: a capture or cost-backfill failure must never
// turn a served request into a 5xx or break an in-flight stream.

export interface PayloadCaptureDeps {
  telemetry: TelemetryStore;
  /** Live getter for the capture_payloads runtime setting. */
  capturePayloads?: () => boolean;
  /** Resolve the served attempt's USD cost from the trailing usage chunk: an
   *  upstream-BILLED cost in it (`cost_usd` / OpenRouter `cost`) OVERRIDES the
   *  catalog estimate, else tokens × `alias`'s pricing; null when neither is
   *  available. Closed over the catalog + resolveCostUsd in the composition root. */
  costOf?: (alias: string, usage: StreamUsage) => number | null;
}

export interface StreamUsage {
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

export function captureEnabled(deps: PayloadCaptureDeps): boolean {
  return deps.capturePayloads?.() === true;
}

// Default retained-tail size (chars) when NOT persisting the body. The trailing
// usage frame (include_usage) is tiny and always last, so a few KB is ample for
// usageFromSSE; this caps per-stream memory instead of pinning the whole response.
const SSE_TAIL_CHARS = 16_384;

export interface SseCapture {
  push(chunk: string): void;
  /** The retained text: the FULL body when capturing, else a bounded trailing tail. */
  value(): string;
}

// Accumulate forwarded SSE chunks for end-of-stream use (verbatim capture +
// streamed-cost backfill) WITHOUT pinning the whole response in memory when capture
// is off. `full=true` keeps everything (it will be persisted verbatim). `full=false`
// keeps only a bounded trailing tail — enough for usageFromSSE, which scans from the
// END — so a large stream under high concurrency costs O(tail), not O(response). The
// caller always feeds a COPY after writing the chunk downstream, so this never
// touches the bytes forwarded to the client (principle 8).
export function createSseCapture(full: boolean, tailChars: number = SSE_TAIL_CHARS): SseCapture {
  const parts: string[] = [];
  let size = 0;
  return {
    push(chunk: string): void {
      parts.push(chunk);
      if (full) return;
      size += chunk.length;
      // Drop oldest parts while over budget, but always retain at least the last one.
      while (size > tailChars && parts.length > 1) {
        const dropped = parts.shift();
        if (dropped !== undefined) size -= dropped.length;
      }
    },
    value(): string {
      return parts.join("");
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
    apiKeyId: string;
    decision: DecisionRecord;
    requestJson: string;
    responseJson: string | null;
    timedOut?: boolean;
    // The exact body forwarded upstream (post inject + translation); null when no
    // provider served or capture context lacks it.
    upstreamRequestJson?: string | null;
  },
  log: (msg: string) => void,
): Promise<void> {
  const decision =
    args.timedOut === true ? decisionForTimedOutRequest(args.decision) : args.decision;
  const responseJson = args.timedOut === true ? null : args.responseJson;
  // Deferred + batched path: enqueue both writes to run AFTER the response, off the
  // hot path. The redaction is done HERE (synchronously) so the enqueued snapshot is
  // independent of anything that touches the decision later.
  const w = deps.writes;
  if (w !== undefined) {
    if (captureEnabled(deps)) {
      w.enqueuePayload({
        requestId: args.requestId,
        requestJson: args.requestJson,
        responseJson,
        upstreamRequestJson: args.upstreamRequestJson ?? null,
        createdAt: new Date(deps.now()),
      });
      // Retention is NOT pruned on the request path — the scheduled cleanup runner
      // owns payload retention (archive-first), governed by the cleanup settings.
    }
    w.enqueueTelemetry({
      decision: deps.redact(decision),
      apiKeyId: args.apiKeyId,
      createdAt: new Date(deps.now()),
    });
    return;
  }

  // Inline path (no write queue): today's behavior, byte-for-byte.
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
      decision: deps.redact(decision),
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
// Responses SSE carries the totals on the TERMINAL event — `response.completed` or
// `response.incomplete` (truncation / content filter) — under `response.usage`. The
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
    if (evt.type !== "response.completed" && evt.type !== "response.incomplete") continue;
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
