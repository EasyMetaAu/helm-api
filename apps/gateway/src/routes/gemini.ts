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
import { stampServingAccount } from "../runtime/serving-account.js";
import { atEventBoundary, HEARTBEAT_COMMENT, withHeartbeat } from "./heartbeat.js";
import { resolveMemoryScope } from "./memory-scope.js";
import type { MessagesIdentity, PipelineRunResult, RouteError } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import { nativeCarrierFromParsedBody } from "./native-carrier.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";
import { isUpstreamTimeout } from "./stream-error.js";

// POST /v1beta/models/{model}:generateContent / :streamGenerateContent and
// POST /models/{model}:generateContent / :streamGenerateContent — Google Gemini
// inbound, translated to IR, routed through the SAME core pipeline as /v1/chat
// and /v1/messages, then translated back to the native Gemini wire shape (docs/05,
// issue #34). The FOURTH client-presentation surface.
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
  countTokens?(
    body: Record<string, unknown>,
    identity: MessagesIdentity,
    signal: AbortSignal,
  ): Promise<unknown>;
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
  /** SSE keep-alive cadence (ms) for streaming responses; read fresh per request from
   *  runtime.sse_heartbeat_ms. Optional — absent/0 = no heartbeat. Inter-chunk only. */
  sseHeartbeatMs?: () => number;
}

function hasCountTokensContent(native: unknown): boolean {
  if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
  const body = native as {
    contents?: unknown;
    generateContentRequest?: { contents?: unknown };
  };
  return (
    Array.isArray(body.contents) ||
    (typeof body.generateContentRequest === "object" &&
      body.generateContentRequest !== null &&
      Array.isArray(body.generateContentRequest.contents))
  );
}

function estimateGeminiCountTokens(requestJson: string): number {
  return Math.max(1, Math.ceil(requestJson.length / 4));
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
  app.use("/models/*", concurrencyReleaseGuard());

  // Hono cannot match the literal ':' in `{model}:generateContent` with a named
  // param, so we mount catch-alls under both Gemini path families and hand the
  // full path + query to the core `parseGeminiPath`. A non-Gemini path → null →
  // 404 (never a silent 200 on a mis-routed Gemini request).
  const handleGemini = async (c: Context<AppEnv>) => {
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

    // 2) countTokens is a local deterministic estimate. It shares auth / rate /
    //    concurrency with generation, but it must never enter the generation
    //    transformer or provider pipeline.
    if (route.operation === "countTokens") {
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
      if (!hasCountTokensContent(native)) {
        return sendError(c, {
          error_class: "invalid_request",
          message: "invalid Gemini countTokens request body",
          trace_id: traceId,
        });
      }
      if (deps.countTokens !== undefined) {
        try {
          const counted = await deps.countTokens(
            { ...(native as Record<string, unknown>), model: route.model },
            identity,
            c.req.raw.signal,
          );
          return c.json(counted as Record<string, unknown>);
        } catch {
          // Token helpers are SDK compatibility helpers. A provider counter
          // outage must not turn the route into a 5xx when deterministic local
          // estimation is available.
        }
      }
      return c.json({ totalTokens: estimateGeminiCountTokens(requestJson), estimated: true });
    }

    // 3) Parse + translate inbound. A malformed JSON body OR a structurally invalid
    //    Gemini request (the transformer's Zod parse throws) is a CLIENT error →
    //    400 INVALID_ARGUMENT, before routing (docs/07, principle 2 fail-closed).
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

    const nativeCarrier = nativeCarrierFromParsedBody({
      protocol: "gemini",
      native,
      rawBody: requestJson,
      headers: c.req.raw.headers,
    });
    if (nativeCarrier !== null) {
      ir.metadata.native_request = nativeCarrier;
    }

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

    // Capture the verbatim request/response bodies only when capture_payloads is ON
    // (the telemetry row is always written regardless). Gating the buffering here
    // stops long/concurrent streams from accumulating the full body when capture is
    // off (review P2).
    const captureBodies = deps.record !== undefined && captureEnabled(deps.record);

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
        // SSE keep-alive: emit a `:` comment during inter-chunk idle (wire-only, never
        // captured) so a proxy/client idle-timeout does not sever a long healthy stream.
        // Gemini frames are whole `data:` frames (writeSSE) → always at a boundary.
        // 0 = disabled (today's behavior).
        const heartbeatMs = deps.sseHeartbeatMs?.() ?? 0;
        let lastWrite: string | null = null;
        try {
          for await (const item of withHeartbeat(result.streamIR(), {
            heartbeatMs,
            signal: c.req.raw.signal,
          })) {
            if (item.type === "beat") {
              if (atEventBoundary(lastWrite)) await sse.write(HEARTBEAT_COMMENT);
              continue;
            }
            const snapshot = item.value;
            if (result.nativePassthrough === true) {
              const frame = snapshot as { data?: unknown; raw?: unknown };
              if (typeof frame.raw === "string") {
                if (captureBodies) captured.push(frame.raw);
                await sse.write(frame.raw);
                lastWrite = frame.raw; // verbatim bytes may end mid-frame
              } else {
                const data = typeof frame.data === "string" ? frame.data : JSON.stringify(snapshot);
                if (captureBodies) captured.push(`data: ${data}\n\n`);
                await sse.writeSSE({ data });
                lastWrite = "\n\n";
              }
            } else {
              const data = JSON.stringify(snapshot);
              if (captureBodies) captured.push(`data: ${data}\n\n`);
              await sse.writeSSE({ data });
              lastWrite = "\n\n"; // writeSSE emits a complete frame — always a boundary
            }
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
            const data = JSON.stringify(out.body);
            if (captureBodies) captured.push(`data: ${data}\n\n`);
            await sse.writeSSE({ data });
          }
        } finally {
          releaseConcurrency?.();
          // Record AFTER releaseConcurrency (never extend the hold) and AFTER the
          // for-await loop ended so the pipeline's own streamIR finally (cost
          // backfill) already mutated result.decision. result.decision exists even
          // on a pre-stream failure, so a failed stream still records. Fail-open.
          if (deps.record) {
            stampServingAccount(result.decision, result.servingAccount ?? null);
            await recordServed(
              deps.record,
              {
                requestId: traceId,
                apiKeyId: identity.keyId,
                decision: result.decision,
                requestJson,
                responseJson: captureBodies ? captured.join("") : null,
                upstreamRequestJson: result.upstreamRequest ?? null,
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
      const collected = await result.collect();
      body =
        result.nativePassthrough === true ? collected : transformer.transformResponseOut(collected);
    } catch (err) {
      // Record the FAILED served request before surfacing the error (mirrors
      // chat.ts) so an all-providers-failed request still appears in
      // /admin/requests. responseJson null = no body. result.decision exists even
      // on failure. Fail-open inside recordServed.
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
            upstreamRequestJson: result.upstreamRequest ?? null,
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
      stampServingAccount(result.decision, result.servingAccount ?? null);
      await recordServed(
        deps.record,
        {
          requestId: traceId,
          apiKeyId: identity.keyId,
          decision: result.decision,
          requestJson,
          responseJson: captureBodies ? JSON.stringify(body) : null,
          upstreamRequestJson: result.upstreamRequest ?? null,
        },
        (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
      );
    }
    return c.json(body as Record<string, unknown>);
  };

  app.post("/v1beta/models/:rest{.+}", handleGemini);
  app.post("/models/:rest{.+}", handleGemini);
}
