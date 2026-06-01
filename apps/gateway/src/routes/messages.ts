import type { CreditCheckResult, CreditProbe, RateLimitProbe, RateLimitResult } from "@helm/core";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { resolveMemoryScope } from "./memory-scope.js";
import { PipelineError } from "./messages-pipeline.js";

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
  /** Per-key caps resolved from the ApiKeyRecord. `rateLimit` carries the key's
   *  own RPM/TPM override (null = inherit the system default) so this self-auth
   *  path enforces per-key limits, mirroring the OpenAI chat middleware. */
  caps?: {
    rateLimit?: { rpm: number | null; tpm: number | null };
    [k: string]: unknown;
  };
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
  /** The outbound-protocol event stream: one object per wire event. For Anthropic
   *  each carries a `type` (the SSE event name); for Gemini each is a full snapshot
   *  GenerateContentResponse (no `type`). The route serializes them per protocol. */
  streamIR(): AsyncIterable<Record<string, unknown>>;
}

/** Per-key rate limiter (core, framework-agnostic). Same instance the OpenAI
 *  chat middleware uses; injected here so the self-authenticating Anthropic route
 *  meters the resolved key AFTER auth (closing the rate-limit bypass on
 *  /v1/messages). Optional — omitted = no metering (the limiter itself no-ops
 *  when rate limiting is disabled). */
export interface MessagesRateLimiterPort {
  check(probe: RateLimitProbe): Promise<RateLimitResult>;
}

/** Pre-request credit gate (core, framework-agnostic; Issue #37). Same instance
 *  the OpenAI chat middleware uses; injected here so the self-authenticating
 *  Anthropic route applies the account-credit gate AFTER auth. Optional — omitted
 *  = no gate (the gate itself no-ops when credits are disabled). NOTE (D8): the
 *  GATE applies here, but the post-served DEBIT does NOT (the Anthropic pipeline
 *  has no telemetry-persist + cost-backfill envelope to hook). */
export interface MessagesCreditGatePort {
  check(probe: CreditProbe): Promise<CreditCheckResult>;
}

export interface MessagesRouteDeps {
  rateLimiter?: MessagesRateLimiterPort;
  creditGate?: MessagesCreditGatePort;
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
      transformStreamOut(event: Record<string, unknown>): AnthropicSSEFrame;
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

// Client disconnect / abort detection — mirrors chat.ts. Used to suppress a
// terminal error frame for a benign disconnect (NOT a provider fault, docs/02).
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

export function registerMessagesRoute(app: Hono<AppEnv>, deps: MessagesRouteDeps): void {
  const { anthropic } = deps.transformers;

  // Map a structured internal error → Anthropic envelope + status, then send it.
  const sendError = (c: Context<AppEnv>, err: RouteError): Response => {
    const out = anthropic.transformErrorOut(err);
    return c.json(out.body as Record<string, unknown>, out.status as ContentfulStatusCode);
  };

  app.post("/v1/messages", async (c) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline: Auth precedes the Protocol Adapter). A
    //    missing/invalid key never reaches the translator or the pipeline.
    const credential = extractCredential(c.req.header("x-api-key"), c.req.header("Authorization"));
    const identity = await deps.auth.resolve(credential);
    if (identity === null) {
      return sendError(c, {
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
    }

    // 1b) Rate limit AFTER auth (needs the resolved key_id) and BEFORE translate/
    //     route (cut off cost before classification/eval). Mirrors the OpenAI chat
    //     middleware but emits the ANTHROPIC envelope. No-op when the limiter
    //     reports limit 0 (disabled / both dimensions unlimited). A store failure
    //     in check() propagates (fail-CLOSED) → onError, never an unmetered pass.
    if (deps.rateLimiter !== undefined) {
      const rl = await deps.rateLimiter.check({
        keyId: identity.keyId,
        // Same Content-Length/4 estimate the chat middleware uses, so per-key TPM
        // is actually metered here (not the old hard-coded 0 that left TPM open).
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
          return sendError(c, {
            error_class: "rate_limited",
            message: `rate limit exceeded (${rl.limitedBy})`,
            trace_id: traceId,
          });
        }
      }
    }

    // 1c) Credit gate AFTER rate limit (Issue #37). Mirrors the OpenAI chat
    //     middleware but emits the ANTHROPIC envelope on rejection. No-op when
    //     credits are disabled (the gate never reads the store). A store failure in
    //     check() propagates (fail-CLOSED) → onError, never an over-quota pass. D8:
    //     the gate applies on this face; the post-served debit does NOT.
    if (deps.creditGate !== undefined) {
      const cg = await deps.creditGate.check({ accountId: identity.accountId });
      if (!cg.allowed) {
        return sendError(c, {
          error_class: "rate_limited",
          message: "insufficient account credit",
          trace_id: traceId,
        });
      }
    }

    // 2) Protocol Adapter (inbound): native Anthropic → IR, then stamp trace_id
    //    so it propagates through the whole pipeline (CLAUDE.md / docs/02). A
    //    malformed JSON body is a CLIENT error → 400 invalid_request (docs/07,
    //    principle 2 fail-closed), raised after auth but before translate/route so
    //    it never 5xx's as an upstream fault.
    let native: unknown;
    try {
      native = await c.req.json();
    } catch {
      return sendError(c, {
        error_class: "invalid_request",
        message: "malformed JSON request body",
        trace_id: traceId,
      });
    }
    // The REAL Anthropic transformer Zod-validates and THROWS on a structurally
    // invalid body (e.g. {messages:[]}). Wrap it so that throw becomes a 400 in the
    // ANTHROPIC envelope here, instead of escaping to onError → an OpenAI-shaped
    // 502 (principle 2 fail-closed; mirrors how responses.ts guards its transform).
    let ir: IRLike;
    try {
      ir = await anthropic.transformRequestOut(native);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "invalid Anthropic request";
      return sendError(c, { error_class: "invalid_request", message: detail, trace_id: traceId });
    }
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

    // Memory scope (docs/08 Phase 1): parse the four memory headers at this HTTP
    // boundary and stamp them onto the IR metadata bag (mirrors conversation_id),
    // so the framework-agnostic pipeline can read the scope off ir.metadata
    // without ever touching HTTP (CLAUDE.md principle 1). Absent/illegal headers
    // → off + null (default-safe). The ids are opaque (not credentials) and are
    // never logged here.
    const memoryScope = resolveMemoryScope((name) => c.req.header(name));
    ir.metadata.thread_id = memoryScope.threadId;
    ir.metadata.resource_id = memoryScope.resourceId;
    ir.metadata.project_id = memoryScope.projectId;
    ir.metadata.memory_mode = memoryScope.mode;

    // 3) Routing pipeline (framework-agnostic core). The per-request abort signal
    //    rides along so a client disconnect is a non-provider fault, not a breaker
    //    trip (CLAUDE.md / docs/02). Auxiliary failures (classify/eval/cache) are
    //    already fail-open inside core — the route surfaces whatever it returns.
    //    `run` itself throws a PipelineError(invalid_request) for an empty request
    //    (no placeholder synthesis) — map it to a 400 in the Anthropic envelope.
    let result: PipelineRunResult;
    try {
      result = await deps.pipeline.run(ir, identity, c.req.raw.signal);
    } catch (err) {
      if (err instanceof PipelineError) {
        return sendError(c, {
          error_class: err.error_class,
          message: err.message,
          trace_id: traceId,
        });
      }
      throw err;
    }

    // 4) Protocol Adapter (outbound): stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      return streamSSE(c, async (sse) => {
        // Every IR event is mapped by the transformer's explicit state machine;
        // we NEVER forward a raw upstream chunk (CLAUDE.md principle 8). The
        // transformer already guards start-before-delta and idempotent close.
        try {
          for await (const event of result.streamIR()) {
            const frame = anthropic.transformStreamOut(event);
            await sse.writeSSE({ event: frame.event, data: frame.data });
          }
        } catch (err) {
          // A client disconnect / abort is a benign non-provider fault (docs/02):
          // emit NO error frame. Any other throw — incl. a PipelineError when all
          // providers failed before the stream started — emits a TERMINAL Anthropic
          // error event so the client never sees a silently truncated stream.
          if (!isAbort(err, c.req.raw.signal)) {
            const re: RouteError =
              err instanceof PipelineError
                ? { error_class: err.error_class, message: err.message, trace_id: traceId }
                : { error_class: "upstream_error", message: "upstream error", trace_id: traceId };
            const out = anthropic.transformErrorOut(re);
            await sse.writeSSE({ event: "error", data: JSON.stringify(out.body) });
          }
        }
      });
    }

    // Non-stream: collect() throws a PipelineError when routing failed (all
    // providers failed) — surface it as the Anthropic envelope instead of the
    // empty 200 a synthesized placeholder body would produce.
    let body: unknown;
    try {
      body = await anthropic.transformResponseOut(await result.collect());
    } catch (err) {
      if (err instanceof PipelineError) {
        return sendError(c, {
          error_class: err.error_class,
          message: err.message,
          trace_id: traceId,
        });
      }
      throw err;
    }
    return c.json(body as Record<string, unknown>);
  });
}
