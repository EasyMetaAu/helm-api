import type { RateLimitProbe, RateLimitResult } from "@helm/core";
import { type ErrorClass, ErrorClassSchema, makeHelmError } from "@helm/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { resolveMemoryScope } from "./memory-scope.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";

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
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  transformer: {
    /** native Responses request → IR (throws on a structurally invalid body). */
    transformRequestOut(native: unknown): ResponsesIRLike;
    /** IR response → native Responses response. */
    transformResponseOut(ir: unknown): unknown;
    /** ONE IR stream event → ONE Responses SSE frame (event/data pair). The
     *  pipeline already produced the response.* events; this only serializes. */
    transformStreamOut(event: { type: string; [k: string]: unknown }): {
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
  app.post("/v1/responses", async (c) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline order).
    const credential = extractCredential(c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) throw helmError("auth_error", "missing or invalid API key", traceId);

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

    // 2) Parse + translate inbound. A malformed JSON body OR a structurally invalid
    //    Responses request (the transformer's Zod parse throws) is a CLIENT error →
    //    400 invalid_request, before routing (docs/07, principle 2 fail-closed).
    let native: unknown;
    try {
      native = await c.req.json();
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
    const memoryScope = resolveMemoryScope((name) => c.req.header(name));
    ir.metadata = {
      ...(ir.metadata ?? {}),
      trace_id: traceId,
      thread_id: memoryScope.threadId,
      resource_id: memoryScope.resourceId,
      project_id: memoryScope.projectId,
      memory_mode: memoryScope.mode,
    };

    // 3) Route through the shared core. The pipeline throws a PipelineError when
    //    routing failed (all_providers_failed) or for an empty request
    //    (invalid_request) — surface it as the matching OpenAI envelope instead of
    //    an empty 200. `run` itself throws for the empty-request case (pre-stream,
    //    so it still reaches onError as a 400/502); the per-accessor failure
    //    (collect/streamIR) covers the routing-failure case.
    let result: PipelineRunResult;
    try {
      result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
    } catch (err) {
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }

    // 4) Outbound: stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      return streamSSE(c, async (sse) => {
        // Each IR event is serialized by the transformer's stream mapping; the
        // pipeline already ran the Responses state machine (principle 8 — we never
        // forward a raw upstream chunk). There is NO [DONE] sentinel; the terminal
        // response.completed closes the stream.
        let nextErrorSequence = 0;
        try {
          for await (const event of result.streamIR()) {
            if (typeof event.sequence_number === "number")
              nextErrorSequence = event.sequence_number + 1;
            const frame = deps.transformer.transformStreamOut(event);
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
                    code: "internal_error",
                    message: err instanceof Error ? err.message : "upstream error",
                    traceId,
                    sequenceNumber: nextErrorSequence,
                  });
            await sse.writeSSE({ event: "error", data: JSON.stringify(body) });
          }
        }
      });
    }

    // Non-stream: collect() throws a PipelineError when routing failed (all
    // providers failed) — surface it as the OpenAI envelope instead of the empty
    // 200 a synthesized placeholder body would produce.
    let collected: unknown;
    try {
      collected = await result.collect();
    } catch (err) {
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }
    const body = deps.transformer.transformResponseOut(collected);
    return c.json(body as Record<string, unknown>);
  });
}
