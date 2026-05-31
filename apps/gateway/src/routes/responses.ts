import type { RateLimitProbe, RateLimitResult } from "@helm/core";
import { type ErrorClass, ErrorClassSchema, makeHelmError } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";
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
// MVP scope: NON-STREAMING only. The Responses streaming protocol (response.*
// SSE events) has no transformer yet, so a `stream:true` request is rejected with
// a structured 400 rather than silently mis-served (principle 2, fail-closed). The
// non-stream path is fully wired and routed.

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
  };
  pipeline: {
    run(
      ir: ResponsesIRLike,
      identity: MessagesIdentity,
      signal: AbortSignal,
    ): Promise<PipelineRunResult>;
  };
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
        estimatedTokens: 0,
        now: Date.now(),
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
    ir.metadata = { ...(ir.metadata ?? {}), trace_id: traceId };

    // 3) Streaming is not yet implemented for Responses (no SSE transformer). Reject
    //    explicitly rather than degrade a stream client to a single JSON body.
    if (ir.stream === true) {
      throw helmError(
        "invalid_request",
        "streaming is not yet supported on /v1/responses; retry with stream:false",
        traceId,
      );
    }

    // 4) Route through the shared core, then translate the IR response back to the
    //    native Responses shape. The pipeline throws a PipelineError when routing
    //    failed (all_providers_failed) or for an empty request (invalid_request) —
    //    surface it as the matching OpenAI envelope instead of an empty 200. `run`
    //    throws for the empty-request case; `collect` throws for the routing-failure
    //    case (the seam that previously synthesized an empty assistant message).
    let result: PipelineRunResult;
    try {
      result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
    } catch (err) {
      if (err instanceof PipelineError) throw pipelineToHelm(err, traceId);
      throw err;
    }
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
