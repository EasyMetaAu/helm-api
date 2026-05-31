import type {
  ChatCompletionRequest,
  DecisionRecord,
  ExecutionResult,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import {
  type HelmError,
  type InternalRequest,
  makeHelmError,
  OpenAIChatRequestSchema,
} from "@helm/shared";
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
    classifyOverrides?: { evalEnabled?: boolean; rulesThreshold?: number },
  ) => Promise<ExecutionResult>;
  telemetry: TelemetryStore;
  redact: (payload: unknown) => unknown;
  now: () => number;
  /** When true, honor the e2e-only `x-helm-eval` / `x-helm-rules-threshold`
   *  headers to toggle Layer-2 eval and raise the Layer-1 gate per request.
   *  Gated by HELM_E2E in the composition root; production never sets this so
   *  classification stays config-driven (fail-closed). */
  evalHeaderOverride?: boolean;
}

// Minimal identity shape the adapter reads (subset of middleware/auth's
// AuthIdentity — kept local so chat.ts doesn't depend on the middleware type).
interface ChatIdentity {
  keyId: string;
  /** Display prefix only (helm_live_ab12) — never the plaintext key (principle 7). */
  keyPrefix: string;
  accountId: string;
  orgId: string | null;
  userId: string | null;
  caps: { allowCustomModel: boolean; maxLane?: string | null; allowedLanes?: string[] | null };
}

// Map the OpenAI chat request body to the normalized InternalRequest (Protocol
// Adapter, openai_chat). MVP: messages/tools/response_format pass through as the
// loose normalized shape; deeper per-protocol narrowing is the docs/05 tasks.
function toInternalRequest(
  body: ChatCompletionRequest,
  traceId: string,
  identity: ChatIdentity,
  sessionKey: string | null,
): InternalRequest {
  const messages = Array.isArray(body.messages)
    ? (body.messages as InternalRequest["messages"])
    : [{ role: "user", content: "" }];
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "auto";

  // Session momentum keys off metadata.conversation_id (classifier engine). An
  // explicit conversation_id in the body wins; otherwise the `x-session-key`
  // request header maps in so momentum actually fires in production. Without this
  // the store is keyed null and momentum never engages (fail-open to no momentum).
  const bodyMeta =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : null;
  const bodyConversationId =
    typeof bodyMeta?.conversation_id === "string" && bodyMeta.conversation_id.length > 0
      ? bodyMeta.conversation_id
      : null;
  const conversationId = bodyConversationId ?? sessionKey;

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
      conversation_id: conversationId,
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

// A 400 invalid_request for a client-side request error (bad JSON / bad shape).
// Thrown before routing; the error-handler maps invalid_request → 400.
function invalidRequest(message: string, traceId: string): HelmHttpError {
  return new HelmHttpError(
    makeHelmError({ error_class: "invalid_request", message, trace_id: traceId }),
  );
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

    // Boundary validation (docs/07, principle 2 fail-closed): a malformed JSON
    // body or an invalid request (e.g. empty `messages`) is a CLIENT error → 400
    // invalid_request, raised BEFORE classify/route so it never 5xx's as an
    // upstream fault nor burns a provider fallback chain. Parse errors and schema
    // violations both map to the same structured invalid_request.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw invalidRequest("malformed JSON request body", traceId);
    }
    const parsed = OpenAIChatRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw invalidRequest(`${where}${issue?.message ?? "invalid request"}`, traceId);
    }
    const body = parsed.data as ChatCompletionRequest;

    // `x-session-key` is the conversation-dimension key clients send to opt into
    // session momentum; it maps into metadata.conversation_id (never logged — it
    // is an opaque session id, not a credential/payload).
    const headerSessionKey = c.req.header("x-session-key");
    const sessionKey =
      headerSessionKey !== undefined && headerSessionKey.length > 0 ? headerSessionKey : null;

    const internal = toInternalRequest(body, traceId, identity, sessionKey);

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

    // e2e-only classification overrides: honor `x-helm-eval` (Layer-2 toggle) and
    // `x-helm-rules-threshold` (raise the Layer-1 gate so the cascade reaches
    // eval) ONLY when the composition root opted in (HELM_E2E). Production leaves
    // `evalHeaderOverride` false so classification stays config-driven
    // (fail-closed, principle 2). Absent → defaults (eval OFF, config threshold).
    let classifyOverrides: { evalEnabled?: boolean; rulesThreshold?: number } | undefined;
    if (deps.evalHeaderOverride) {
      const evalHeader = c.req.header("x-helm-eval");
      const evalEnabled =
        evalHeader === "on" || evalHeader === "1" || evalHeader === "true"
          ? true
          : evalHeader === undefined
            ? undefined
            : false;
      const thresholdHeader = c.req.header("x-helm-rules-threshold");
      const parsed = thresholdHeader === undefined ? Number.NaN : Number(thresholdHeader);
      const rulesThreshold = Number.isFinite(parsed) ? parsed : undefined;
      classifyOverrides = { evalEnabled, rulesThreshold };
    }

    const result = await deps.route(
      internal,
      {
        allowCustomModel: identity.caps?.allowCustomModel === true,
        // Thread the resolved key's DISPLAY PREFIX into the decision record for the
        // Debug UI key column. Prefix only — never the plaintext key (principle 7).
        keyPrefix: identity.keyPrefix ?? null,
        // Per-key lane caps (docs/04): the OUTER, non-negotiable bound the core
        // applies LAST (after policy caps), so a key confined to e.g. maxLane
        // 'economy' is honored even over a policy use_lane pin. Each axis null =
        // unconstrained on that axis.
        keyCaps: {
          maxLane: identity.caps?.maxLane ?? null,
          allowedLanes: identity.caps?.allowedLanes ?? null,
        },
      },
      c.req.raw.signal,
      classifyOverrides,
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

    // Classification-decision headers (e2e.eval): expose the cascade's decision
    // SOURCE so the two fallback kinds stay observable (principle 5). decided_by
    // (rules|eval|default|fallback), the eval cache-hit flag (only meaningful when
    // eval ran), and the precise fallback reason (eval_disabled / eval_<reason>).
    // These carry only routing/decision metadata — never key/payload (principle 7).
    const cls = result.decision.classifier;
    c.header("x-helm-decided-by", cls.decided_by);
    if (cls.eval_cache_hit !== null) {
      c.header("x-helm-eval-cache-hit", String(cls.eval_cache_hit));
    }
    if (cls.fallback_reason !== null && cls.fallback_reason !== undefined) {
      c.header("x-helm-fallback-reason", cls.fallback_reason);
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
