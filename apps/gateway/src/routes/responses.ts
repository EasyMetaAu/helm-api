import { randomUUID } from "node:crypto";
import type { RateLimitProbe, RateLimitResult } from "@helm/core";
import { type ErrorClass, ErrorClassSchema, makeHelmError } from "@helm/shared";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { resolveMemoryScope } from "./memory-scope.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";
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

export interface ResponsesRouteDeps {
  rateLimiter?: ResponsesRateLimiterPort;
  /** Per-key concurrency overflow queue (issue #93) — the SAME process-wide gate
   *  as the chat middleware. Optional — omitted = no gating. */
  concurrencyGate?: ConcurrencyGatePort;
  /** Telemetry + payload recorder (the /admin/requests fix). Optional so existing
   *  tests that omit it record nothing; when wired, every served request (success
   *  OR failure, stream OR non-stream) writes a telemetry row. */
  record?: RecordServedDeps;
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

function helmError(
  error_class: "auth_error" | "invalid_request",
  message: string,
  traceId: string,
) {
  return new HelmHttpError(makeHelmError({ error_class, message, trace_id: traceId }));
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

function responseStreamPrelude(args: {
  responseId: string;
  model: string;
}): Array<Record<string, unknown>> {
  const response = {
    id: args.responseId,
    object: "response",
    model: args.model,
    status: "in_progress",
    output: [],
  };
  return [
    { type: "response.created", sequence_number: 0, response },
    { type: "response.in_progress", sequence_number: 1, response },
  ];
}

function isResponsesPreludeEvent(event: Record<string, unknown>): boolean {
  return event.type === "response.created" || event.type === "response.in_progress";
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

export function registerResponsesRoute(app: Hono<AppEnv>, deps: ResponsesRouteDeps): void {
  // Frees an unclaimed concurrency lease on every exit path — incl. a throw into
  // onError (the handler below acquires AFTER its self-auth).
  app.use("/v1/responses", concurrencyReleaseGuard());
  app.use("/responses", concurrencyReleaseGuard());
  app.use("/openai/v1/responses", concurrencyReleaseGuard());

  const authenticateResponsesRequest = async (c: Context<AppEnv>): Promise<MessagesIdentity> => {
    const traceId = c.get("trace_id");
    const credential = extractCredential(c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) throw helmError("auth_error", "missing or invalid API key", traceId);
    return identity;
  };

  const unsupportedLifecycle = (operation: string) => async (c: Context<AppEnv>) => {
    const traceId = c.get("trace_id");

    // Match OpenAI/LiteLLM route coverage while failing closed for lifecycle
    // state Helm does not persist yet. Auth still runs first so unsupported
    // operations do not become unauthenticated route probes.
    await authenticateResponsesRequest(c);
    throw helmError(
      "invalid_request",
      `Responses ${operation} is not implemented by this Helm API deployment`,
      traceId,
    );
  };

  const handleResponses = async (c: Context<AppEnv>) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline order).
    const identity = await authenticateResponsesRequest(c);

    // 1b) Rate limit AFTER auth (needs the resolved key_id) and BEFORE translate/
    //     route. OpenAI surface → the structured rate_limited envelope via onError
    //     (+ retry-after / x-ratelimit-* headers). No-op when the limiter reports
    //     limit 0 (disabled). A store failure propagates (fail-CLOSED).
    if (deps.rateLimiter !== undefined) {
      const rl = await deps.rateLimiter.check({
        keyId: identity.keyId,
        // Content-Length/4 estimate so per-key TPM is metered here too.
        estimatedTokens: estimateRequestTokens(c),
        now: Date.now(),
        // Per-key override carried by the resolver (null dims inherit the default).
        override: identity.caps?.rateLimit
          ? { rpm: identity.caps.rateLimit.rpm, tpm: identity.caps.rateLimit.tpm }
          : undefined,
      });
      if (!(rl.allowed && rl.limit === 0)) {
        c.header("x-ratelimit-limit", String(rl.limit));
        c.header("x-ratelimit-remaining", String(rl.remaining));
        c.header("x-ratelimit-reset", String(rl.resetSeconds));
        if (!rl.allowed) {
          c.header("retry-after", String(rl.retryAfterSeconds));
          throw new HelmHttpError(
            makeHelmError({
              error_class: "rate_limited",
              message: `rate limit exceeded (${rl.limitedBy})`,
              trace_id: traceId,
            }),
          );
        }
      }
    }

    // 1c) Concurrency overflow queue (issue #93) AFTER rate-limit: wait for a
    //     slot instead of an instant 429; queue-full / wait timeout → 429 via the
    //     OpenAI envelope (onError). Release parked on the context for the guard;
    //     the stream branch claims it and releases at true stream end.
    if (deps.concurrencyGate !== undefined) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.caps?.concurrencyLimit ?? null,
        signal: c.req.raw.signal,
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
            trace_id: traceId,
          }),
        );
      }
      c.set("concurrencyRelease", acquired.release);
    }

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

    // Capture the verbatim request/response bodies only when capture_payloads is ON
    // (the telemetry row is always written regardless). Gating the buffering here
    // stops long/concurrent streams from accumulating the full body when capture is
    // off (review P2).
    const captureBodies = deps.record !== undefined && captureEnabled(deps.record);

    // 4) Outbound: stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      const responseId = responseStreamId(traceId);
      const responseModel = typeof ir.model === "string" && ir.model.length > 0 ? ir.model : "auto";
      ir.metadata = { ...(ir.metadata ?? {}), responses_stream_id: responseId };
      // Claim the concurrency lease (issue #93): hold the slot until the stream
      // body fully drains — release in the stream's own finally, not the guard.
      const releaseConcurrency = c.get("concurrencyRelease");
      c.set("concurrencyRelease", undefined);
      return streamSSE(c, async (sse) => {
        // Each IR event is serialized by the transformer's stream mapping; the
        // pipeline already ran the Responses state machine (principle 8 — we never
        // forward a raw upstream chunk). There is NO [DONE] sentinel; the terminal
        // response.completed closes the stream.
        let nextErrorSequence = 0;
        // Accumulate the serialized wire frames so the served response body can be
        // captured (verbatim) alongside the telemetry row in the finally below.
        const captured: string[] = [];
        let result: PipelineRunResult | null = null;
        try {
          for (const event of responseStreamPrelude({ responseId, model: responseModel })) {
            nextErrorSequence = 2;
            const frame = deps.transformer.transformStreamOut(event);
            if (captureBodies) captured.push(`event: ${frame.event}\ndata: ${frame.data}\n\n`);
            await sse.writeSSE({ event: frame.event, data: frame.data });
          }
          result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
          for await (const event of result.streamIR()) {
            if (isResponsesPreludeEvent(event)) continue;
            if (typeof event.sequence_number === "number")
              nextErrorSequence = event.sequence_number + 1;
            const frame = deps.transformer.transformStreamOut(event);
            if (captureBodies) captured.push(`event: ${frame.event}\ndata: ${frame.data}\n\n`);
            await sse.writeSSE({ event: frame.event, data: frame.data });
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
            await recordServed(
              deps.record,
              {
                requestId: traceId,
                apiKeyId: identity.keyId,
                decision: result.decision,
                requestJson,
                responseJson: captureBodies ? captured.join("") : null,
              },
              (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
            );
          }
        }
      });
    }

    // 3) Route through the shared core. The pipeline throws a PipelineError when
    //    routing failed (all_providers_failed) or for an empty request
    //    (invalid_request) — surface it as the matching OpenAI envelope instead of
    //    an empty 200. For streaming requests this wait happens inside streamSSE
    //    after the Responses prelude has already reached the client.
    let result: PipelineRunResult;
    try {
      result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
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
      body = deps.transformer.transformResponseOut(collected) as Record<string, unknown>;
    } catch (err) {
      // Record the FAILED served request before surfacing the error (mirrors
      // chat.ts, which records failures too) so an all-providers-failed request
      // still appears in /admin/requests. responseJson null = no body produced.
      // result.decision exists even on failure. Fail-open inside recordServed.
      if (deps.record) {
        await recordServed(
          deps.record,
          {
            requestId: traceId,
            apiKeyId: identity.keyId,
            decision: result.decision,
            requestJson,
            responseJson: null,
          },
          (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
        );
      }
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }
    // Record the served (non-stream) request: telemetry row (→ /admin/requests) +
    // verbatim request/response body. Mirrors chat.ts. Fail-open inside recordServed.
    if (deps.record) {
      await recordServed(
        deps.record,
        {
          requestId: traceId,
          apiKeyId: identity.keyId,
          decision: result.decision,
          requestJson,
          responseJson: captureBodies ? JSON.stringify(body) : null,
        },
        (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
      );
    }
    return c.json(body);
  };

  for (const prefix of ["/v1/responses", "/responses", "/openai/v1/responses"]) {
    app.post(`${prefix}/compact`, unsupportedLifecycle("compact"));
    app.post(`${prefix}/input_tokens`, unsupportedLifecycle("input_tokens"));
    app.get(`${prefix}/:response_id/input_items`, unsupportedLifecycle("input_items"));
    app.post(`${prefix}/:response_id/cancel`, unsupportedLifecycle("cancel"));
    app.get(`${prefix}/:response_id`, unsupportedLifecycle("retrieve"));
    app.delete(`${prefix}/:response_id`, unsupportedLifecycle("delete"));
    app.post(prefix, handleResponses);
  }
}
