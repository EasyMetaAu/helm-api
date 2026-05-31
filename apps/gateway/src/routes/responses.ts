import { makeHelmError } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";

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

export interface ResponsesRouteDeps {
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

export function registerResponsesRoute(app: Hono<AppEnv>, deps: ResponsesRouteDeps): void {
  app.post("/v1/responses", async (c) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline order).
    const credential = extractCredential(c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) throw helmError("auth_error", "missing or invalid API key", traceId);

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
    //    native Responses shape.
    const result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
    const body = deps.transformer.transformResponseOut(await result.collect());
    return c.json(body as Record<string, unknown>);
  });
}
