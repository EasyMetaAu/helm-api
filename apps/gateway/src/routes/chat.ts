import type {
  ChatCompletionRequest,
  DecisionRecord,
  ProviderClient,
  TelemetryStore,
} from "@helm/core";
import { UpstreamError } from "@helm/core";
import { makeHelmError } from "@helm/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";

export interface ChatRouteDeps {
  provider: ProviderClient;
  telemetry: TelemetryStore;
  redact: (payload: unknown) => unknown;
  now: () => number;
}

// Build a Phase 0 passthrough decision record (no classify/lane/fallback yet).
function passthroughDecision(args: {
  requestId: string;
  model: string;
  status: "ok" | "error";
  latencyMs: number;
  errorClass: string | null;
}): DecisionRecord {
  return {
    request_id: args.requestId,
    requested_model: args.model,
    classifier: {
      task_type: "passthrough",
      complexity: "passthrough",
      confidence: 1,
      decided_by: "default",
      eval_cache_hit: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "passthrough" },
    lane: { selected_lane: "passthrough", candidate_chain: [args.model] },
    provider_attempts: [
      {
        alias: args.model,
        skipped: false,
        skip_reason: null,
        status: args.status,
        error_class: args.errorClass,
        latency_ms: args.latencyMs,
        cost_usd: null,
      },
    ],
    final: {
      model_alias: args.status === "ok" ? args.model : null,
      provider_model: args.status === "ok" ? args.model : null,
      status: args.status,
      error_reason: args.errorClass,
    },
  };
}

// Is this thrown value a client disconnect / abort (NOT a provider fault)?
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

// Phase 0 = passthrough ONLY (no classification/lane/fallback/protocol-xlate;
// streaming is SSE byte passthrough, no event mapping — that is Phase 2). The
// route is wiring only: auth -> provider -> telemetry. Business logic lives in
// core/store/redaction. Registered on an app that already use()s auth.
export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatRouteDeps): void {
  app.post("/v1/chat/completions", async (c) => {
    const traceId = c.get("trace_id");
    const identity = c.get("identity");
    const body = (await c.req.json()) as ChatCompletionRequest;
    const model = typeof body.model === "string" ? body.model : "unknown";

    // Persist a (redacted) telemetry record. Fail-open: a telemetry failure must
    // never turn a successful request into a 5xx (or break an in-flight stream).
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

    // --- streaming branch (stream:true): SSE byte passthrough ---
    if (body.stream === true) {
      const start = deps.now();
      const upstream = deps.provider.chatCompletionStream(body, { signal: c.req.raw.signal });
      return streamSSE(c, async (sse) => {
        try {
          for await (const chunk of upstream) {
            await sse.write(chunk); // forward each upstream chunk verbatim (incl. [DONE])
          }
          await persist(
            passthroughDecision({
              requestId: traceId,
              model,
              status: "ok",
              latencyMs: deps.now() - start,
              errorClass: null,
            }),
          );
        } catch (err) {
          const latencyMs = deps.now() - start;
          if (isAbort(err) || c.req.raw.signal.aborted) {
            // Client disconnect: NOT a provider fault. Record as client_abort —
            // never as upstream_error/timeout, never trip a circuit (Phase 1).
            await persist(
              passthroughDecision({
                requestId: traceId,
                model,
                status: "error",
                latencyMs,
                errorClass: "client_abort",
              }),
            );
            return;
          }
          const errorClass = err instanceof UpstreamError ? err.errorClass : "upstream_error";
          await persist(
            passthroughDecision({
              requestId: traceId,
              model,
              status: "error",
              latencyMs,
              errorClass,
            }),
          );
          // Already streaming: end with a structured error SSE frame, not a bare cut.
          const errBody = makeHelmError({
            error_class: errorClass,
            message: errorClass === "timeout" ? "upstream timeout" : "upstream error",
            trace_id: traceId,
          });
          await sse.write(`data: ${JSON.stringify({ error: errBody })}\n\n`);
        }
      });
    }

    // --- non-streaming branch ---
    const start = deps.now();
    try {
      const resp = await deps.provider.chatCompletion(body, { signal: c.req.raw.signal });
      await persist(
        passthroughDecision({
          requestId: traceId,
          model,
          status: "ok",
          latencyMs: deps.now() - start,
          errorClass: null,
        }),
      );
      return c.json(resp);
    } catch (err) {
      const latencyMs = deps.now() - start;
      if (err instanceof UpstreamError) {
        await persist(
          passthroughDecision({
            requestId: traceId,
            model,
            status: "error",
            latencyMs,
            errorClass: err.errorClass,
          }),
        );
        // Re-thrown as a structured error; the app's onError renders the OpenAI shape.
        throw new HelmHttpError(
          makeHelmError({
            error_class: err.errorClass,
            message: err.errorClass === "timeout" ? "upstream timeout" : "upstream error",
            trace_id: traceId,
          }),
        );
      }
      throw err; // client disconnect / unexpected — handled by onError
    }
  });
}
