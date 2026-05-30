import type {
  ChatCompletionRequest,
  DecisionRecord,
  ExecutionResult,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { type HelmError, type InternalRequest, makeHelmError } from "@helm/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";

// POST /v1/chat/completions — Phase 1 routing pipeline wiring. This file is
// PURE HTTP adaptation (CLAUDE.md principle 1): parse the OpenAI request into an
// InternalRequest, call the framework-agnostic `routeRequest` (injected as
// `route`), then translate its ExecutionResult back to HTTP — `c.json` for
// non-stream, `streamSSE` for stream:true. ALL routing logic (classify, policy,
// lane resolve, capability filter, circuit breaker, fallback) lives in core; the
// Phase 0 constant passthrough is gone. Registered on an app that already
// use()s auth, so `identity` is present.

export interface ChatRouteDeps {
  /** Bound core orchestrator: routeRequest(req, coreDeps) with deps closed over.
   *  `signal` is the per-request client-disconnect signal — the gateway binds
   *  the per-request `execute` (provider invoke) to it. */
  route: (
    req: InternalRequest,
    opts: RouteOptions,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>;
  telemetry: TelemetryStore;
  redact: (payload: unknown) => unknown;
  now: () => number;
}

// Minimal identity shape the adapter reads (subset of middleware/auth's
// AuthIdentity — kept local so chat.ts doesn't depend on the middleware type).
interface ChatIdentity {
  keyId: string;
  accountId: string;
  orgId: string | null;
  userId: string | null;
  caps: { allowCustomModel: boolean };
}

// Map the OpenAI chat request body to the normalized InternalRequest (Protocol
// Adapter, openai_chat). MVP: messages/tools/response_format pass through as the
// loose normalized shape; deeper per-protocol narrowing is the docs/05 tasks.
function toInternalRequest(
  body: ChatCompletionRequest,
  traceId: string,
  identity: ChatIdentity,
): InternalRequest {
  const messages = Array.isArray(body.messages)
    ? (body.messages as InternalRequest["messages"])
    : [{ role: "user", content: "" }];
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "auto";

  return {
    request_id: traceId,
    protocol: "openai_chat",
    account_id: identity.accountId,
    api_key_id: identity.keyId,
    user_id: identity.userId,
    org_id: identity.orgId,
    requested_model: model,
    messages,
    tools: Array.isArray(body.tools) ? (body.tools as unknown[]) : null,
    response_format:
      body.response_format && typeof body.response_format === "object"
        ? (body.response_format as Record<string, unknown>)
        : null,
    attachments: null,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
    stream: body.stream === true,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  };
}

function structuredError(error: HelmError, traceId: string): HelmHttpError {
  // Re-stamp the trace id so the response always reflects this request.
  return new HelmHttpError({ ...error, trace_id: traceId });
}

// Client disconnect / abort detection — mirrors the executor + error-handler
// semantics. Used only to suppress an error frame for a benign disconnect.
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatRouteDeps): void {
  app.post("/v1/chat/completions", async (c) => {
    const traceId = c.get("trace_id");
    const identity = c.get("identity") as unknown as ChatIdentity;
    const body = (await c.req.json()) as ChatCompletionRequest;

    const internal = toInternalRequest(body, traceId, identity);

    // Persist a (redacted) telemetry record. Fail-open: a telemetry failure must
    // never turn a successful request into a 5xx or break an in-flight stream.
    const persist = async (decision: DecisionRecord) => {
      try {
        await deps.telemetry.insert({
          decision: deps.redact(decision) as DecisionRecord,
          apiKeyId: identity.keyId,
          createdAt: new Date(),
        });
      } catch {
        c.get("logger").log("error", "telemetry.insert_failed", { trace_id: traceId });
      }
    };

    const result = await deps.route(
      internal,
      { allowCustomModel: identity.caps?.allowCustomModel === true },
      c.req.raw.signal,
    );

    // Routing-signal debug headers (read by e2e + operators): the lane the
    // pipeline selected and the model it finally landed on. These expose the
    // DecisionRecord's `lane.selected_lane` / `final.model_alias` WITHOUT leaking
    // any key/payload (principle 7) — they carry only routing aliases. Set on
    // both branches before the body is written.
    const lane = result.decision.lane.selected_lane;
    c.header("x-helm-lane", lane);
    if (result.final.status === "ok") {
      const fin = result.decision.final;
      if (fin.model_alias !== null) c.header("x-helm-final-model", fin.model_alias);
      if (fin.provider_model !== null) c.header("x-helm-provider-model", fin.provider_model);
    }

    // --- streaming branch (stream:true): forward the executor's SSE handle
    //     UNBUFFERED, chunk-by-chunk, ending with whatever the upstream emitted
    //     (the upstream's own [DONE]). (principle 8) ---
    if (internal.stream && result.stream !== null) {
      const stream = result.stream;
      return streamSSE(c, async (sse) => {
        try {
          for await (const chunk of stream) {
            await sse.write(chunk);
          }
        } catch (err) {
          // A client disconnect / abort is NOT a provider fault: do not 5xx, do
          // not surface an error frame — the executor layer already recorded it.
          if (!isAbort(err, c.req.raw.signal)) {
            const errBody = makeHelmError({
              error_class: "upstream_error",
              message: "upstream error",
              trace_id: traceId,
            });
            await sse.write(`data: ${JSON.stringify({ error: errBody })}\n\n`);
          }
        } finally {
          await persist(result.decision);
        }
      });
    }

    // --- non-streaming branch ---
    await persist(result.decision);
    if (result.final.status === "error" || result.body === null) {
      const error =
        result.error ??
        makeHelmError({
          error_class: "all_providers_failed",
          message: "all providers failed",
          trace_id: traceId,
        });
      throw structuredError(error, traceId);
    }
    return c.json(result.body as Record<string, unknown>);
  });
}
