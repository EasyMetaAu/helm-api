import {
  type BudgetCaps,
  type DecisionRecord,
  extractBillingHeaderIdentity,
  type RateLimitProbe,
  type RateLimitResult,
} from "@helm/core";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { type MemoryKeyDefaults, resolveMemoryScope } from "./memory-scope.js";
import { PipelineError } from "./messages-pipeline.js";
import { nativeCarrierFromParsedBody } from "./native-carrier.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";
import { isUpstreamTimeout } from "./stream-error.js";

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
    /** Per-key max in-flight requests (issue #93). null/absent = unlimited. */
    concurrencyLimit?: number | null;
    /** Per-key usage budgets (docs/06), read by the pipeline's budget gate/settle.
     *  Absent = no budgets on this face. */
    budget?: BudgetCaps;
    /** Per-key memory defaults (issue #97), read by the route's memory scope
     *  resolver; absent = memory off unless headers say otherwise. */
    memory?: MemoryKeyDefaults;
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
  /** The live DecisionRecord for this run (docs/07). Exposed so the three pipeline
   *  faces can record telemetry AFTER consumption — the SAME object the pipeline
   *  mutates in place (backfillCompletionCost during the stream finally), so once
   *  the stream/collect has drained it carries the final cost. Present even on a
   *  routing failure (final.status === "error"), so a failed face still records. */
  readonly decision: DecisionRecord;
  /** Native protocol passthrough (#217): true when the routing core forwarded the
   *  request untranslated and `collect()` returns the upstream's VERBATIM native
   *  response. The route reads this to BYPASS transformResponseOut and hand the
   *  native body back byte-for-byte. Absent/false → today's translate path. */
  readonly nativePassthrough?: boolean;
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

export interface MessagesRouteDeps {
  rateLimiter?: MessagesRateLimiterPort;
  /** Per-key concurrency overflow queue (issue #93). The SAME process-wide gate
   *  the chat middleware uses, so a key's in-flight count spans every surface.
   *  Optional — omitted = no gating (the gate also no-ops while disabled). */
  concurrencyGate?: ConcurrencyGatePort;
  /** Telemetry + payload recorder (the /admin/requests fix). Optional so existing
   *  tests that omit it record nothing; when wired, every served request (success
   *  OR failure, stream OR non-stream) writes a telemetry row. */
  record?: RecordServedDeps;
  /** Optional provider-backed Anthropic token counter. Missing/failing counter
   *  falls back to a deterministic local estimate, so helper failures never
   *  affect normal generation. */
  countTokens?(
    body: Record<string, unknown>,
    identity: MessagesIdentity,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
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

function estimateAnthropicInputTokens(value: unknown): number {
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
  const text = [obj.system, obj.messages, obj.tools, obj.tool_choice]
    .map(collect)
    .filter((s) => s.length > 0)
    .join("\n");
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
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

  // Frees an unclaimed concurrency lease on every exit path (the handler below
  // acquires AFTER its self-auth, so the slot cannot be taken by middleware).
  app.use("/v1/messages", concurrencyReleaseGuard());

  const resolveIdentity = async (c: Context<AppEnv>): Promise<MessagesIdentity | null> => {
    const credential = extractCredential(c.req.header("x-api-key"), c.req.header("Authorization"));
    return deps.auth.resolve(credential);
  };

  app.post("/api/event_logging/batch", async (c) => {
    const traceId = c.get("trace_id");
    const identity = await resolveIdentity(c);
    if (identity === null) {
      return sendError(c, {
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
    }
    return c.json({ status: "ok" });
  });

  app.post("/v1/messages/count_tokens", async (c) => {
    const traceId = c.get("trace_id");
    const identity = await resolveIdentity(c);
    if (identity === null) {
      return sendError(c, {
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
    }
    let native: unknown;
    try {
      native = JSON.parse(await c.req.text());
    } catch {
      return sendError(c, {
        error_class: "invalid_request",
        message: "malformed JSON request body",
        trace_id: traceId,
      });
    }
    const obj = native && typeof native === "object" ? (native as Record<string, unknown>) : null;
    if (obj === null || typeof obj.model !== "string" || obj.model.length === 0) {
      return sendError(c, {
        error_class: "invalid_request",
        message: "model parameter is required",
        trace_id: traceId,
      });
    }
    if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
      return sendError(c, {
        error_class: "invalid_request",
        message: "messages parameter is required",
        trace_id: traceId,
      });
    }
    if (deps.countTokens !== undefined) {
      try {
        return c.json(await deps.countTokens(obj, identity, c.req.raw.signal));
      } catch {
        // Token helpers are compatibility helpers, not generation. Fall back to a
        // deterministic estimate instead of making /v1/messages/count_tokens flaky.
      }
    }
    return c.json({ input_tokens: estimateAnthropicInputTokens(native), estimated: true });
  });

  app.post("/v1/messages", async (c) => {
    const traceId = c.get("trace_id");

    // 1) Auth FIRST (docs/02 pipeline: Auth precedes the Protocol Adapter). A
    //    missing/invalid key never reaches the translator or the pipeline.
    const identity = await resolveIdentity(c);
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

    // 1c) Concurrency overflow queue (issue #93) AFTER rate-limit: a queued
    //     request WAITS for a slot instead of an instant 429; queue-full / wait
    //     timeout → 429 in the Anthropic envelope. The release is parked on the
    //     context so concurrencyReleaseGuard frees it on every non-stream exit
    //     path; the stream branch claims it and releases at true stream end.
    if (deps.concurrencyGate !== undefined) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.caps?.concurrencyLimit ?? null,
        signal: c.req.raw.signal,
      });
      if (!acquired.ok) {
        c.header("retry-after", String(acquired.retryAfterSeconds));
        return sendError(c, {
          error_class: "rate_limited",
          message:
            acquired.reason === "queue_full"
              ? "concurrency queue is full"
              : "timed out waiting for a concurrency slot",
          trace_id: traceId,
        });
      }
      c.set("concurrencyRelease", acquired.release);
    }

    // 2) Protocol Adapter (inbound): native Anthropic → IR, then stamp trace_id
    //    so it propagates through the whole pipeline (CLAUDE.md / docs/02). A
    //    malformed JSON body is a CLIENT error → 400 invalid_request (docs/07,
    //    principle 2 fail-closed), raised after auth but before translate/route so
    //    it never 5xx's as an upstream fault.
    let requestJson = "";
    let native: unknown;
    try {
      requestJson = await c.req.text();
      native = JSON.parse(requestJson);
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

    // Capture the real CLI's billing identity (version + entrypoint) from the native
    // system[0] block BEFORE transformRequestOut stripped it, and stamp it onto the IR
    // metadata bag (core never parses HTTP — principle 1; this reads the already-parsed
    // body). The native-Anthropic subscription executor re-emits the client's own
    // version with a cache-stable cch instead of a pinned spoof (anti-ban). Null/absent
    // for non-CLI traffic → the executor uses its baked fallback version.
    const clientBilling = extractBillingHeaderIdentity(
      (native as { system?: unknown } | null)?.system,
    );
    if (clientBilling !== null) ir.metadata.client_billing_header = clientBilling;

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
    const nativeMetaBag =
      native && typeof native === "object" && (native as Record<string, unknown>).metadata
        ? ((native as Record<string, unknown>).metadata as Record<string, unknown>)
        : null;
    const sig = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const memoryScope = resolveMemoryScope((name) => c.req.header(name), identity.accountId, {
      defaults: identity.caps?.memory,
      signals: {
        metadataThreadId: sig(nativeMetaBag?.thread_id) ?? sig(nativeMetaBag?.conversation_id),
        // Anthropic body metadata.user_id — the session-stable hash Claude Code
        // and OpenClaw already send (issue #97 fallback chain).
        metadataUserId: sig(nativeMetaBag?.user_id),
      },
    });
    ir.metadata.thread_id = memoryScope.threadId;
    ir.metadata.resource_id = memoryScope.resourceId;
    ir.metadata.project_id = memoryScope.projectId;
    ir.metadata.memory_mode = memoryScope.mode;
    ir.metadata.memory_thread_source = memoryScope.threadSource;

    // Native protocol passthrough carrier (#217). Stamp the VERBATIM parsed inbound
    // body onto the IR metadata bag (same HTTP→core hand-off as client_billing_header
    // above); the pipeline reads it into InternalRequest.native_request and the routing
    // core's guard decides whether to forward it untranslated. NEVER logged. Covers
    // BOTH stream and non-stream (Phase 2 added streaming passthrough): the native
    // streaming body already carries stream:true, so the same verbatim body is the
    // carrier — the guard + executor decide whether to actually forward it.
    const nativeCarrier = nativeCarrierFromParsedBody({
      protocol: "anthropic_messages",
      native,
      rawBody: requestJson,
      headers: c.req.raw.headers,
    });
    if (nativeCarrier !== null) {
      ir.metadata.native_request = nativeCarrier;
    }

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

    // Capture the verbatim request/response bodies only when capture_payloads is ON
    // (the telemetry row is always written regardless). Gating the buffering here
    // stops long/concurrent streams from accumulating the full body when capture is
    // off (review P2).
    const captureBodies = deps.record !== undefined && captureEnabled(deps.record);

    // 4) Protocol Adapter (outbound): stream vs non-stream, isomorphic shape.
    if (ir.stream === true) {
      // Claim the concurrency lease (issue #93): the guard middleware fires as
      // soon as this Response is returned, but the slot must stay held until
      // the stream body fully drains — release in the stream's own finally.
      const releaseConcurrency = c.get("concurrencyRelease");
      c.set("concurrencyRelease", undefined);
      return streamSSE(c, async (sse) => {
        // Accumulate the serialized wire frames so the served response body can be
        // captured (verbatim) alongside the telemetry row in the finally below.
        const captured: string[] = [];
        // Translate path: every IR event is mapped by the transformer's explicit
        // state machine; we NEVER forward a raw upstream chunk through the
        // convertOpenAIStreamToAnthropic machine blind (CLAUDE.md principle 8). The
        // transformer already guards start-before-delta and idempotent close.
        // Native passthrough path (#217 Phase 2): the pipeline already split the
        // upstream Anthropic SSE into VERBATIM {event,data} frames (the data payload
        // is the exact upstream JSON string) — forward them directly, BYPASSING
        // transformStreamOut so the bytes reach the client byte-for-byte. The state
        // machine (the #221/#222 bug source) is ELIMINATED on this path, not replaced.
        // Capture stays native on both ends; an upstream error mid-passthrough still
        // surfaces the Anthropic terminal error frame below (catch is unchanged).
        try {
          for await (const event of result.streamIR()) {
            const frame =
              result.nativePassthrough === true
                ? (event as { event: string; data: string; raw?: string })
                : { ...anthropic.transformStreamOut(event), raw: undefined };
            const raw = frame.raw;
            if (captureBodies)
              captured.push(raw ?? `event: ${frame.event}\ndata: ${frame.data}\n\n`);
            if (raw !== undefined) {
              await sse.write(raw);
            } else {
              await sse.writeSSE({ event: frame.event, data: frame.data });
            }
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
                : {
                    // Preserve a mid-stream idle timeout instead of upstream_error.
                    error_class: isUpstreamTimeout(err) ? "timeout" : "upstream_error",
                    message: isUpstreamTimeout(err) ? "upstream timed out" : "upstream error",
                    trace_id: traceId,
                  };
            const out = anthropic.transformErrorOut(re);
            const data = JSON.stringify(out.body);
            if (captureBodies) captured.push(`event: error\ndata: ${data}\n\n`);
            await sse.writeSSE({ event: "error", data });
          }
        } finally {
          releaseConcurrency?.();
          // Record AFTER releaseConcurrency (never extend the hold) and AFTER the
          // for-await loop ended so the pipeline's own streamIR finally (cost
          // backfill) already mutated result.decision. result.decision exists even
          // on a pre-stream failure, so a failed stream still records. Fail-open.
          if (deps.record) {
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

    // Non-stream: collect() throws a PipelineError when routing failed (all
    // providers failed) — surface it as the Anthropic envelope instead of the
    // empty 200 a synthesized placeholder body would produce.
    let body: unknown;
    try {
      const collected = await result.collect();
      // Native protocol passthrough (#217): collect() already returned the upstream's
      // VERBATIM native response (it bypassed openAIBodyToIR). Skip transformResponseOut
      // so the native body reaches the client BYTE-FOR-BYTE; the translate path is
      // unchanged for every non-passthrough request.
      body =
        result.nativePassthrough === true
          ? collected
          : await anthropic.transformResponseOut(collected);
    } catch (err) {
      // Record the FAILED served request before surfacing the error (mirrors
      // chat.ts) so an all-providers-failed request still appears in
      // /admin/requests. responseJson null = no body. result.decision exists even
      // on failure. Fail-open inside recordServed.
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
      if (err instanceof PipelineError) {
        return sendError(c, {
          error_class: err.error_class,
          message: err.message,
          trace_id: traceId,
        });
      }
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
    return c.json(body as Record<string, unknown>);
  });
}
