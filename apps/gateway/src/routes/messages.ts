import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";

// POST /v1/messages — Anthropic Messages inbound, translated to IR, routed, and
// translated back to the Anthropic wire shape (docs/02 §API Gateway, docs/05).
//
// This file is PURE HTTP ↔ IR glue (CLAUDE.md principle 1): it owns ONLY the
// HTTP adaptation — parse the body, drive auth, hand the native request to the
// injected Anthropic transformer, run the framework-agnostic routing pipeline,
// then serialize the result back (c.json for non-stream, streamSSE for stream).
// NO classify / route / translate logic lives here; every business step is an
// injected dependency so the route stays a thin, testable seam. Wiring order is
// a hard contract aligned with docs/02: auth → translate(out) → route →
// translate(back).

// ── Injected dependency contract ────────────────────────────────────────────

/** Minimal resolved identity the pipeline needs. A superset (caps/role) may be
 *  attached by the concrete resolver; the route treats it as opaque. */
export interface MessagesIdentity {
  keyId: string;
  accountId: string;
  [k: string]: unknown;
}

/** One Anthropic SSE event already serialized to the wire's event/data pair. */
export interface AnthropicSSEFrame {
  event: string;
  data: string;
}

/** The Anthropic-shaped error envelope plus the HTTP status to send it with.
 *  Error translation is protocol logic (docs/05) — it is injected, never hand-
 *  assembled in the route. */
export interface AnthropicErrorOut {
  status: number;
  body: unknown;
}

/** A structured internal error the route can hand to the error translator. */
export interface RouteError {
  error_class: string;
  message: string;
  trace_id: string;
}

/** Outcome of one routing run. Stream vs non-stream is decided by the caller via
 *  the IR's `stream` flag; the route consumes exactly one of the two accessors. */
export interface PipelineRunResult {
  /** Drain the full (non-stream) result into ONE IR response object. */
  collect(): Promise<unknown>;
  /** The IR-level event stream (one object per Anthropic SSE event source). */
  streamIR(): AsyncIterable<{ type: string; [k: string]: unknown }>;
}

export interface MessagesRouteDeps {
  auth: {
    /** Resolve the request credential to an identity, or null when invalid.
     *  Mandatory auth: a null result short-circuits to a 401 (no anonymous
     *  passthrough — startup enforces a key). */
    resolve(credential: string | null): Promise<MessagesIdentity | null>;
  };
  transformers: {
    anthropic: {
      /** Native Anthropic request → IR (inbound Protocol Adapter). */
      transformRequestOut(native: unknown): IRLike | Promise<IRLike>;
      /** IR response → native Anthropic response (outbound Protocol Adapter). */
      transformResponseOut(ir: unknown): unknown | Promise<unknown>;
      /** ONE IR stream event → ONE Anthropic SSE frame (state-machine mapped). */
      transformStreamOut(event: { type: string; [k: string]: unknown }): AnthropicSSEFrame;
      /** Structured internal error → Anthropic error envelope + status. */
      transformErrorOut(err: RouteError): AnthropicErrorOut;
    };
  };
  pipeline: {
    /** Run the routing pipeline on the IR for this identity. `signal` carries the
     *  client-disconnect so the executor can treat an abort as a non-provider
     *  fault (does not trip the circuit breaker). */
    run(ir: IRLike, identity: MessagesIdentity, signal: AbortSignal): Promise<PipelineRunResult>;
  };
}

// The route treats the IR as an opaque bag with the two fields it must read
// (`stream` to branch, `metadata` to stamp trace_id). It never inspects the rest.
interface IRLike {
  stream?: boolean;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// Extract the plaintext credential from x-api-key (Anthropic SDK default) or the
// Authorization: Bearer header. Case-sensitive: never trim/lowercase a key.
function extractCredential(apiKey: string | undefined, auth: string | undefined): string | null {
  if (apiKey) return apiKey;
  if (auth) {
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function registerMessagesRoute(app: Hono<AppEnv>, deps: MessagesRouteDeps): void {
  const { anthropic } = deps.transformers;

  app.post("/v1/messages", async (c) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline: Auth precedes the Protocol Adapter). A
    //    missing/invalid key never reaches the translator or the pipeline.
    const credential = extractCredential(c.req.header("x-api-key"), c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) {
      const out = anthropic.transformErrorOut({
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
      return c.json(out.body as Record<string, unknown>, out.status as 401);
    }

    // 2) Protocol Adapter (inbound): native Anthropic → IR, then stamp trace_id
    //    so it propagates through the whole pipeline (CLAUDE.md / docs/02).
    const native = await c.req.json();
    const ir = await anthropic.transformRequestOut(native);
    ir.metadata = { ...(ir.metadata ?? {}), trace_id: traceId };

    // Map the `x-session-key` request header into the conversation-dimension key
    // session momentum keys off (metadata.conversation_id) — only when the IR did
    // not already carry one. Without this the momentum store is keyed null and
    // never fires in production. The session id is opaque (not a credential): it
    // rides the metadata bag and is never logged here.
    if (ir.metadata.conversation_id == null) {
      const sessionKey = c.req.header("x-session-key");
      if (sessionKey !== undefined && sessionKey.length > 0) {
        ir.metadata.conversation_id = sessionKey;
      }
    }

    // 3) Routing pipeline (framework-agnostic core). The per-request abort signal
    //    rides along so a client disconnect is a non-provider fault, not a breaker
    //    trip (CLAUDE.md / docs/02). Auxiliary failures (classify/eval/cache) are
    //    already fail-open inside core — the route surfaces whatever it returns.
    const result = await deps.pipeline.run(ir, identity, c.req.raw.signal);

    // 4) Protocol Adapter (outbound): stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      return streamSSE(c, async (sse) => {
        // Every IR event is mapped by the transformer's explicit state machine;
        // we NEVER forward a raw upstream chunk (CLAUDE.md principle 8). The
        // transformer already guards start-before-delta and idempotent close.
        for await (const event of result.streamIR()) {
          const frame = anthropic.transformStreamOut(event);
          await sse.writeSSE({ event: frame.event, data: frame.data });
        }
      });
    }

    const body = await anthropic.transformResponseOut(await result.collect());
    return c.json(body as Record<string, unknown>);
  });
}
