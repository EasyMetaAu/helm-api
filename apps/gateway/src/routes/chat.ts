import type {
  ChatCompletionRequest,
  DecisionRecord,
  ExecutionResult,
  IRMessage,
  MemoryScope,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { observeInbound, observeOutbound } from "@helm/core";
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
import { resolveMemoryScope } from "./memory-scope.js";
import {
  backfillCompletionCost,
  captureEnabled,
  type PayloadCaptureDeps,
  persistPayload,
  usageFromSSE,
} from "./payload-capture.js";

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
  /** Full request/response capture + streamed-cost backfill wiring. Optional so
   *  test deps can omit it; when present, governs payload storage (capture_payloads)
   *  and streamed completion-cost backfill (#6). */
  capturePayloads?: PayloadCaptureDeps["capturePayloads"];
  payloadRetentionMs?: PayloadCaptureDeps["payloadRetentionMs"];
  costOf?: PayloadCaptureDeps["costOf"];
  /** Post-served account-credit debit (Issue #37, fail-OPEN). Optional — absent =
   *  no billing (existing tests run unchanged). When present, it is called inside
   *  the SAME try/catch fail-open envelope as telemetry `persist` (a debit failure
   *  is logged, NEVER 5xx's a served request). It charges the account the EXACT
   *  cost_breakdown.total_usd already computed (D6 — never recomputed); on the
   *  streaming path it runs in the finally block AFTER backfillCompletionCost has
   *  settled total_usd (#2 e2e — the highest-risk case). This is the ONLY surface
   *  that debits (D8): /v1/messages + /v1/responses gate but do not bill. */
  creditDebit?: (decision: DecisionRecord, accountId: string, apiKeyId: string) => Promise<void>;
  /** When true, honor the e2e-only `x-helm-eval` / `x-helm-rules-threshold`
   *  headers to toggle Layer-2 eval and raise the Layer-1 gate per request.
   *  Gated by HELM_E2E in the composition root; production never sets this so
   *  classification stays config-driven (fail-closed). */
  evalHeaderOverride?: boolean;
  /** Memory observe-phase wiring (docs/08 Phase 1). Optional — absent = no-op
   *  (existing tests run unchanged). When present, observeInbound persists the
   *  request before routing and observeOutbound persists the assistant turn
   *  after; both self-gate on the resolved MemoryScope mode and are fail-open
   *  (a store failure never 5xx's, principle 3). `observe` is the process-wide
   *  ObserveDeps built once in the composition root. */
  memory?: { observe: ObserveDeps };
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
  caps: { allowCustomModel: boolean; allowedLanes?: string[] | null };
}

// Map the OpenAI chat request body to the normalized InternalRequest (Protocol
// Adapter, openai_chat). MVP: messages/tools/response_format pass through as the
// loose normalized shape; deeper per-protocol narrowing is the docs/05 tasks.
function toInternalRequest(
  body: ChatCompletionRequest,
  traceId: string,
  identity: ChatIdentity,
  sessionKey: string | null,
  memoryScope: MemoryScope,
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
      // Memory scope (docs/08): resolved from the x-thread-id/x-resource-id/
      // x-project-id/x-memory-mode headers at the route boundary (core never
      // parses HTTP, principle 1). Absent headers → off + null ids.
      thread_id: memoryScope.threadId,
      resource_id: memoryScope.resourceId,
      project_id: memoryScope.projectId,
      memory_mode: memoryScope.mode,
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

// Extract the assistant message (+ any tool messages) from a non-stream OpenAI
// chat.completion body for observeOutbound. Tolerant of a degraded body: a
// missing/odd shape yields no messages (observe then persists nothing) rather
// than throwing into the response path.
function outboundFromOpenAIBody(body: unknown): {
  responseMessages: IRMessage[];
  toolResults: IRMessage[];
} {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return { responseMessages: [], toolResults: [] };
  const responseMessages: IRMessage[] = [];
  const toolResults: IRMessage[] = [];
  for (const ch of choices) {
    const m = (ch as { message?: unknown })?.message as
      | { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }
      | undefined;
    if (m === undefined || m === null) continue;
    const content = typeof m.content === "string" ? m.content : null;
    if (m.role === "tool") {
      toolResults.push({
        role: "tool",
        content,
        ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
      } as IRMessage);
    } else {
      responseMessages.push({
        role: "assistant",
        content,
        ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls as never } : {}),
      } as IRMessage);
    }
  }
  return { responseMessages, toolResults };
}

// Buffer for reconstructing the assistant turn from a forwarded OpenAI SSE stream.
// `text` is the accumulated assistant content; `pending` holds bytes of an event
// not yet terminated by the `\n\n` SSE delimiter.
interface SSEAccumulator {
  text: string;
  pending: string;
}

// Parse ONE complete SSE event and append any assistant delta content. A
// malformed/`[DONE]` frame is swallowed (fail-open).
function parseOpenAIEvent(buffer: SSEAccumulator, event: string): void {
  for (const line of event.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { choices?: unknown };
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const ch of choices) {
        const delta = (ch as { delta?: unknown })?.delta as { content?: unknown } | undefined;
        if (typeof delta?.content === "string") buffer.text += delta.content;
      }
    } catch {
      // malformed frame: skip (fail-open) — never alters the forwarded stream.
    }
  }
}

// Accumulate assistant delta text across OpenAI SSE frames for observeOutbound.
// The provider client yields ARBITRARY transport chunks (openai.ts reader.read()),
// NOT whole SSE events, so a single `data: {...}` frame can be split across two
// chunks. We append to `pending` and parse only COMPLETE events (delimited by
// `\n\n`), holding the trailing partial for the next chunk — otherwise a split
// JSON frame would JSON.parse-fail and silently drop assistant content. Never
// disturbs the bytes forwarded to the client (principle 8 — the caller writes the
// chunk FIRST, then feeds a copy here).
function accumulateOpenAIChunk(buffer: SSEAccumulator, chunk: string): void {
  buffer.pending += chunk;
  const events = buffer.pending.split("\n\n");
  // The last segment may be an incomplete event — keep it for the next chunk.
  buffer.pending = events.pop() ?? "";
  for (const event of events) parseOpenAIEvent(buffer, event);
}

// Flush the final buffered event at stream end (the last frame may arrive without
// a trailing `\n\n`). Clears pending so it is idempotent.
function flushOpenAIChunk(buffer: SSEAccumulator): void {
  if (buffer.pending !== "") {
    parseOpenAIEvent(buffer, buffer.pending);
    buffer.pending = "";
  }
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

    // Memory scope (docs/08 Phase 1): parse the four memory headers at this HTTP
    // boundary into a resolved MemoryScope (core never reads headers, principle
    // 1). The scope ids/mode ride the InternalRequest metadata AND gate the
    // observe calls below; absent/illegal headers → off + null (default-safe).
    const memoryScope = resolveMemoryScope((name) => c.req.header(name));

    const internal = toInternalRequest(body, traceId, identity, sessionKey, memoryScope);

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

    // Post-served credit debit (Issue #37). Fail-OPEN — mirrors `persist`: a debit
    // failure is logged, never turns a served request into a 5xx or breaks an
    // in-flight stream. Self-gates: no-op when no debit dep is wired or the request
    // has no resolved account/key. Charges the SETTLED total_usd carried on the
    // decision (D6 — never recomputed here).
    const debitLedger = async (decision: DecisionRecord) => {
      if (deps.creditDebit === undefined) return;
      if (identity.accountId === undefined || identity.keyId === undefined) return;
      try {
        await deps.creditDebit(decision, identity.accountId, identity.keyId);
      } catch {
        c.get("logger").log("error", "credit.debit_failed", { trace_id: traceId });
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

    // Memory observe (inbound): persist the request's raw messages BEFORE routing
    // (docs/08 Phase 1). observe is write-only — it NEVER mutates `internal.messages`
    // nor changes routing, and self-gates to a no-op on mode=off / threadId=null.
    // It never throws (fail-open inside core), so no try/catch is needed here.
    if (deps.memory !== undefined) {
      await observeInbound(deps.memory.observe, memoryScope, internal.messages as IRMessage[]);
    }

    const result = await deps.route(
      internal,
      {
        allowCustomModel: identity.caps?.allowCustomModel === true,
        // Thread the resolved key's DISPLAY PREFIX into the decision record for the
        // Debug UI key column. Prefix only — never the plaintext key (principle 7).
        keyPrefix: identity.keyPrefix ?? null,
        // Per-key lane whitelist (docs/04): the OUTER, non-negotiable bound the
        // core applies LAST (after policy caps), so a key confined to e.g.
        // ['economy'] is honored even over a policy use_lane pin. null =
        // unconstrained.
        keyCaps: {
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
      // Accumulate the assistant text for observeOutbound WITHOUT touching the
      // forwarded bytes (principle 8): write the chunk first, then parse a copy.
      const assistant: SSEAccumulator = { text: "", pending: "" };
      // Accumulate raw SSE chunks so the finally block can parse the trailing
      // usage chunk and backfill the streamed completion cost (#6 — execute()
      // couldn't know it at peek time). This runs REGARDLESS of capture_payloads:
      // cost telemetry must not depend on full-body capture (an operator may turn
      // capture off for privacy yet still want costs). `captureOn` gates only
      // whether the buffered body is PERSISTED, not whether it is collected.
      const captureOn = captureEnabled(deps);
      const captured: string[] = [];
      return streamSSE(c, async (sse) => {
        try {
          for await (const chunk of stream) {
            captured.push(chunk);
            await sse.write(chunk);
            if (deps.memory !== undefined) accumulateOpenAIChunk(assistant, chunk);
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
          // Streamed completion-cost backfill (#6): parse the trailing usage and
          // price it at the served alias. Fail-open — leave cost null on any miss.
          const rawSse = captured.join("");
          const finalAlias =
            result.decision.final.status === "ok" ? result.decision.final.model_alias : null;
          try {
            const usage = usageFromSSE(rawSse);
            if (usage && finalAlias && deps.costOf) {
              backfillCompletionCost(result.decision, finalAlias, deps.costOf(finalAlias, usage));
            }
          } catch {
            c.get("logger").log("warn", "cost.stream_backfill_failed", { trace_id: traceId });
          }
          await persistPayload(
            deps,
            {
              requestId: traceId,
              requestJson: JSON.stringify(raw),
              responseJson: captureOn ? rawSse : null,
              now: deps.now(),
            },
            (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
          );
          await persist(result.decision);
          // Credit debit (Issue #37, streamed): runs HERE — after the usage
          // backfill above settled cost_breakdown.total_usd — so the streamed
          // request is billed its real cost, not the null peek-time value (#2
          // e2e, the highest-risk case). Fail-open (own try/catch inside).
          await debitLedger(result.decision);
          // Memory observe (outbound, streamed): persist the reconstructed
          // assistant turn AFTER the bytes were forwarded. Fail-open inside core.
          if (deps.memory !== undefined) {
            // Flush the last partial event the \n\n-split loop held back, so a
            // final frame without a trailing \n\n is not dropped.
            flushOpenAIChunk(assistant);
            if (assistant.text.length > 0) {
              await observeOutbound(deps.memory.observe, memoryScope, {
                responseMessages: [{ role: "assistant", content: assistant.text }],
                toolResults: [],
              });
            }
          }
        }
      });
    }

    // --- non-streaming branch ---
    await persistPayload(
      deps,
      {
        requestId: traceId,
        requestJson: JSON.stringify(raw),
        responseJson: result.body !== null ? JSON.stringify(result.body) : null,
        now: deps.now(),
      },
      (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
    );
    await persist(result.decision);
    // Credit debit (Issue #37, non-stream): the non-stream path's total_usd is
    // already settled on the decision by route-request, so we bill right after
    // persist. Fail-open. A failed/errored request carries total_usd null → debits
    // 0 (D4), so this is safe to call before the error branch below.
    await debitLedger(result.decision);
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
    // Memory observe (outbound, non-stream): persist the assistant message (+ any
    // tool messages) from the OpenAI body. observe self-gates on mode/thread and
    // never throws (fail-open) — it cannot turn a successful 200 into a 5xx.
    if (deps.memory !== undefined) {
      await observeOutbound(deps.memory.observe, memoryScope, outboundFromOpenAIBody(result.body));
    }
    return c.json(result.body as Record<string, unknown>);
  });
}
