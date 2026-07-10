import { randomUUID } from "node:crypto";
import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  type DecisionRecord,
  type RateLimitProbe,
  type RateLimitResult,
  UpstreamError,
} from "@helm/core";
import {
  cloneCarrierWithBody,
  type ErrorClass,
  ErrorClassSchema,
  makeHelmError,
  type NativePassthroughCarrier,
} from "@helm/shared";

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { requestSignal, requestTimedOut } from "../middleware/limits.js";
import { normalizeOpenAICodexClientVersion } from "../oauth/codex-client-version.js";
import { CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER } from "../responses-websocket-internal.js";
import { stampServingAccount } from "../runtime/serving-account.js";
import { atEventBoundary, HEARTBEAT_COMMENT, withHeartbeat } from "./heartbeat.js";
import { resolveMemoryScope } from "./memory-scope.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import { nativeCarrierFromParsedBody } from "./native-carrier.js";
import {
  captureEnabled,
  type RecordServedDeps,
  recordServed,
  type StreamUsage,
  tokensFromUsage,
  usageFromResponsesResponse,
} from "./payload-capture.js";
import { isUpstreamTimeout } from "./stream-error.js";

// POST /v1/responses — OpenAI Responses API inbound, translated to IR, routed
// through the SAME core pipeline as /v1/chat and /v1/messages, then translated
// back to the native Responses shape (docs/05, protocol.responses).
//
// PURE HTTP ↔ IR glue (CLAUDE.md principle 1): auth → translate(out) → route →
// translate(back). Responses is an OpenAI surface, so errors use the OpenAI error
// envelope (a thrown HelmHttpError handled by the global onError) — identical to
// /v1/chat, NOT the Anthropic envelope.
//
// Streaming: a `stream:true` request is served as `text/event-stream`, emitting
// the native Responses `response.*` event sequence (the pipeline runs the second
// IR→SSE state machine, stamped openai_responses). Errors in the stream use the
// OpenAI error envelope written DIRECTLY into the SSE stream — once the stream has
// started we can no longer throw to onError, so the serializable envelope body is
// written as a terminal `event: error` frame (docs/05, docs/07).

interface ResponsesIRLike {
  stream?: boolean;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Per-key rate limiter (core, framework-agnostic). Same instance the OpenAI chat
 *  middleware uses; injected so the self-authenticating Responses route meters the
 *  resolved key AFTER auth (closing the rate-limit bypass on /v1/responses).
 *  Optional — omitted = no metering. */
export interface ResponsesRateLimiterPort {
  check(probe: RateLimitProbe): Promise<RateLimitResult>;
}

export interface ResponsesLifecyclePort {
  retrieve?(
    responseId: string,
    identity: MessagesIdentity,
    signal: AbortSignal,
    record?: ResponsesRegistryRecord,
  ): Promise<unknown>;
  delete?(
    responseId: string,
    identity: MessagesIdentity,
    signal: AbortSignal,
    record?: ResponsesRegistryRecord,
  ): Promise<unknown>;
  cancel?(
    responseId: string,
    identity: MessagesIdentity,
    signal: AbortSignal,
    record?: ResponsesRegistryRecord,
  ): Promise<unknown>;
  inputItems?(
    responseId: string,
    identity: MessagesIdentity,
    signal: AbortSignal,
    record?: ResponsesRegistryRecord,
  ): Promise<unknown>;
  compact?(
    body: NativePassthroughCarrier,
    identity: MessagesIdentity,
    signal: AbortSignal,
    onResponseMeta?: (headers: Headers) => void,
    onExecution?: (execution: ResponsesCompactExecution) => void,
  ): Promise<unknown>;
  inputTokens?(body: unknown, identity: MessagesIdentity, signal: AbortSignal): Promise<unknown>;
}

export interface ResponsesCompactExecution {
  modelAlias: string;
  providerModel: string;
  providerName: string;
  upstreamRequest: string | null;
  servingAccount: { providerId: string; account: string } | null;
}

export interface ResponsesBudgetPort {
  gate: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settle(
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ): Promise<void>;
  costOf?: (
    alias: string,
    usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    },
  ) => number | null;
  now(): number;
}

export interface ResponsesRegistryRecord {
  responseId: string;
  accountId: string;
  keyId: string;
  providerAlias: string | null;
  providerName: string | null;
  providerModel: string | null;
  providerProtocol: "openai_chat" | "anthropic_messages" | "openai_responses" | "gemini" | null;
  createdAt: number;
  expiresAt: number;
  status: string;
}

export interface ResponsesRegistryPort {
  put(record: ResponsesRegistryRecord): void | Promise<void>;
  get(
    responseId: string,
    identity: MessagesIdentity,
  ): ResponsesRegistryRecord | null | Promise<ResponsesRegistryRecord | null>;
}

export interface ResponsesRouteDeps {
  rateLimiter?: ResponsesRateLimiterPort;
  /** Per-key concurrency overflow queue (issue #93) — the SAME process-wide gate
   *  as the chat middleware. Optional — omitted = no gating. */
  concurrencyGate?: ConcurrencyGatePort;
  /** Telemetry + payload recorder (the /admin/requests fix). Optional so existing
   *  tests that omit it record nothing; when wired, every served request (success
   *  OR failure, stream OR non-stream) writes a telemetry row. */
  record?: RecordServedDeps;
  /** Optional provider-backed Responses lifecycle facade. Missing methods mean
   *  unsupported capability, except input_tokens which can be locally estimated. */
  lifecycle?: ResponsesLifecyclePort;
  /** Direct compact does not enter the shared routing pipeline, so it receives the
   *  same pre-route budget gate and post-served settlement explicitly. */
  budget?: ResponsesBudgetPort;
  /** Per-account subscription usage attribution for direct compact execution. */
  recordOAuthUsage?: (
    servingAccount: { providerId: string; account: string } | null,
    servedAlias: string | null,
    usage: { tokens: number; costUsd: number | null },
  ) => void;
  /** Optional response object registry. When present, lifecycle methods first
   *  prove the response id belongs to the calling key/account and can dispatch to
   *  the provider that created it instead of the first global capable provider. */
  registry?: ResponsesRegistryPort;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  transformer: {
    /** native Responses request → IR (throws on a structurally invalid body). */
    transformRequestOut(native: unknown): ResponsesIRLike;
    /** IR response → native Responses response. */
    transformResponseOut(ir: unknown): unknown;
    /** ONE IR stream event → ONE Responses SSE frame (event/data pair). The
     *  pipeline already produced the response.* events; this only serializes. */
    transformStreamOut(event: Record<string, unknown>): {
      event: string;
      data: string;
    };
  };
  pipeline: {
    run(
      ir: ResponsesIRLike,
      identity: MessagesIdentity,
      signal: AbortSignal,
    ): Promise<PipelineRunResult>;
  };
  /** SSE keep-alive cadence (ms) for streaming responses; read fresh per request from
   *  runtime.sse_heartbeat_ms. Optional — absent/0 = no heartbeat. Inter-chunk only. */
  sseHeartbeatMs?: () => number;
  // Exact key-filtered ETag most recently served by GET /v1/models?client_version.
  // undefined = preserve legacy forwarding; null = suppress the account-wide
  // upstream ETag because it does not describe this key's filtered catalog.
  modelsEtagForKey?: (keyId: string, clientVersion: string | null) => string | null;
  // Process-local proof injected only by the WebSocket bridge's internal self-call.
  // Without it, a normal HTTP client could spoof x-helm-* session headers and
  // accidentally create a long-lived upstream websocket.
  responsesWebSocketSessionProof?: string;
}

// Client disconnect / abort detection — mirrors messages.ts. Used to suppress a
// terminal error frame for a benign disconnect (NOT a provider fault, docs/02).
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

function extractCredential(auth: string | undefined): string | null {
  if (auth) {
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]) return m[1];
  }
  return null;
}

const FORWARDED_RESPONSE_METADATA_HEADERS = new Set([
  "openai-model",
  "x-openai-model",
  "x-models-etag",
  "x-reasoning-included",
  "x-request-id",
]);

function applyResponseMetadata(
  c: Context<AppEnv>,
  metadata: Readonly<Record<string, string>> | undefined,
  modelsEtag: string | null | undefined,
): void {
  if (metadata === undefined) return;
  for (const [name, value] of Object.entries(metadata)) {
    const lower = name.toLowerCase();
    if (lower === "x-models-etag" && modelsEtag !== undefined) {
      if (modelsEtag !== null) c.header(lower, modelsEtag);
      continue;
    }
    if (
      FORWARDED_RESPONSE_METADATA_HEADERS.has(lower) ||
      lower.startsWith("x-codex-") ||
      lower.startsWith("x-ratelimit-")
    ) {
      c.header(lower, value);
    }
  }
}

function requestCodexClientVersion(c: Context<AppEnv>): string | null {
  const raw =
    c.req.header("version")?.trim() ?? c.req.header("x-codex-client-version")?.trim() ?? "";
  if (raw.length === 0) return null;
  const normalized = normalizeOpenAICodexClientVersion(raw);
  if (normalized === null) {
    throw helmError(
      "invalid_request",
      "version must be a valid semantic version",
      c.get("trace_id"),
    );
  }
  return normalized;
}

function modelsEtagForRequest(
  c: Context<AppEnv>,
  deps: ResponsesRouteDeps,
  keyId: string,
): string | null | undefined {
  return deps.modelsEtagForKey?.(keyId, requestCodexClientVersion(c));
}

function responseMetadataFromHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      FORWARDED_RESPONSE_METADATA_HEADERS.has(lower) ||
      lower.startsWith("x-codex-") ||
      lower.startsWith("x-ratelimit-")
    ) {
      metadata[lower] = value;
    }
  });
  return metadata;
}

function helmError(
  error_class: "auth_error" | "invalid_request" | "capability_unsatisfiable",
  message: string,
  traceId: string,
) {
  return new HelmHttpError(makeHelmError({ error_class, message, trace_id: traceId }));
}

function responseNotFound(c: Context<AppEnv>, responseId: string, traceId: string): Response {
  return c.json(
    {
      error: {
        message: `Responses response '${responseId}' was not found`,
        type: "invalid_request_error",
        code: "response_not_found",
        trace_id: traceId,
      },
    },
    404,
  );
}

function nativeHeadersForRequest(
  headers: Headers,
  responsesWebSocketSessionProof: string | undefined,
  clientVersion: string | null,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const proof = headers.get(CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER);
  const keepSession =
    responsesWebSocketSessionProof !== undefined && proof === responsesWebSocketSessionProof;
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER) return;
    if (lower === CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER && !keepSession) return;
    if (lower === "version" || lower === "x-codex-client-version") return;
    out[name] = value;
  });
  if (clientVersion !== null) out.version = clientVersion;
  return out;
}

function nativeCarrierForRequest(
  c: Context<AppEnv>,
  deps: ResponsesRouteDeps,
  native: unknown,
  rawBody: string,
): NativePassthroughCarrier | null {
  const clientVersion = requestCodexClientVersion(c);
  return nativeCarrierFromParsedBody({
    protocol: "openai_responses",
    native,
    rawBody,
    headers: nativeHeadersForRequest(
      c.req.raw.headers,
      deps.responsesWebSocketSessionProof,
      clientVersion,
    ),
  });
}

function successfulAttempt(decision: unknown): Record<string, unknown> | null {
  const attempts =
    decision !== null &&
    typeof decision === "object" &&
    Array.isArray((decision as { provider_attempts?: unknown }).provider_attempts)
      ? (decision as { provider_attempts: Array<Record<string, unknown>> }).provider_attempts
      : [];
  return attempts.find((attempt) => attempt.status === "ok" && attempt.skipped !== true) ?? null;
}

function statusFromResponseBody(body: Record<string, unknown>): string {
  return typeof body.status === "string" && body.status.length > 0 ? body.status : "completed";
}

function streamStatusFromEventName(eventName: string): string | null {
  switch (eventName) {
    case "response.created":
      return "in_progress";
    case "response.in_progress":
      return "in_progress";
    case "response.completed":
      return "completed";
    case "response.incomplete":
      return "incomplete";
    case "response.failed":
      return "failed";
    case "response.cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function responseSnapshotFromStreamFrame(
  eventName: string,
  data: string,
): { responseId: string | null; status: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { responseId: null, status: streamStatusFromEventName(eventName) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { responseId: null, status: streamStatusFromEventName(eventName) };
  }
  const record = parsed as Record<string, unknown>;
  const response = record.response;
  const responseRecord =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)
      : record;
  const responseId =
    typeof responseRecord.id === "string" && responseRecord.id.length > 0
      ? responseRecord.id
      : null;
  const status =
    typeof responseRecord.status === "string" && responseRecord.status.length > 0
      ? responseRecord.status
      : streamStatusFromEventName(eventName);
  return { responseId, status };
}

function isUsableRegistryRecord(record: ResponsesRegistryRecord): boolean {
  if (record.expiresAt <= Date.now()) return false;
  return record.status !== "deleted";
}

// Validate a PipelineError's free-form `error_class` against the known ErrorClass
// values; an unrecognized class falls back to upstream_error (502) rather than
// throwing in the error path (fail-open, principle 3). Mirrors server.ts's
// coerceErrorClass. The error-handler then maps it to the OpenAI envelope.
function coerceErrorClass(value: string): ErrorClass {
  const parsed = ErrorClassSchema.safeParse(value);
  return parsed.success ? parsed.data : "upstream_error";
}

// A PipelineError surfaced across the pipeline seam → a throwable HelmHttpError so
// the global onError serializes it in the OpenAI envelope (all_providers_failed →
// 502, invalid_request → 400, …) instead of degrading to an empty 200.

function responsesStreamError(args: {
  code: string;
  message: string;
  traceId: string;
  sequenceNumber: number;
}): Record<string, unknown> {
  return {
    type: "error",
    code: args.code,
    message: args.message,
    param: null,
    sequence_number: args.sequenceNumber,
    trace_id: args.traceId,
  };
}

function responseStreamId(traceId: string): string {
  const stable = traceId.replace(/[^A-Za-z0-9]/g, "_").replace(/^_+|_+$/g, "");
  return `resp_${stable || randomUUID().replace(/-/g, "")}`;
}

function pipelineToHelm(err: PipelineError, traceId: string): HelmHttpError {
  return new HelmHttpError(
    makeHelmError({
      error_class: coerceErrorClass(err.error_class),
      message: err.message,
      trace_id: traceId,
    }),
  );
}

function estimateResponsesInputTokens(value: unknown): number {
  const seen = new WeakSet<object>();
  const collect = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map(collect).join("\n");
    if (typeof v === "object") {
      if (seen.has(v)) return "";
      seen.add(v);
      return Object.values(v as Record<string, unknown>)
        .map(collect)
        .join("\n");
    }
    return "";
  };
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = [obj.instructions, obj.input, obj.tools, obj.tool_choice, obj.response_format]
    .map(collect)
    .filter((s) => s.length > 0)
    .join("\n");
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function compactModelFromBody(body: Record<string, unknown>): string {
  return typeof body.model === "string" && body.model.length > 0 ? body.model : "unknown";
}

function compactAlias(model: string): string {
  return model.includes("/") ? model : `openai-codex/${model}`;
}

function compactUsageFromResponse(body: Record<string, unknown> | null): StreamUsage | null {
  const topLevel = usageFromResponsesResponse(body);
  if (topLevel !== null) return topLevel;
  if (!Array.isArray(body?.output)) return null;

  const nested = body.output.flatMap((item) => {
    const direct = usageFromResponsesResponse(item);
    if (direct !== null) return [direct];
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const response = (item as Record<string, unknown>).response;
    const wrapped = usageFromResponsesResponse(response);
    return wrapped === null ? [] : [wrapped];
  });
  if (nested.length === 0) return null;

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheCreationTokens = 0;
  for (const usage of nested) {
    promptTokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
    completionTokens += usage.completion_tokens ?? usage.output_tokens ?? 0;
    const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
    cachedTokens += details?.cached_tokens ?? 0;
    cacheCreationTokens +=
      details?.cache_creation_tokens ??
      details?.cache_creation_input_tokens ??
      details?.cache_write_tokens ??
      0;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cachedTokens > 0 || cacheCreationTokens > 0
      ? {
          prompt_tokens_details: {
            ...(cachedTokens > 0 ? { cached_tokens: cachedTokens } : {}),
            ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
          },
        }
      : {}),
  };
}

function compactDecision(args: {
  traceId: string;
  keyPrefix: string | null;
  requestedModel: string;
  modelAlias: string;
  providerModel: string;
  providerName: string;
  servingAccount: { providerId: string; account: string } | null;
  latencyMs: number;
  body: Record<string, unknown> | null;
  error: unknown | null;
  costUsd: number | null;
}): DecisionRecord {
  const usage = compactUsageFromResponse(args.body);
  const inputDetails = usage?.prompt_tokens_details ?? usage?.input_tokens_details;
  const ok = args.error === null;
  const upstreamStatus = args.error instanceof UpstreamError ? args.error.upstreamStatus : null;
  const errorClass =
    args.error instanceof UpstreamError
      ? args.error.errorClass
      : args.error === null
        ? null
        : "upstream_error";
  const providerRaw =
    args.error instanceof UpstreamError &&
    typeof args.error.providerRaw === "object" &&
    args.error.providerRaw !== null &&
    !Array.isArray(args.error.providerRaw)
      ? (args.error.providerRaw as Record<string, unknown>)
      : null;
  return {
    request_id: args.traceId,
    trace_id: args.traceId,
    requested_model: args.requestedModel,
    protocol: "openai_responses",
    key_prefix: args.keyPrefix,
    classifier: {
      task_type: "passthrough",
      complexity: "passthrough",
      confidence: 1,
      decided_by: "default",
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      fallback_reason: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "responses_compact" },
    lane: { selected_lane: "responses_compact", candidate_chain: [args.modelAlias] },
    provider_attempts: [
      {
        alias: args.modelAlias,
        skipped: false,
        skip_reason: null,
        status: ok ? "ok" : "error",
        error_class: errorClass,
        latency_ms: args.latencyMs,
        cost_usd: ok ? args.costUsd : null,
        error_detail: ok
          ? null
          : {
              upstream_status: upstreamStatus,
              message:
                args.error instanceof Error ? args.error.message : "Responses compact failed",
              provider_raw: providerRaw,
            },
        passthrough_considered: true,
        passthrough_used: true,
        passthrough_disable_reason: null,
        source_protocol: "openai_responses",
        target_provider_protocol: "openai_responses",
        response_protocol: "openai_responses",
        provider_name: args.providerName,
        provider_model: args.providerModel,
      },
    ],
    final: ok
      ? {
          model_alias: args.modelAlias,
          provider_model: args.providerModel,
          status: "ok",
          error_reason: null,
        }
      : {
          model_alias: null,
          provider_model: null,
          status: "error",
          error_reason: errorClass,
        },
    serving_account:
      args.servingAccount === null
        ? null
        : {
            provider_id: args.servingAccount.providerId,
            account: args.servingAccount.account,
          },
    latency_total_ms: args.latencyMs,
    fallback_count: 0,
    cost_breakdown: {
      eval_usd: null,
      completion_usd: ok ? args.costUsd : null,
      total_usd: ok ? args.costUsd : null,
    },
    memory: null,
    usage:
      usage === null
        ? null
        : {
            prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
            completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
            cached_tokens: inputDetails?.cached_tokens ?? null,
            cache_creation_tokens:
              inputDetails?.cache_creation_tokens ??
              inputDetails?.cache_creation_input_tokens ??
              inputDetails?.cache_write_tokens ??
              null,
          },
    generation_ms: null,
  };
}

export function registerResponsesRoute(app: Hono<AppEnv>, deps: ResponsesRouteDeps): void {
  // Frees an unclaimed concurrency lease on every exit path — incl. a throw into
  // onError (the handler below acquires AFTER its self-auth).
  app.use("/v1/responses", concurrencyReleaseGuard());
  app.use("/v1/responses/*", concurrencyReleaseGuard());
  app.use("/responses", concurrencyReleaseGuard());
  app.use("/responses/*", concurrencyReleaseGuard());
  app.use("/openai/v1/responses", concurrencyReleaseGuard());
  app.use("/openai/v1/responses/*", concurrencyReleaseGuard());

  const authenticateResponsesRequest = async (c: Context<AppEnv>): Promise<MessagesIdentity> => {
    const traceId = c.get("trace_id");
    const credential = extractCredential(c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) throw helmError("auth_error", "missing or invalid API key", traceId);
    return identity;
  };

  const enforceRateLimit = async (
    c: Context<AppEnv>,
    identity: MessagesIdentity,
  ): Promise<void> => {
    if (deps.rateLimiter === undefined) return;
    const traceId = c.get("trace_id");
    const rl = await deps.rateLimiter.check({
      keyId: identity.keyId,
      estimatedTokens: estimateRequestTokens(c),
      now: Date.now(),
      override: identity.caps?.rateLimit
        ? { rpm: identity.caps.rateLimit.rpm, tpm: identity.caps.rateLimit.tpm }
        : undefined,
    });
    if (rl.allowed && rl.limit === 0) return;
    c.header("x-ratelimit-limit", String(rl.limit));
    c.header("x-ratelimit-remaining", String(rl.remaining));
    c.header("x-ratelimit-reset", String(rl.resetSeconds));
    if (rl.allowed) return;
    c.header("retry-after", String(rl.retryAfterSeconds));
    throw new HelmHttpError(
      makeHelmError({
        error_class: "rate_limited",
        message: `rate limit exceeded (${rl.limitedBy})`,
        trace_id: traceId,
      }),
    );
  };

  const acquireConcurrency = async (
    c: Context<AppEnv>,
    identity: MessagesIdentity,
  ): Promise<void> => {
    if (deps.concurrencyGate === undefined) return;
    const acquired = await deps.concurrencyGate.acquire({
      keyId: identity.keyId,
      limit: identity.caps?.concurrencyLimit ?? null,
      signal: requestSignal(c),
    });
    if (!acquired.ok) {
      c.header("retry-after", String(acquired.retryAfterSeconds));
      throw new HelmHttpError(
        makeHelmError({
          error_class: "rate_limited",
          message:
            acquired.reason === "queue_full"
              ? "concurrency queue is full"
              : "timed out waiting for a concurrency slot",
          trace_id: c.get("trace_id"),
        }),
      );
    }
    c.set("concurrencyRelease", acquired.release);
  };

  const lifecycleUnsupported = (operation: string, traceId: string): HelmHttpError =>
    helmError(
      "capability_unsatisfiable",
      `Responses ${operation} is not supported by the selected provider or this Helm API deployment`,
      traceId,
    );

  const parseJsonBodyWithRaw = async (
    c: Context<AppEnv>,
    traceId: string,
  ): Promise<{ native: unknown; rawBody: string }> => {
    try {
      const rawBody = await c.req.text();
      return { native: JSON.parse(rawBody), rawBody };
    } catch {
      throw helmError("invalid_request", "malformed JSON request body", traceId);
    }
  };

  const parseJsonBody = async (c: Context<AppEnv>, traceId: string): Promise<unknown> =>
    (await parseJsonBodyWithRaw(c, traceId)).native;

  const handleProviderLifecycle =
    (operation: "retrieve" | "delete" | "cancel" | "inputItems") => async (c: Context<AppEnv>) => {
      const traceId = c.get("trace_id");
      const identity = await authenticateResponsesRequest(c);
      const method = deps.lifecycle?.[operation];
      if (method === undefined) throw lifecycleUnsupported(operation, traceId);
      const responseId = c.req.param("response_id");
      if (responseId === undefined) {
        throw helmError("invalid_request", "missing response_id", traceId);
      }
      const registryRecord =
        deps.registry !== undefined ? await deps.registry.get(responseId, identity) : null;
      if (deps.registry !== undefined && registryRecord === null) {
        return responseNotFound(c, responseId, traceId);
      }
      if (
        registryRecord !== null &&
        registryRecord !== undefined &&
        !isUsableRegistryRecord(registryRecord)
      ) {
        return responseNotFound(c, responseId, traceId);
      }
      const body =
        deps.registry !== undefined
          ? await method(responseId, identity, requestSignal(c), registryRecord ?? undefined)
          : await method(responseId, identity, requestSignal(c));
      return c.json(body as Record<string, unknown>);
    };

  const handleCompact = async (c: Context<AppEnv>) => {
    const traceId = c.get("trace_id");
    const identity = await authenticateResponsesRequest(c);
    await enforceRateLimit(c, identity);
    await acquireConcurrency(c, identity);
    const { native, rawBody } = await parseJsonBodyWithRaw(c, traceId);
    const method = deps.lifecycle?.compact;
    if (method === undefined) throw lifecycleUnsupported("compact", traceId);
    let carrier = nativeCarrierForRequest(c, deps, native, rawBody);
    if (carrier === null) {
      throw helmError("invalid_request", "invalid Responses compact request body", traceId);
    }
    const budgetCaps = identity.caps?.budget;
    if (deps.budget !== undefined && budgetCaps !== undefined) {
      const check = await deps.budget.gate.check({
        keyId: identity.keyId,
        caps: budgetCaps,
        nowMs: deps.budget.now(),
      });
      if (check.overBudget && check.behavior === "reject") {
        throw new HelmHttpError(
          makeHelmError({
            error_class: "rate_limited",
            message: "usage budget exceeded",
            trace_id: traceId,
          }),
        );
      }
      if (check.overBudget && check.behavior === "degrade" && check.degradeLane !== null) {
        carrier = cloneCarrierWithBody(carrier, { ...carrier.body, model: check.degradeLane });
      }
    }
    let responseMetadata: Record<string, string> | undefined;
    const executionState: { value: ResponsesCompactExecution | null } = { value: null };
    const startedAt = Date.now();
    let body: Record<string, unknown> | null = null;
    try {
      body = (await method(
        carrier,
        identity,
        requestSignal(c),
        (headers) => {
          responseMetadata = responseMetadataFromHeaders(headers);
        },
        (value) => {
          executionState.value = value;
        },
      )) as Record<string, unknown>;
      const execution = executionState.value;
      const requestedModel = compactModelFromBody(carrier.body);
      const providerModel =
        execution?.providerModel ??
        (typeof body.model === "string" && body.model.length > 0 ? body.model : requestedModel);
      const usage = compactUsageFromResponse(body);
      const alias = execution?.modelAlias ?? compactAlias(providerModel);
      const costUsd =
        usage === null
          ? null
          : (deps.budget?.costOf?.(alias, usage) ?? deps.record?.costOf?.(alias, usage) ?? null);
      const tokens = tokensFromUsage(usage);
      if (deps.budget !== undefined && budgetCaps !== undefined) {
        try {
          await deps.budget.settle(
            identity.keyId,
            budgetCaps,
            { requests: 1, tokens, costUsd },
            deps.budget.now(),
          );
        } catch {
          /* fail-open: a budget settle failure never breaks a served compact request */
        }
      }
      deps.recordOAuthUsage?.(execution?.servingAccount ?? null, alias, { tokens, costUsd });
      if (deps.record !== undefined) {
        await recordServed(
          deps.record,
          {
            requestId: traceId,
            apiKeyId: identity.keyId,
            decision: compactDecision({
              traceId,
              keyPrefix: typeof identity.keyPrefix === "string" ? identity.keyPrefix : null,
              requestedModel,
              modelAlias: alias,
              providerModel,
              providerName: execution?.providerName ?? "openai-codex",
              servingAccount: execution?.servingAccount ?? null,
              latencyMs: Date.now() - startedAt,
              body,
              error: null,
              costUsd,
            }),
            requestJson: rawBody,
            responseJson: captureEnabled(deps.record) ? JSON.stringify(body) : null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson: execution?.upstreamRequest ?? null,
          },
          (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
        );
      }
      applyResponseMetadata(c, responseMetadata, modelsEtagForRequest(c, deps, identity.keyId));
      return c.json(body);
    } catch (err) {
      if (deps.record !== undefined) {
        const requestedModel = compactModelFromBody(carrier.body);
        const execution = executionState.value;
        const providerModel = execution?.providerModel ?? requestedModel;
        await recordServed(
          deps.record,
          {
            requestId: traceId,
            apiKeyId: identity.keyId,
            decision: compactDecision({
              traceId,
              keyPrefix: typeof identity.keyPrefix === "string" ? identity.keyPrefix : null,
              requestedModel,
              modelAlias: execution?.modelAlias ?? compactAlias(providerModel),
              providerModel,
              providerName: execution?.providerName ?? "openai-codex",
              servingAccount: execution?.servingAccount ?? null,
              latencyMs: Date.now() - startedAt,
              body,
              error: err,
              costUsd: null,
            }),
            requestJson: rawBody,
            responseJson: null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson: execution?.upstreamRequest ?? null,
          },
          (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
        );
      }
      throw err;
    }
  };

  const handleInputTokens = async (c: Context<AppEnv>) => {
    const traceId = c.get("trace_id");
    const identity = await authenticateResponsesRequest(c);
    const native = await parseJsonBody(c, traceId);
    const providerMethod = deps.lifecycle?.inputTokens;
    if (providerMethod !== undefined) {
      const body = await providerMethod(native, identity, requestSignal(c));
      return c.json(body as Record<string, unknown>);
    }
    return c.json({ input_tokens: estimateResponsesInputTokens(native), estimated: true });
  };

  const handleResponses = async (c: Context<AppEnv>) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline order).
    const identity = await authenticateResponsesRequest(c);

    // 1b) Rate limit AFTER auth (needs the resolved key_id) and BEFORE translate/
    //     route. OpenAI surface → the structured rate_limited envelope via onError
    //     (+ retry-after / x-ratelimit-* headers). No-op when the limiter reports
    //     limit 0 (disabled). A store failure propagates (fail-CLOSED).
    await enforceRateLimit(c, identity);

    // 1c) Concurrency overflow queue (issue #93) AFTER rate-limit: wait for a
    //     slot instead of an instant 429; queue-full / wait timeout → 429 via the
    //     OpenAI envelope (onError). Release parked on the context for the guard;
    //     the stream branch claims it and releases at true stream end.
    await acquireConcurrency(c, identity);

    // 2) Parse + translate inbound. A malformed JSON body OR a structurally invalid
    //    Responses request (the transformer's Zod parse throws) is a CLIENT error →
    //    400 invalid_request, before routing (docs/07, principle 2 fail-closed).
    let requestJson = "";
    let native: unknown;
    try {
      requestJson = await c.req.text();
      native = JSON.parse(requestJson);
    } catch {
      throw helmError("invalid_request", "malformed JSON request body", traceId);
    }
    let ir: ResponsesIRLike;
    try {
      ir = deps.transformer.transformRequestOut(native);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "invalid Responses request";
      throw helmError("invalid_request", detail, traceId);
    }
    // Memory scope (docs/08 Phase 1): parse the four memory headers at this HTTP
    // boundary and stamp them onto the IR metadata bag (mirrors /v1/messages), so
    // the SHARED pipeline's observe phase can read the scope off ir.metadata
    // without touching HTTP (principle 1). Without this, /v1/responses was wired
    // with observe deps but never received a scope → memory was dead on this
    // surface. Absent/illegal headers → off + null (default-safe).
    const nativeRec = (native ?? {}) as Record<string, unknown>;
    const nativeMetaBag =
      nativeRec.metadata && typeof nativeRec.metadata === "object"
        ? (nativeRec.metadata as Record<string, unknown>)
        : null;
    const sig = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const memoryScope = resolveMemoryScope((name) => c.req.header(name), identity.accountId, {
      defaults: identity.caps?.memory,
      signals: {
        metadataThreadId: sig(nativeMetaBag?.thread_id) ?? sig(nativeMetaBag?.conversation_id),
        // Responses body prompt_cache_key — the per-conversation cache-affinity
        // key Codex and OpenClaw already send (issue #97 fallback chain).
        promptCacheKey: sig(nativeRec.prompt_cache_key),
      },
    });
    ir.metadata = {
      ...(ir.metadata ?? {}),
      trace_id: traceId,
      thread_id: memoryScope.threadId,
      resource_id: memoryScope.resourceId,
      project_id: memoryScope.projectId,
      memory_mode: memoryScope.mode,
      memory_thread_source: memoryScope.threadSource,
    };

    // Native protocol passthrough carrier (#217 Phase 3). Stamp the VERBATIM parsed
    // inbound Responses body onto the IR metadata bag (same HTTP→core hand-off as the
    // /v1/messages route); the pipeline reads it into InternalRequest.native_request and
    // the routing core's guard decides whether to forward it untranslated to the Codex
    // (openai_responses) upstream. NEVER logged. Covers BOTH stream and non-stream: the
    // real Codex CLI is stream-only (store:false + stream:true), so the same verbatim
    // body is the carrier on either branch — the guard + executor decide whether to
    // actually forward it.
    const nativeCarrier = nativeCarrierForRequest(c, deps, native, requestJson);
    if (nativeCarrier !== null) {
      ir.metadata.native_request = nativeCarrier;
    }

    // Capture the verbatim request/response bodies only when capture_payloads is ON
    // (the telemetry row is always written regardless). Gating the buffering here
    // stops long/concurrent streams from accumulating the full body when capture is
    // off (review P2).
    const captureBodies = deps.record !== undefined && captureEnabled(deps.record);

    // 4) Outbound: stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      const responseId = responseStreamId(traceId);
      ir.metadata = { ...(ir.metadata ?? {}), responses_stream_id: responseId };
      // Claim the concurrency lease (issue #93): hold the slot until the stream
      // body fully drains — release in the stream's own finally, not the guard.
      const releaseConcurrency = c.get("concurrencyRelease");
      c.set("concurrencyRelease", undefined);
      let initialResult: PipelineRunResult | null = null;
      let initialError: unknown = null;
      try {
        initialResult = await deps.pipeline.run(ir, identity, requestSignal(c));
        applyResponseMetadata(
          c,
          initialResult.responseMetadata,
          modelsEtagForRequest(c, deps, identity.keyId),
        );
      } catch (err) {
        initialError = err;
      }
      return streamSSE(c, async (sse) => {
        // Translate path: each IR event is serialized by the transformer's stream
        // mapping; the pipeline already ran the Responses state machine (principle 8 —
        // we never forward a raw upstream chunk through a blind re-mapper). There is NO
        // [DONE] sentinel; the terminal response.completed closes the stream.
        // Native-passthrough path (#217 Phase 3): the pipeline already byte-relayed the
        // upstream Codex Responses SSE into VERBATIM {event,data} frames (the data
        // payload is the exact upstream JSON string, INCLUDING reasoning.encrypted_content
        // and native tool-call events) — forward them directly, BYPASSING transformStreamOut
        // so the bytes reach the client byte-for-byte. Both translated and native
        // paths use exactly one Responses state machine; the route never adds an
        // extra synthetic prelude. Capture stays native on both ends; an upstream
        // error mid-passthrough still surfaces the terminal error frame below.
        let nextErrorSequence = 0;
        // Accumulate the serialized wire frames so the served response body can be
        // captured (verbatim) alongside the telemetry row in the finally below.
        const captured: string[] = [];
        const result = initialResult;
        // SSE keep-alive: emit a `:` comment during inter-chunk idle (wire-only, never
        // captured) so a proxy/client idle-timeout does not sever a long healthy stream.
        // Gated on an event boundary so it can never split a verbatim-relayed frame.
        // 0 = disabled (today's behavior).
        const heartbeatMs = deps.sseHeartbeatMs?.() ?? 0;
        let lastWrite: string | null = null;
        let streamResponseId: string | null = null;
        let streamStatus: string | null = null;
        try {
          if (initialError !== null) throw initialError;
          if (result === null) throw new Error("Responses pipeline did not return a result");
          for await (const item of withHeartbeat(result.streamIR(), {
            heartbeatMs,
            signal: requestSignal(c),
          })) {
            if (item.type === "beat") {
              if (atEventBoundary(lastWrite)) await sse.write(HEARTBEAT_COMMENT);
              continue;
            }
            const event = item.value;
            if (typeof event.sequence_number === "number")
              nextErrorSequence = event.sequence_number + 1;
            const frame =
              result.nativePassthrough === true
                ? {
                    event: (event as { event: string }).event,
                    data: (event as { data: string }).data,
                    raw: (event as { raw?: string }).raw,
                  }
                : { ...deps.transformer.transformStreamOut(event), raw: undefined };
            const snapshot = responseSnapshotFromStreamFrame(frame.event, frame.data);
            if (snapshot.responseId !== null) streamResponseId = snapshot.responseId;
            if (snapshot.status !== null) streamStatus = snapshot.status;
            const raw = frame.raw;
            if (captureBodies)
              captured.push(raw ?? `event: ${frame.event}\ndata: ${frame.data}\n\n`);
            if (raw !== undefined) {
              await sse.write(raw);
              lastWrite = raw;
            } else {
              await sse.writeSSE({ event: frame.event, data: frame.data });
              lastWrite = "\n\n"; // writeSSE emits a complete frame — always a boundary
            }
          }
        } catch (err) {
          // A client disconnect / abort is benign (docs/02): emit NO error frame.
          // Any other throw — incl. a PipelineError when all providers failed
          // before the stream started — writes a SINGLE terminal Responses-shaped
          // error event DIRECTLY into the stream. We CANNOT throw here (the stream
          // has already started; onError would never see it).
          if (!isAbort(err, c.req.raw.signal)) {
            const body =
              err instanceof PipelineError
                ? responsesStreamError({
                    code: coerceErrorClass(err.error_class),
                    message: err.message,
                    traceId,
                    sequenceNumber: nextErrorSequence,
                  })
                : responsesStreamError({
                    // Preserve a mid-stream idle timeout instead of internal_error.
                    code: isUpstreamTimeout(err) ? "timeout" : "internal_error",
                    message: err instanceof Error ? err.message : "upstream error",
                    traceId,
                    sequenceNumber: nextErrorSequence,
                  });
            const data = JSON.stringify(body);
            if (captureBodies) captured.push(`event: error\ndata: ${data}\n\n`);
            await sse.writeSSE({ event: "error", data });
          }
        } finally {
          releaseConcurrency?.();
          // Record AFTER releaseConcurrency so the bookkeeping never extends the
          // concurrency hold, and AFTER the for-await loop ended so the pipeline's
          // own streamIR finally (cost backfill) already mutated result.decision.
          // result.decision exists even on a pre-stream failure, so a failed stream
          // still records. Fail-open inside recordServed.
          if (deps.record && result !== null) {
            stampServingAccount(result.decision, result.servingAccount ?? null);
            await recordServed(
              deps.record,
              {
                requestId: traceId,
                apiKeyId: identity.keyId,
                decision: result.decision,
                requestJson,
                responseJson: captureBodies ? captured.join("") : null,
                timedOut: requestTimedOut(c),
                upstreamRequestJson: result.upstreamRequest ?? null,
              },
              (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
            );
          }
          if (deps.registry !== undefined && result !== null && streamResponseId !== null) {
            const attempt = successfulAttempt(result.decision);
            await deps.registry.put({
              responseId: streamResponseId,
              accountId: identity.accountId,
              keyId: identity.keyId,
              providerAlias: typeof attempt?.alias === "string" ? attempt.alias : null,
              providerName:
                typeof attempt?.provider_name === "string" ? attempt.provider_name : null,
              providerModel:
                typeof attempt?.provider_model === "string" ? attempt.provider_model : null,
              providerProtocol:
                attempt?.target_provider_protocol === "openai_chat" ||
                attempt?.target_provider_protocol === "anthropic_messages" ||
                attempt?.target_provider_protocol === "openai_responses" ||
                attempt?.target_provider_protocol === "gemini"
                  ? attempt.target_provider_protocol
                  : null,
              createdAt: Date.now(),
              expiresAt: Date.now() + 86_400_000,
              status: streamStatus ?? "completed",
            });
          }
        }
      });
    }

    // 3) Route through the shared core. The pipeline throws a PipelineError when
    //    routing failed (all_providers_failed) or for an empty request
    //    (invalid_request) — surface it as the matching OpenAI envelope instead of
    //    an empty 200. Streaming requests run the pipeline before streamSSE so
    //    request-scoped Codex headers are present before HTTP response commitment.
    let result: PipelineRunResult;
    try {
      result = await deps.pipeline.run(ir, identity, requestSignal(c));
    } catch (err) {
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }

    // Non-stream: collect() throws a PipelineError when routing failed (all
    // providers failed) — surface it as the OpenAI envelope instead of the empty
    // 200 a synthesized placeholder body would produce. The outbound transform
    // runs INSIDE this try too, so a transformer throw after a provider result was
    // collected is ALSO recorded (review P3) — consistent with messages/gemini.
    let body: Record<string, unknown>;
    try {
      const collected = await result.collect();
      // Native protocol passthrough (#217 Phase 3): collect() already returned the
      // upstream's VERBATIM native Responses body (it bypassed openAIBodyToIR). Skip
      // transformResponseOut so the native body reaches the client BYTE-FOR-BYTE; the
      // translate path is unchanged for every non-passthrough request. (Codex is
      // stream-only, so this branch is rarely hit but kept correct.)
      body =
        result.nativePassthrough === true
          ? (collected as Record<string, unknown>)
          : (deps.transformer.transformResponseOut(collected) as Record<string, unknown>);
    } catch (err) {
      // Record the FAILED served request before surfacing the error (mirrors
      // chat.ts, which records failures too) so an all-providers-failed request
      // still appears in /admin/requests. responseJson null = no body produced.
      // result.decision exists even on failure. Fail-open inside recordServed.
      if (deps.record) {
        stampServingAccount(result.decision, result.servingAccount ?? null);
        await recordServed(
          deps.record,
          {
            requestId: traceId,
            apiKeyId: identity.keyId,
            decision: result.decision,
            requestJson,
            responseJson: null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson: result.upstreamRequest ?? null,
          },
          (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
        );
      }
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }
    if (deps.registry !== undefined && typeof body.id === "string" && body.id.length > 0) {
      const attempt = successfulAttempt(result.decision);
      await deps.registry.put({
        responseId: body.id,
        accountId: identity.accountId,
        keyId: identity.keyId,
        providerAlias: typeof attempt?.alias === "string" ? attempt.alias : null,
        providerName: typeof attempt?.provider_name === "string" ? attempt.provider_name : null,
        providerModel: typeof attempt?.provider_model === "string" ? attempt.provider_model : null,
        providerProtocol:
          attempt?.target_provider_protocol === "openai_chat" ||
          attempt?.target_provider_protocol === "anthropic_messages" ||
          attempt?.target_provider_protocol === "openai_responses" ||
          attempt?.target_provider_protocol === "gemini"
            ? attempt.target_provider_protocol
            : null,
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        status: statusFromResponseBody(body),
      });
    }
    // Record the served (non-stream) request: telemetry row (→ /admin/requests) +
    // verbatim request/response body. Mirrors chat.ts. Fail-open inside recordServed.
    if (deps.record) {
      stampServingAccount(result.decision, result.servingAccount ?? null);
      await recordServed(
        deps.record,
        {
          requestId: traceId,
          apiKeyId: identity.keyId,
          decision: result.decision,
          requestJson,
          responseJson: captureBodies ? JSON.stringify(body) : null,
          timedOut: requestTimedOut(c),
          upstreamRequestJson: result.upstreamRequest ?? null,
        },
        (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
      );
    }
    applyResponseMetadata(
      c,
      result.responseMetadata,
      modelsEtagForRequest(c, deps, identity.keyId),
    );
    return c.json(body);
  };

  for (const prefix of ["/v1/responses", "/responses", "/openai/v1/responses"]) {
    app.post(`${prefix}/compact`, handleCompact);
    app.post(`${prefix}/input_tokens`, handleInputTokens);
    app.get(`${prefix}/:response_id/input_items`, handleProviderLifecycle("inputItems"));
    app.post(`${prefix}/:response_id/cancel`, handleProviderLifecycle("cancel"));
    app.get(`${prefix}/:response_id`, handleProviderLifecycle("retrieve"));
    app.delete(`${prefix}/:response_id`, handleProviderLifecycle("delete"));
    app.post(prefix, handleResponses);
  }
}
