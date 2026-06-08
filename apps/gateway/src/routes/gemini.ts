import {
  type GeminiRoute,
  parseGeminiPath,
  type RateLimitProbe,
  type RateLimitResult,
} from "@helm/core";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { resolveMemoryScope } from "./memory-scope.js";
import type { MessagesIdentity, PipelineRunResult, RouteError } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import { type RecordServedDeps, recordServed } from "./payload-capture.js";
import { isUpstreamTimeout } from "./stream-error.js";

// POST /v1beta/models/{model}:generateContent / :streamGenerateContent — Google
// Gemini inbound, translated to IR, routed through the SAME core pipeline as
// /v1/chat and /v1/messages, then translated back to the native Gemini wire shape
// (docs/05, issue #34). The FOURTH client-presentation surface.
//
// PURE HTTP ↔ IR glue (CLAUDE.md principle 1): auth → translate(out) → route →
// translate(back). No classify/route/translate logic lives here; each business
// step is an injected dependency. Wiring order is the docs/02 contract: auth →
// translate(out) → route → translate(back).
//
// Gemini diverges from the other surfaces in three HTTP-level ways the route owns:
//   • the model + operation are in the PATH (`{model}:{op}`), parsed by the core
//     pure function `parseGeminiPath` (core never reads a Hono object, principle 1);
//   • auth is `x-goog-api-key` (NOT Authorization: Bearer; Bearer is a fallback);
//   • streaming events are incremental-delta `data:` frames with NO `event:` name and
//     NO `[DONE]` sentinel (docs/05 — Gemini's wire form differs from OpenAI /
//     Anthropic SSE; each frame is a `GenerateContentResponse` the client accumulates).

/** One Gemini error envelope plus the HTTP status to send it with. Error
 *  translation is protocol logic (docs/05) — injected, never hand-assembled. */
export interface GeminiErrorOut {
  status: number;
  body: unknown;
}

/** Per-key rate limiter (core, framework-agnostic). Same instance the OpenAI chat
 *  middleware uses; injected so the self-authenticating Gemini route meters the
 *  resolved key AFTER auth. Optional — omitted = no metering. */
export interface GeminiRateLimiterPort {
  check(probe: RateLimitProbe): Promise<RateLimitResult>;
}

// The route treats the IR as an opaque bag with the fields it must read/stamp.
interface GeminiIRLike {
  stream?: boolean;
  model?: unknown;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface GeminiRouteDeps {
  rateLimiter?: GeminiRateLimiterPort;
  /** Per-key concurrency overflow queue (issue #93) — the SAME process-wide gate
   *  as the chat middleware. Optional — omitted = no gating. */
  concurrencyGate?: ConcurrencyGatePort;
  /** Telemetry + payload recorder (the /admin/requests fix). Optional so existing
   *  tests that omit it record nothing; when wired, every served request (success
   *  OR failure, stream OR non-stream) writes a telemetry row. */
  record?: RecordServedDeps;
  auth: {
    /** Resolve the request credential to an identity, or null when invalid. */
    resolve(credential: string | null): Promise<MessagesIdentity | null>;
  };
  transformer: {
    /** Native Gemini request → IR (throws on a structurally invalid body). */
    transformRequestOut(native: unknown): GeminiIRLike;
    /** IR response → native Gemini response. */
    transformResponseOut(ir: unknown): unknown;
    /** Structured internal error → Gemini error envelope + status. */
    transformErrorOut(err: RouteError): GeminiErrorOut;
  };
  pipeline: {
    run(
      ir: GeminiIRLike,
      identity: MessagesIdentity,
      signal: AbortSignal,
    ): Promise<PipelineRunResult>;
  };
}

// Extract the plaintext credential from x-goog-api-key (Gemini SDK default) or the
// Authorization: Bearer header (friendlier for own clients). Case-sensitive: never
// trim/lowercase a key.
function extractCredential(googKey: string | undefined, auth: string | undefined): string | null {
  if (googKey) return googKey;
  if (auth) {
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]) return m[1];
  }
  return null;
}

// Client disconnect / abort detection — mirrors messages.ts. Used to suppress a
// terminal error frame for a benign disconnect (NOT a provider fault, docs/02).
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

export function registerGeminiRoute(app: Hono<AppEnv>, deps: GeminiRouteDeps): void {
  const { transformer } = deps;

  const sendError = (c: Context<AppEnv>, err: RouteError): Response => {
    const out = transformer.transformErrorOut(err);
    return c.json(out.body as Record<string, unknown>, out.status as 400 | 401 | 404 | 429 | 502);
  };

  // Frees an unclaimed concurrency lease on every exit path (the handler below
  // acquires AFTER its self-auth).
  app.use("/v1beta/models/*", concurrencyReleaseGuard());

  // Hono cannot match the literal ':' in `{model}:generateContent` with a named
  // param, so we mount a catch-all under /v1beta/models and hand the full path +
  // query to the core `parseGeminiPath`. A non-Gemini path → null → 404 (never a
  // silent 200 on a mis-routed /v1beta/* request).
  app.post("/v1beta/models/:rest{.+}", async (c) => {
    const traceId = c.get("trace_id");

    // 0) Route parse FIRST (cheap, pure). The pathname is the part before '?'; the
    //    query carries `alt=sse`. parseGeminiPath returns null for any path that is
    //    not :generateContent / :streamGenerateContent → 404.
    const url = new URL(c.req.url);
    const route: GeminiRoute | null = parseGeminiPath(url.pathname, url.search.replace(/^\?/, ""));
    if (route === null) {
      // A /v1beta/models/* path that is NOT :generateContent / :streamGenerateContent
      // (e.g. :countTokens, :embedContent) is an endpoint Helm does not serve → 404
      // in the Gemini error wire shape. Never a silent 200 on a mis-routed path.
      // NOT_FOUND is not one of the 8 routing ErrorClasses (it is an HTTP-routing
      // concern, not a routing-pipeline failure), so it is assembled here directly.
      return c.json(
        {
          error: {
            code: 404,
            message: "not a Gemini generateContent endpoint",
            status: "NOT_FOUND",
          },
        },
        404,
      );
    }

    // 1) Auth (docs/02 pipeline order). x-goog-api-key preferred, Bearer fallback.
    const credential = extractCredential(
      c.req.header("x-goog-api-key"),
      c.req.header("Authorization"),
    );
    const identity = await deps.auth.resolve(credential);
    if (identity === null) {
      return sendError(c, {
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
    }

    // 1b) Rate limit AFTER auth (needs the resolved key_id), BEFORE translate/route.
    if (deps.rateLimiter !== undefined) {
      const rl = await deps.rateLimiter.check({
        keyId: identity.keyId,
        estimatedTokens: estimateRequestTokens(c),
        now: Date.now(),
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

    // 1c) Concurrency overflow queue (issue #93) AFTER rate-limit: wait for a
    //     slot instead of an instant 429; queue-full / wait timeout → 429 in the
    //     Gemini envelope. Release parked on the context for the guard; the
    //     stream branch claims it and releases at true stream end.
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

    // 2) Parse + translate inbound. A malformed JSON body OR a structurally invalid
    //    Gemini request (the transformer's Zod parse throws) is a CLIENT error →
    //    400 INVALID_ARGUMENT, before routing (docs/07, principle 2 fail-closed).
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
    let ir: GeminiIRLike;
    try {
      ir = transformer.transformRequestOut(native);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "invalid Gemini request";
      return sendError(c, { error_class: "invalid_request", message: detail, trace_id: traceId });
    }

    // 2b) Backfill the PATH model + the parsed stream flag onto the IR. The
    //     transformer defaults model:"gemini" (the path-derived model is supplied
    //     by the route layer — see gemini-transformer.ts). Without this the router
    //     would always receive "gemini" and routing would degrade.
    ir.model = route.model;
    ir.stream = route.stream;
    ir.metadata = { ...(ir.metadata ?? {}), trace_id: traceId };

    // Memory scope (docs/08 Phase 1): parse the four memory headers and stamp them
    // onto the IR metadata bag (mirrors /v1/messages) so the SHARED pipeline's
    // observe phase reads the scope off ir.metadata without touching HTTP.
    const memoryScope = resolveMemoryScope((name) => c.req.header(name), identity.accountId, {
      // Per-key defaults (issue #97); the Gemini wire shape has no per-conversation
      // body signal, so only headers / x-session-key / key defaults apply here.
      defaults: identity.caps?.memory,
    });
    ir.metadata.thread_id = memoryScope.threadId;
    ir.metadata.resource_id = memoryScope.resourceId;
    ir.metadata.project_id = memoryScope.projectId;
    ir.metadata.memory_mode = memoryScope.mode;
    ir.metadata.memory_thread_source = memoryScope.threadSource;

    // 3) Route through the shared core. The per-request abort signal rides along so
    //    a client disconnect is a non-provider fault (docs/02). run() throws a
    //    PipelineError(invalid_request) for an empty request.
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

    // 4) Protocol Adapter (outbound). Gemini streaming events are incremental deltas,
    //    written as nameless `data:` frames — NO `event:` name, NO `[DONE]`.
    if (route.stream) {
      // Claim the concurrency lease (issue #93): hold the slot until the stream
      // body fully drains — release in the stream's own finally, not the guard.
      const releaseConcurrency = c.get("concurrencyRelease");
      c.set("concurrencyRelease", undefined);
      return streamSSE(c, async (sse) => {
        // Accumulate the serialized wire frames so the served response body can be
        // captured (verbatim) alongside the telemetry row in the finally below.
        // Gemini frames are nameless `data:` frames (no `event:` name, no [DONE]).
        const captured: string[] = [];
        try {
          for await (const snapshot of result.streamIR()) {
            const data = JSON.stringify(snapshot);
            if (deps.record) captured.push(`data: ${data}\n\n`);
            await sse.writeSSE({ data });
          }
        } catch (err) {
          // A client disconnect / abort is a benign non-provider fault (docs/02):
          // emit NO error frame. Any other throw emits ONE terminal Gemini error
          // frame so the client never sees a silently truncated stream.
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
            const out = transformer.transformErrorOut(re);
            await sse.writeSSE({ data: JSON.stringify(out.body) });
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
                requestJson: JSON.stringify(native),
                responseJson: captured.join(""),
              },
              (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
            );
          }
        }
      });
    }

    // Non-stream: collect() throws a PipelineError when routing failed (all
    // providers failed) — surface it as the Gemini envelope, never an empty 200.
    let body: unknown;
    try {
      body = transformer.transformResponseOut(await result.collect());
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
            requestJson: JSON.stringify(native),
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
          requestJson: JSON.stringify(native),
          responseJson: JSON.stringify(body),
        },
        (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
      );
    }
    return c.json(body as Record<string, unknown>);
  });
}
