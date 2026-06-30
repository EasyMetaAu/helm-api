import type {
  BudgetCaps,
  BudgetCheckResult,
  BudgetProbe,
  ChatCompletionRequest,
  DecisionRecord,
  ExecutionResult,
  InjectDeps,
  InsertTelemetryInput,
  IRMessage,
  MemoryScope,
  ObserveDeps,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import {
  assembleInjectedContext,
  enqueueObserverWriteback,
  injectIntoIR,
  observeInbound,
  observeOutbound,
  openaiTransformer,
  ownerScopedThreadId,
} from "@helm/core";
import {
  type HelmError,
  type InternalRequest,
  type MemoryDecision,
  makeHelmError,
  OpenAIChatRequestSchema,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { INTERNAL_API_KEY_ID } from "../internal-key.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import type { ServingAccount } from "../runtime/serving-account.js";
import type { WriteQueue } from "../runtime/write-queue.js";
import { downgradeClientFastModeIfDisallowed } from "./fast-mode.js";
import { atEventBoundary, HEARTBEAT_COMMENT, withHeartbeat } from "./heartbeat.js";
import { copyLiteLLMRequestParams, providerRawFromRequest } from "./internal-request-params.js";
import { type MemoryKeyDefaults, resolveMemoryScope } from "./memory-scope.js";
import {
  backfillCompletionCost,
  captureEnabled,
  createSseCapture,
  createStreamGenerationTimer,
  type PayloadCaptureDeps,
  persistPayload,
  tokensFromUsage,
  usageFromBody,
  usageFromSSE,
} from "./payload-capture.js";
import { isUpstreamTimeout } from "./stream-error.js";

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
  ) => Promise<ExecutionResult & { servingAccount?: ServingAccount | null }>;
  telemetry: TelemetryStore;
  /** Deferred + batched write queue (perf). Optional: ABSENT = today's behavior —
   *  telemetry/payload/observe writes are awaited inline (the entire existing test
   *  suite runs unchanged). PRESENT = those fail-open writes are enqueued to run
   *  AFTER the response (batched), so a synchronous SQLite commit never sits on the
   *  request's critical path. The budget `settle` is NEVER deferred (quota
   *  correctness). Wired in the composition root. */
  writes?: WriteQueue;
  redact: (payload: unknown) => unknown;
  now: () => number;
  /** SSE keep-alive cadence (ms) for streaming responses; read fresh per request
   *  from runtime.sse_heartbeat_ms. Optional — absent/0 = no heartbeat (existing
   *  tests run unchanged). Covers only the inter-chunk idle gap. */
  sseHeartbeatMs?: () => number;
  /** Per-account OAuth subscription usage recorder (providers page Tier 2).
   *  Optional — absent in unit tests. Called once per served request from the
   *  settle path with the subscription that served it (null for a configured /
   *  non-OAuth provider) + the served tokens/cost. Fail-open in the composition
   *  root (a record failure never 5xx's a served request). */
  recordOAuthUsage?: (
    servingAccount: ServingAccount | null,
    servedAlias: string | null,
    usage: { tokens: number; costUsd: number | null },
  ) => void;
  /** Full request/response capture + streamed-cost backfill wiring. Optional so
   *  test deps can omit it; when present, governs payload storage (capture_payloads)
   *  and streamed completion-cost backfill (#6). */
  capturePayloads?: PayloadCaptureDeps["capturePayloads"];
  costOf?: PayloadCaptureDeps["costOf"];
  /** When true, honor the e2e-only `x-helm-eval` / `x-helm-rules-threshold`
   *  headers to toggle Layer-2 eval and raise the Layer-1 gate per request.
   *  Gated by HELM_E2E in the composition root; production never sets this so
   *  classification stays config-driven (fail-closed). */
  evalHeaderOverride?: boolean;
  /** OpenAI Chat compatibility policy for the response body's `model` field.
   *  Default preserves the provider's real model identity; requested_alias is a
   *  compatibility shim for clients that expect their requested model echoed. */
  responseModelPolicy?: "provider" | "requested_alias" | "both";
  /** Memory observe-phase wiring (docs/08 Phase 1). Optional — absent = no-op
   *  (existing tests run unchanged). When present, observeInbound persists the
   *  request before routing and observeOutbound persists the assistant turn
   *  after; both self-gate on the resolved MemoryScope mode and are fail-open
   *  (a store failure never 5xx's, principle 3). `observe` is the process-wide
   *  ObserveDeps built once in the composition root. */
  memory?: { observe: ObserveDeps; inject?: InjectWiring };
  /** Per-key usage-budget wiring (docs/06). Optional — absent = no budgets (existing
   *  tests unchanged). `budgetGate.check` runs BEFORE route (fail-CLOSED: a store
   *  error propagates → 5xx); over budget either rejects (429) or yields a degrade
   *  lane fed into keyCaps.degradeLane. `settleBudget` runs post-served inside the SAME
   *  fail-open envelope as telemetry persist (a settle failure is logged, never
   *  5xx's a served request). */
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
}

function applyResponseModelPolicy(
  body: Record<string, unknown>,
  requestedModel: string,
  policy: "provider" | "requested_alias" | "both",
): Record<string, unknown> {
  if (policy !== "requested_alias") return body;
  return { ...body, model: requestedModel };
}

function restampOpenAIStreamEventModel(event: string, requestedModel: string): string {
  return event
    .split("\n")
    .map((line) => {
      const match = /^data:(\s?)(.*)$/.exec(line);
      if (match === null) return line;
      const [, spacing = "", data = ""] = match;
      const payload = data.trim();
      if (payload === "" || payload === "[DONE]") return line;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return line;
        if (typeof (parsed as { model?: unknown }).model !== "string") return line;
        return `data:${spacing}${JSON.stringify({ ...(parsed as Record<string, unknown>), model: requestedModel })}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function createOpenAIStreamModelRestamper(requestedModel: string): {
  push(chunk: string): string;
  flush(): string;
} {
  let pending = "";
  const nextSeparator = (value: string): { index: number; separator: string } | null => {
    const lf = value.indexOf("\n\n");
    const crlf = value.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, separator: "\r\n\r\n" };
    return { index: lf, separator: "\n\n" };
  };
  return {
    push(chunk: string): string {
      let buffer = pending + chunk;
      let out = "";
      while (true) {
        const sep = nextSeparator(buffer);
        if (sep === null) break;
        const event = buffer.slice(0, sep.index);
        out += restampOpenAIStreamEventModel(event, requestedModel) + sep.separator;
        buffer = buffer.slice(sep.index + sep.separator.length);
      }
      pending = buffer;
      return out;
    },
    flush(): string {
      if (pending === "") return "";
      const out = restampOpenAIStreamEventModel(pending, requestedModel);
      pending = "";
      return out;
    },
  };
}

// Gateway-side inject wiring (docs/08 Phase 2). Bundles the core InjectDeps with
// the per-deployment token budget (D9 — there is no config.memory subtree yet, so
// the budget rides here, sourced from HELM_MEMORY_INJECT_TOKEN_BUDGET in the
// composition root). Optional so existing tests that pass only `{ observe }` are
// unaffected (inject absent → inject is a pure no-op).
export interface InjectWiring {
  deps: InjectDeps;
  tokenBudget: number;
  // Salient-fact fast path (salient-fact-memory-spec Change B). When true, inject
  // surfaces a `## Known facts` section; absent ⇒ off (byte-identical to today).
  // Sourced from config.memory.forgetting.consolidate.eager_facts in the root.
  injectKnownFacts?: boolean;
  maxFactsInjected?: number;
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
  caps: {
    allowCustomModel: boolean;
    allowFastMode?: boolean;
    allowedLanes?: string[] | null;
    budget?: BudgetCaps;
    /** Per-key memory defaults (issue #97); absent = memory off unless headers say otherwise. */
    memory?: MemoryKeyDefaults;
  };
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
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "auto";
  // messages is already schema-validated as a non-empty array at the route boundary
  // (OpenAIChatRequestSchema.safeParse → 400 fail-closed). P1-CHAT-01: reuse the
  // OpenAI transformer's content normalization so the route and transformer share ONE
  // source of truth (bare-string image_url → {url}, default filenames, …).
  let messages: InternalRequest["messages"];
  try {
    const normalized = openaiTransformer.transformRequestOut({ ...(body as object), model });
    if (normalized && typeof (normalized as Promise<unknown>).then === "function") {
      throw new Error("OpenAI request normalizer unexpectedly returned a Promise");
    }
    messages = (normalized as { messages: InternalRequest["messages"] }).messages;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid OpenAI chat request";
    throw invalidRequest(detail, traceId);
  }

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
  const bodyRec = body as Record<string, unknown>;
  const providerRaw = providerRawFromRequest(bodyRec);

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
    ...copyLiteLLMRequestParams(bodyRec),
    ...(providerRaw !== undefined ? { provider_raw: providerRaw } : {}),
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
  const handleChat = async (c: Context<AppEnv>, pathModel?: string) => {
    const traceId = c.get("trace_id");
    const identity = c.get("identity") as unknown as ChatIdentity;

    // Boundary validation (docs/07, principle 2 fail-closed): a malformed JSON
    // body or an invalid request (e.g. empty `messages`) is a CLIENT error → 400
    // invalid_request, raised BEFORE classify/route so it never 5xx's as an
    // upstream fault nor burns a provider fallback chain. Parse errors and schema
    // violations both map to the same structured invalid_request.
    let requestJson = "";
    let raw: unknown;
    try {
      requestJson = await c.req.text();
      raw = JSON.parse(requestJson);
    } catch {
      throw invalidRequest("malformed JSON request body", traceId);
    }
    if (pathModel !== undefined && raw !== null && typeof raw === "object") {
      raw = { ...(raw as Record<string, unknown>), model: decodeURIComponent(pathModel) };
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

    // Memory scope (docs/08 + issue #97): parse the four memory headers at this
    // HTTP boundary into a resolved MemoryScope (core never reads headers,
    // principle 1), filled in from the KEY's stored defaults and — when the key
    // opted into thread_source=auto — from body signals the client already sends
    // (metadata.thread_id / prompt_cache_key). Explicit headers always override;
    // an unconfigured key resolves exactly as before (default-safe).
    const bodyRec = body as Record<string, unknown>;
    const bodyMetaBag =
      bodyRec.metadata && typeof bodyRec.metadata === "object"
        ? (bodyRec.metadata as Record<string, unknown>)
        : null;
    const sig = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const memoryScope = resolveMemoryScope((name) => c.req.header(name), identity.accountId, {
      defaults: identity.caps?.memory,
      signals: {
        metadataThreadId: sig(bodyMetaBag?.thread_id) ?? sig(bodyMetaBag?.conversation_id),
        promptCacheKey: sig(bodyRec.prompt_cache_key),
      },
    });

    let internal = toInternalRequest(body, traceId, identity, sessionKey, memoryScope);
    internal = downgradeClientFastModeIfDisallowed(internal, identity.caps.allowFastMode);
    // Per-candidate attempt timeout: a slow head model times out and the executor falls
    // back to the next candidate (instead of waiting out the global 90s connect timeout).
    // Honored ONLY from the trusted INTERNAL key — the classifier eval / memory self-HTTP
    // loopback set it; an untrusted client could otherwise pick a tiny value to force-fail
    // attempts and trip the SHARED breaker for other tenants. Absent ⇒ today's behavior.
    if (identity.keyId === INTERNAL_API_KEY_ID) {
      const raw = c.req.header("x-helm-attempt-timeout-ms");
      const ms = raw === undefined ? Number.NaN : Number(raw);
      if (Number.isFinite(ms) && ms > 0) internal.attempt_timeout_ms = Math.floor(ms);
    }
    const originalMessagesForMemory = [...(internal.messages as IRMessage[])];

    // Persist a (redacted) telemetry record. Fail-open: a telemetry failure must
    // never turn a successful request into a 5xx or break an in-flight stream. The
    // redaction is done HERE (synchronously) so the enqueued snapshot can never be
    // affected by anything that touches the decision after the response returns.
    // With a write queue wired, the insert is deferred + batched off the hot path.
    const persist = async (decision: DecisionRecord) => {
      const input: InsertTelemetryInput = {
        decision: deps.redact(decision) as DecisionRecord,
        apiKeyId: identity.keyId,
        createdAt: new Date(),
      };
      if (deps.writes !== undefined) {
        deps.writes.enqueueTelemetry(input);
        return;
      }
      try {
        await deps.telemetry.insert(input);
      } catch {
        c.get("logger").log("error", "telemetry.insert_failed", { trace_id: traceId });
      }
    };

    // Capture the verbatim request/response bodies. Mirrors `persist`: deferred +
    // batched when a write queue is wired, else the inline await (today's behavior).
    // Self-gates on capture_payloads exactly like persistPayload. Retention is NOT
    // pruned here — the scheduled cleanup runner owns payload retention (archive-
    // first), so capture never deletes bodies behind the cleanup settings' back.
    const capturePayload = async (
      responseJson: string | null,
      upstreamRequestJson: string | null,
    ) => {
      if (deps.writes !== undefined) {
        if (!captureEnabled(deps)) return;
        deps.writes.enqueuePayload({
          requestId: traceId,
          requestJson,
          responseJson,
          upstreamRequestJson,
          createdAt: new Date(deps.now()),
        });
        return;
      }
      await persistPayload(
        deps,
        { requestId: traceId, requestJson, responseJson, upstreamRequestJson, now: deps.now() },
        (msg) => c.get("logger").log("warn", msg, { trace_id: traceId }),
      );
    };

    // Run the memory observe write-back: deferred (FIFO) when a write queue is
    // wired, else inline await (today). observeInbound/observeOutbound are fail-open
    // inside core. FIFO ordering guarantees inbound (enqueued before route) settles
    // before outbound (enqueued in the finally) for the same thread.
    // `wake` (default true) asks the write queue to nudge the memory worker after this
    // observe settles. The INBOUND observe passes false: the observer job must not be
    // drained until the OUTBOUND turn is persisted (else the assistant turn is dropped
    // from this run). Outbound observes use the default → the worker wakes once the
    // whole turn has landed.
    const runObserve = async (task: () => Promise<unknown>, wake = true) => {
      if (deps.writes !== undefined) {
        deps.writes.enqueueTask(
          async () => {
            await task();
          },
          { wakeOnSettle: wake },
        );
        return;
      }
      await task();
    };

    // Post-served usage-budget settle (docs/06). Fail-OPEN — mirrors `persist`: a
    // settle failure is logged, never 5xx's a served request nor breaks a stream.
    // Self-gates: no-op when no budget dep is wired. Charges the SETTLED total_usd
    // (never recomputed) + actual served tokens + 1 request.
    // Captured from the route result (the subscription the pool selected, or null
    // for a configured/non-OAuth provider) so the settle path can attribute usage.
    let servingAccount: ServingAccount | null = null;
    const settle = async (decision: DecisionRecord, tokens: number) => {
      // Per-account OAuth usage (providers page Tier 2) — recorded for EVERY served
      // request, independent of whether usage budgets are wired. The served alias is
      // passed so the recorder can drop a STALE account after a fallback (the pool
      // marks at selection time). completion_usd is null for flat-rate subscriptions.
      deps.recordOAuthUsage?.(servingAccount, decision.final.model_alias, {
        tokens,
        costUsd: decision.cost_breakdown.completion_usd,
      });
      if (deps.settleBudget === undefined || identity.caps?.budget === undefined) return;
      try {
        await deps.settleBudget(
          identity.keyId,
          identity.caps.budget,
          { requests: 1, tokens, costUsd: decision.cost_breakdown.total_usd },
          deps.now(),
        );
      } catch {
        c.get("logger").log("error", "budget.settle_failed", { trace_id: traceId });
      }
    };

    // Pre-route usage-budget gate (docs/06). FAIL-CLOSED: a store-read error
    // propagates (→ 5xx), never a silent pass. Over budget → reject (429) or
    // degrade: cap THIS request's lane to the key's degrade lane via keyCaps.degradeLane.
    let degradeLane: string | null = null;
    if (deps.budgetGate !== undefined && identity.caps?.budget !== undefined) {
      const check = await deps.budgetGate.check({
        keyId: identity.keyId,
        caps: identity.caps.budget,
        nowMs: deps.now(),
      });
      if (check.overBudget) {
        if (check.behavior === "reject") {
          throw structuredError(
            makeHelmError({
              error_class: "rate_limited",
              message: "usage budget exceeded",
              trace_id: traceId,
            }),
            traceId,
          );
        }
        degradeLane = check.degradeLane;
      }
    }

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

    // Memory inject runs before inbound observe, so the current turn cannot be
    // loaded back as recent_raw and duplicated in the same upstream request.

    // Memory inject (docs/08 Phase 2, #217 Phase 4 TRAILING-REMINDER model): when
    // x-memory-mode=inject, load + assemble a budgeted, cache-friendly memory TEXT
    // BLOCK and APPEND it as ONE trailing `<system-reminder>` turn AFTER the verbatim
    // conversation BEFORE routing — so classification/execution see the hydrated context
    // while the client's cached system prefix (tools → system → history) stays
    // byte-identical. The bridge is purely ADDITIVE: every existing turn (incl.
    // tool_calls / structured / multipart content) rides through VERBATIM, so there is no
    // longer a D7 plain-text gate (no replacement ⇒ no structure loss). The OpenAI chat
    // surface is the lingua franca (no native passthrough), so the reminder is appended to
    // the IR messages directly. Fully fail-open: a bridge failure leaves the original
    // messages untouched (never 5xx, never alters routing — principle 3). Runs AFTER
    // observe (observe writes the raw turn; inject only reads + assembles).
    // Inject metadata for the DecisionRecord (docs/08 Step 10) — held here and
    // stamped AFTER route() returns (the routing core never learns about memory).
    let memoryMeta: Omit<MemoryDecision, "thread_source"> | null = null;
    if (deps.memory?.inject !== undefined && memoryScope.mode === "inject") {
      const wiring = deps.memory.inject;
      // OpenAI chat: the system prompt is the LEADING system IR message, else "".
      const leadingSystem = (internal.messages as IRMessage[])[0];
      const systemPrompt =
        leadingSystem?.role === "system" && typeof leadingSystem.content === "string"
          ? leadingSystem.content
          : "";
      const injected = await injectIntoIR(
        internal.messages as IRMessage[],
        systemPrompt,
        {
          accountId: memoryScope.accountId,
          ...(memoryScope.projectId !== null ? { projectId: memoryScope.projectId } : {}),
          ...(memoryScope.resourceId !== null ? { resourceId: memoryScope.resourceId } : {}),
          ...(memoryScope.threadId !== null
            ? { threadId: ownerScopedThreadId(memoryScope.accountId, memoryScope.threadId) }
            : {}),
        },
        {
          assemble: (input) =>
            assembleInjectedContext(
              {
                ...input,
                ...(wiring.injectKnownFacts === true ? { injectKnownFacts: true } : {}),
                ...(wiring.maxFactsInjected !== undefined
                  ? { maxFactsInjected: wiring.maxFactsInjected }
                  : {}),
              },
              wiring.deps,
            ),
          enqueueObserver: (scope) => enqueueObserverWriteback(scope, wiring.deps),
          tokenBudget: wiring.tokenBudget,
          now: wiring.deps.now,
          log: wiring.deps.log,
        },
      );
      internal.messages = injected.messages as InternalRequest["messages"];
      memoryMeta = injected.metadata;
    }

    // Memory observe (inbound): persist the original request raw messages AFTER
    // inject hydration. observe is write-only and fail-open; delaying it avoids
    // same-turn self-pollution while still capturing the turn for future calls.
    if (deps.memory !== undefined) {
      const memoryObserve = deps.memory.observe;
      await runObserve(
        () => observeInbound(memoryObserve, memoryScope, originalMessagesForMemory),
        false, // inbound: do NOT wake — wait for the outbound observe to land the turn
      );
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
          // Forced degrade lane: set only when the key is over budget AND its
          // behavior is "degrade" (docs/06). null = no degrade for this request.
          degradeLane,
        },
      },
      c.req.raw.signal,
      classifyOverrides,
    );
    // The subscription the pool selected (null for a configured/non-OAuth provider),
    // threaded out on the result so the settle path can attribute usage (Tier 2).
    servingAccount = result.servingAccount ?? null;

    // Stamp the inject metadata onto the DecisionRecord (docs/08 Step 10) so it
    // reaches telemetry / the debug UI. Counts + job id only — never memory
    // content (principle 7). Stamped HERE because the routing core is
    // memory-agnostic (memory is a middleware, not a routing input).
    if (memoryMeta !== null) {
      result.decision.memory = { ...memoryMeta, thread_source: memoryScope.threadSource };
    }

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
      if (deps.responseModelPolicy === "both") {
        c.header("x-helm-requested-model", internal.requested_model);
      }
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
      // whether the buffered body is PERSISTED, not whether it is collected — so
      // when capture is OFF we retain only a bounded TAIL (enough for usageFromSSE),
      // not the whole response, capping per-stream memory under high concurrency.
      const captureOn = captureEnabled(deps);
      const captured = createSseCapture(captureOn);
      const streamModelRestamper =
        (deps.responseModelPolicy ?? "provider") === "requested_alias"
          ? createOpenAIStreamModelRestamper(internal.requested_model)
          : null;
      // Concurrency slot handoff (issue #93, feature A): streamSSE returns its
      // Response BEFORE the stream body finishes, so claim the lease from the
      // middleware and release it in the stream's OWN finally — the slot stays
      // held until the bytes are fully drained (or the client disconnects).
      const releaseConcurrency = c.get("concurrencyClaim")?.();
      // SSE keep-alive: emit a `:` comment during inter-chunk idle so a proxy/client
      // idle-timeout does not sever a long but healthy stream. The comment is wire-only
      // (never captured, accumulated, or priced) and is gated on an event boundary so it
      // can never split a partial SSE frame (principle 8). 0 = disabled (today's behavior).
      const heartbeatMs = deps.sseHeartbeatMs?.() ?? 0;
      let lastWrite: string | null = null;
      // True-TPS denominator: time the served generation window (first→last
      // forwarded chunk). Heartbeat keepalives are NOT marked (not generated bytes).
      const genTimer = createStreamGenerationTimer(deps.now);
      return streamSSE(c, async (sse) => {
        try {
          for await (const item of withHeartbeat(stream, {
            heartbeatMs,
            signal: c.req.raw.signal,
          })) {
            if (item.type === "beat") {
              if (atEventBoundary(lastWrite)) await sse.write(HEARTBEAT_COMMENT);
              continue;
            }
            const outboundChunk = streamModelRestamper?.push(item.value) ?? item.value;
            if (outboundChunk === "") continue;
            captured.push(outboundChunk);
            await sse.write(outboundChunk);
            genTimer.mark();
            if (deps.memory !== undefined) accumulateOpenAIChunk(assistant, outboundChunk);
            lastWrite = outboundChunk;
          }
          const tail = streamModelRestamper?.flush() ?? "";
          if (tail !== "") {
            captured.push(tail);
            await sse.write(tail);
            genTimer.mark();
            if (deps.memory !== undefined) accumulateOpenAIChunk(assistant, tail);
            lastWrite = tail;
          }
        } catch (err) {
          // A client disconnect / abort is NOT a provider fault: do not 5xx, do
          // not surface an error frame — the executor layer already recorded it.
          if (!isAbort(err, c.req.raw.signal)) {
            // Preserve a mid-stream idle timeout (UpstreamError("timeout")) instead
            // of flattening it to a generic upstream_error frame.
            const timedOut = isUpstreamTimeout(err);
            const errBody = makeHelmError({
              error_class: timedOut ? "timeout" : "upstream_error",
              message: timedOut ? "upstream timed out" : "upstream error",
              trace_id: traceId,
            });
            await sse.write(`data: ${JSON.stringify({ error: errBody })}\n\n`);
          }
        } finally {
          // Free the concurrency slot FIRST — the bytes are done; the
          // persist/settle bookkeeping below must not extend the hold.
          releaseConcurrency?.();
          // Streamed completion-cost backfill (#6): parse the trailing usage and
          // price it at the served alias. Fail-open — leave cost null on any miss.
          const rawSse = captured.value();
          const finalAlias =
            result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
          try {
            const usage = usageFromSSE(rawSse);
            if (usage) {
              // Cost backfill needs the served alias + pricing closure; the TOKEN
              // stamp does not. Stamp usage whenever the tail has it (dashboard
              // accounting) and price the cost only when costOf is wired.
              const cost = finalAlias && deps.costOf ? deps.costOf(finalAlias, usage) : null;
              backfillCompletionCost(
                result.decision,
                finalAlias,
                cost,
                usage,
                genTimer.generationMs(),
              );
            }
          } catch {
            c.get("logger").log("warn", "cost.stream_backfill_failed", { trace_id: traceId });
          }
          await capturePayload(captureOn ? rawSse : null, result.upstreamRequest ?? null);
          await persist(result.decision);
          // Usage-budget settle (streamed): runs HERE — after the usage tail
          // backfilled the streamed cost — so the spend dimension settles the real
          // total. Tokens come from the same usage tail. Fail-open. NEVER deferred
          // (quota correctness): the next request's pre-route gate must see this spend.
          await settle(result.decision, tokensFromUsage(usageFromSSE(rawSse)));
          // Memory observe (outbound, streamed): persist the reconstructed
          // assistant turn AFTER the bytes were forwarded. Fail-open inside core.
          // Called UNCONDITIONALLY (even with no reconstructed text — e.g. a
          // tool-call-only turn) so the served-model stamp still lands; the empty
          // responseMessages just persist nothing while the stamp records the
          // model auto-compaction prices itself from.
          if (deps.memory !== undefined) {
            // Flush the last partial event the \n\n-split loop held back, so a
            // final frame without a trailing \n\n is not dropped.
            flushOpenAIChunk(assistant);
            const memoryObserve = deps.memory.observe;
            const responseMessages: IRMessage[] =
              assistant.text.length > 0 ? [{ role: "assistant", content: assistant.text }] : [];
            await runObserve(() =>
              observeOutbound(
                memoryObserve,
                memoryScope,
                {
                  responseMessages,
                  toolResults: [],
                  messageIndexOffset: originalMessagesForMemory.length,
                },
                finalAlias,
              ),
            );
          }
        }
      });
    }

    // --- non-streaming branch ---
    // Stamp the served token counts onto the decision BEFORE it is persisted
    // (cost is already settled by execute() on this path, so pass null cost — only
    // usage is written). usage rides the assembled OpenAI body. Fail-open.
    if (result.body !== null) {
      try {
        backfillCompletionCost(result.decision, null, null, usageFromBody(result.body));
      } catch {
        c.get("logger").log("warn", "tokens.backfill_failed", { trace_id: traceId });
      }
    }
    await capturePayload(
      result.body !== null ? JSON.stringify(result.body) : null,
      result.upstreamRequest ?? null,
    );
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
    // Memory observe (outbound, non-stream): persist the assistant message (+ any
    // tool messages) from the OpenAI body. observe self-gates on mode/thread and
    // never throws (fail-open) — it cannot turn a successful 200 into a 5xx.
    if (deps.memory !== undefined) {
      const finalAlias =
        result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
      const memoryObserve = deps.memory.observe;
      const outbound = outboundFromOpenAIBody(result.body);
      await runObserve(() =>
        observeOutbound(
          memoryObserve,
          memoryScope,
          { ...outbound, messageIndexOffset: originalMessagesForMemory.length },
          finalAlias,
        ),
      );
    }
    // Usage-budget settle (non-stream, success): cost is already on the decision;
    // tokens from the body's usage. Fail-open.
    await settle(result.decision, tokensFromUsage(usageFromBody(result.body)));
    return c.json(
      applyResponseModelPolicy(
        result.body as Record<string, unknown>,
        internal.requested_model,
        deps.responseModelPolicy ?? "provider",
      ),
    );
  };

  app.post("/v1/chat/completions", (c) => handleChat(c));
  app.post("/chat/completions", (c) => handleChat(c));
  app.post("/engines/:model{.+}/chat/completions", (c) => handleChat(c, c.req.param("model")));
  app.post("/openai/deployments/:model{.+}/chat/completions", (c) =>
    handleChat(c, c.req.param("model")),
  );
}
