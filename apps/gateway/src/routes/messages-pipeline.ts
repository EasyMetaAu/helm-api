import {
  type AnthropicSSEEvent,
  assembleInjectedContext,
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  convertOpenAIStreamToAnthropic,
  convertOpenAIStreamToResponses,
  type ExecutionResult,
  enqueueObserverWriteback,
  geminiTransformer,
  type InjectDeps,
  type IRChunk,
  type IRMessage,
  type IRResponse,
  injectIntoIR,
  type MemoryScope,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  ownerScopedThreadId,
  type ResponsesSSEEvent,
  type RouteOptions,
  resolveMemoryMode,
} from "@helm/core";
import type { InternalRequest, MemoryDecision, Protocol } from "@helm/shared";
import type { ServingAccount } from "../runtime/serving-account.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";
import {
  backfillCompletionCost,
  type StreamUsage,
  tokensFromUsage,
  usageFromBody,
} from "./payload-capture.js";

// Per-key usage-budget wiring shared by ALL pipeline faces (anthropic /v1/messages,
// openai /v1/responses, gemini :generateContent). The pipeline is the single place
// these three converge, so the budget CHECK (pre-route degrade/reject) + SETTLE
// (post-served) + streamed-cost backfill live here ONCE (docs/06). Absent = no
// budgets (existing tests unchanged). costOf prices the streamed usage tail so the
// spend dimension settles the real cost on the streaming path too.
export interface PipelineBudgetDeps {
  gate: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settle: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
  costOf?: (alias: string, usage: StreamUsage) => number | null;
  now: () => number;
}

// The loose IR the route hands us: the inbound transformer's IRRequest, augmented
// with the `metadata` bag the route stamps the trace_id into. We treat it as an
// opaque field reader (the route's IRLike contract) — never the narrowed core
// IRRequest, which has no `metadata` field.
interface PipelineIR {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  response_format?: unknown;
  max_tokens?: unknown;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// Gateway-side inject wiring (docs/08 Phase 2). Bundles the core InjectDeps with
// the per-deployment token budget (D9). Optional so existing pipeline tests that
// pass only `{ observe }` are unaffected (inject absent → inject is a no-op).
export interface InjectWiring {
  deps: InjectDeps;
  tokenBudget: number;
}

// Anthropic /v1/messages routing pipeline — the framework-agnostic bridge the
// gateway injects into registerMessagesRoute. The messages route is PURE HTTP
// glue (CLAUDE.md principle 1): ALL the IR↔provider plumbing lives HERE, behind
// the `pipeline.run` seam, so the route never learns about InternalRequest, the
// OpenAI executor, or the streaming state machine.
//
// Flow (one hub, never N×N direct):
//   native Anthropic ──(route's transformer)──▶ IR
//      IR ──(toInternalRequest)──▶ InternalRequest ──route()──▶ OpenAI body/stream
//      OpenAI body  ──(openAIBodyToIR)──▶ IRResponse ──(route's transformer)──▶ native
//      OpenAI stream ──(parse SSE)──▶ OpenAIChunk* ──convertOpenAIStreamToAnthropic──▶ AnthropicSSEEvent*
//
// The non-stream IR response and the streamed Anthropic events are produced here;
// the route only serializes them (c.json / streamSSE). docs/02 §Provider Executor
// + docs/05 (stream/tool-call) are honored end-to-end.

// The `route` callback the gateway already builds for /v1/chat/completions. The
// Anthropic pipeline reuses the SAME routing core — only the protocol skin differs.
export type RouteFn = (
  req: InternalRequest,
  opts: RouteOptions,
  signal: AbortSignal,
) => Promise<ExecutionResult & { servingAccount?: ServingAccount | null }>;

// Per-account OAuth subscription usage recorder (providers page Tier 2). Shared by
// all three pipeline faces; called once per served request with the subscription
// the pool selected (null for a configured/non-OAuth provider) + served tokens/cost.
export type RecordOAuthUsageFn = (
  servingAccount: ServingAccount | null,
  servedAlias: string | null,
  usage: { tokens: number; costUsd: number | null },
) => void;

// Protocol-NEUTRAL structured failure raised across the pipeline seam (collect /
// streamIR / run). The routing core returns an error WITHOUT throwing (final.
// status:"error", body/stream:null) — if the pipeline blindly projected that it
// would synthesize an empty assistant message (non-stream) or an empty event
// iterator (stream), i.e. a silent 200. Instead it throws this so each protocol
// route maps it to the correct envelope: the Anthropic route → transformErrorOut,
// the OpenAI/Responses routes → HelmHttpError via onError. It carries the same
// {error_class, message, trace_id} the error transformers consume. NOT a 5xx by
// itself — the class decides the status (all_providers_failed → 502,
// invalid_request → 400).
export class PipelineError extends Error {
  readonly error_class: string;
  readonly trace_id: string;
  constructor(error_class: string, message: string, trace_id: string) {
    super(message);
    this.name = "PipelineError";
    this.error_class = error_class;
    this.trace_id = trace_id;
  }
}

// —— IR request → normalized InternalRequest (Protocol Adapter, anthropic_messages).
// Mirrors chat.ts's toInternalRequest but sources the loose normalized fields
// from the Anthropic-derived IR. The IR messages are already OpenAI-shaped, so
// they pass straight into the pipeline's loose MessageSchema.
function toInternalRequest(
  ir: PipelineIR,
  identity: MessagesIdentity,
  traceId: string,
  protocol: Protocol,
): InternalRequest {
  // `run` already rejected an empty/non-array messages with invalid_request, so
  // this is a non-empty array here (no placeholder synthesis — see PipelineError).
  const messages = ir.messages as InternalRequest["messages"];
  const model = typeof ir.model === "string" && ir.model.length > 0 ? ir.model : "auto";
  const accountId = typeof identity.accountId === "string" ? identity.accountId : "";
  const keyId = typeof identity.keyId === "string" ? identity.keyId : "";
  // conversation_id (session-momentum key) is stamped onto the IR metadata bag by
  // the route from the `x-session-key` header (or carried by the inbound IR).
  const conversationId =
    typeof ir.metadata?.conversation_id === "string" && ir.metadata.conversation_id.length > 0
      ? ir.metadata.conversation_id
      : null;
  // Memory scope (docs/08): the route stamped thread_id/resource_id/project_id/
  // memory_mode onto ir.metadata from the request headers (core never parses
  // HTTP, principle 1). Read them back here so the InternalRequest carries the
  // same scope the OpenAI surface produces.
  const memoryScope = memoryScopeFromMeta(ir.metadata, accountId);

  return {
    request_id: traceId,
    protocol,
    account_id: accountId,
    api_key_id: keyId,
    user_id: typeof identity.userId === "string" ? identity.userId : null,
    org_id: typeof identity.orgId === "string" ? identity.orgId : null,
    requested_model: model,
    messages,
    tools: Array.isArray(ir.tools) ? (ir.tools as unknown[]) : null,
    response_format:
      ir.response_format && typeof ir.response_format === "object"
        ? (ir.response_format as Record<string, unknown>)
        : null,
    attachments: null,
    max_tokens: typeof ir.max_tokens === "number" ? ir.max_tokens : null,
    stream: ir.stream === true,
    metadata: {
      conversation_id: conversationId,
      thread_id: memoryScope.threadId,
      resource_id: memoryScope.resourceId,
      project_id: memoryScope.projectId,
      memory_mode: memoryScope.mode,
    },
  };
}

// Build a MemoryScope from the IR metadata bag the route stamped (docs/08). A
// string id of length 0 or a non-string folds to null; the mode is normalized by
// core's resolveMemoryMode (absent/illegal → off, default-safe). This is the
// IR-metadata twin of resolveMemoryScope's header path — same defaults, no HTTP.
function memoryScopeFromMeta(
  meta: PipelineIR["metadata"],
  accountId: string,
): MemoryScope & { threadSource: string | null } {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    accountId,
    threadId: str(meta?.thread_id),
    resourceId: str(meta?.resource_id),
    projectId: str(meta?.project_id),
    mode: resolveMemoryMode(typeof meta?.memory_mode === "string" ? meta.memory_mode : null),
    // Which fallback-chain link produced the thread (issue #97 observability);
    // stamped by the route alongside the ids, surfaced on DecisionRecord.memory.
    threadSource: str(meta?.memory_thread_source),
  };
}

// Accumulate assistant delta text across OpenAI SSE frames for observeOutbound on
// the streamed path. The pipeline already parses each frame via parseOpenAISSE;
// this reads the delta.content off ONE parsed chunk. Used to reconstruct the
// assistant turn WITHOUT buffering or altering the events forwarded downstream
// (CLAUDE.md principle 8 — both Anthropic + Responses surfaces share this).
function accumulateAssistantText(buffer: { text: string }, chunk: Record<string, unknown>): void {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const ch of choices) {
    const delta = (ch as { delta?: unknown })?.delta as { content?: unknown } | undefined;
    if (typeof delta?.content === "string") buffer.text += delta.content;
  }
}

// Extract the assistant message (+ tool messages) from an IRResponse for
// observeOutbound on the non-stream path. Tolerant of a degraded IR.
function outboundFromIR(ir: IRResponse): {
  responseMessages: IRMessage[];
  toolResults: IRMessage[];
} {
  const responseMessages: IRMessage[] = [];
  const toolResults: IRMessage[] = [];
  for (const ch of ir.choices) {
    const m = ch.message;
    if (m.role === "tool") {
      toolResults.push(m as IRMessage);
    } else {
      responseMessages.push(m as IRMessage);
    }
  }
  return { responseMessages, toolResults };
}

// —— OpenAI chat.completion body → IRResponse. The upstream is OpenAI-compatible
// and the IR takes the OpenAI shape as its skeleton, so this is a near-identity
// projection: content/tool_calls/finish_reason/usage map 1:1. Tolerant of a
// missing field so a degraded upstream body still yields a well-formed IR.
function openAIBodyToIR(body: unknown): IRResponse {
  const b = (body ?? {}) as {
    id?: unknown;
    model?: unknown;
    choices?: unknown;
    usage?: unknown;
  };
  const rawChoices = Array.isArray(b.choices) ? b.choices : [];
  const choices = rawChoices.map((ch, i) => {
    const c = (ch ?? {}) as { index?: unknown; message?: unknown; finish_reason?: unknown };
    const m = (c.message ?? { role: "assistant", content: null }) as {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
    };
    return {
      index: typeof c.index === "number" ? c.index : i,
      message: {
        role: m.role === "assistant" || m.role === "tool" ? m.role : "assistant",
        content: typeof m.content === "string" ? m.content : null,
        ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls as never } : {}),
      },
      finish_reason: typeof c.finish_reason === "string" ? c.finish_reason : null,
    } as IRResponse["choices"][number];
  });
  const usage = (b.usage ?? undefined) as IRResponse["usage"];
  return {
    id: typeof b.id === "string" ? b.id : "chatcmpl-helm",
    model: typeof b.model === "string" ? b.model : "unknown",
    choices:
      choices.length > 0
        ? choices
        : [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
    ...(usage !== undefined ? { usage } : {}),
  };
}

// —— Raw OpenAI SSE text stream → parsed OpenAIChunk objects. The provider yields
// decoded byte chunks (NOT line-aligned), so we normalize CRLF, buffer across
// chunks, split on blank-line SSE event boundaries, collect all `data:` lines,
// skip `[DONE]`, and JSON.parse each frame. Malformed frames are skipped
// (fail-open) rather than 5xx'ing the stream.
async function* parseOpenAISSE(raw: AsyncIterable<string>): AsyncIterable<Record<string, unknown>> {
  let buffer = "";
  for await (const piece of raw) {
    buffer += piece.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const chunk = parseFrame(event);
      if (chunk !== null) yield chunk;
      sep = buffer.indexOf("\n\n");
    }
  }
  const tail = parseFrame(buffer);
  if (tail !== null) yield tail;
}

function parseFrame(event: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of event.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    dataLines.push(trimmed.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (payload === "" || payload === "[DONE]") return null;
  for (const candidate of [payload, dataLines.join("").trim()]) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Try the next legal/compat concatenation form before failing open.
    }
  }
  return null;
}

// Build the pipeline the Anthropic route consumes. `run` returns the two-accessor
// PipelineRunResult: `collect` (non-stream IR response) and `streamIR` (Anthropic
// SSE events). The route picks exactly one based on the IR's stream flag.
export function createMessagesPipeline(
  route: RouteFn,
  // The InternalRequest protocol stamped on every request through this pipeline.
  // Default anthropic_messages (the /v1/messages caller); /v1/responses passes
  // openai_responses so telemetry attributes the surface correctly (principle 5).
  protocol: Protocol = "anthropic_messages",
  // Memory observe-phase wiring (docs/08 Phase 1). Optional — absent = no-op (the
  // pipeline's existing tests run unchanged). When present, observeInbound
  // persists the request before routing and observeOutbound persists the
  // assistant turn after; both self-gate on the resolved MemoryScope and are
  // fail-open (a store failure never surfaces, principle 3). Serves BOTH the
  // /v1/messages and /v1/responses surfaces (they share this pipeline).
  memory?: { observe: ObserveDeps; inject?: InjectWiring },
  // Per-key usage budgets (docs/06). Absent = no budgets. Serves all three
  // pipeline faces at once (they share this pipeline).
  budget?: PipelineBudgetDeps,
  // Per-account OAuth subscription usage recorder (providers page Tier 2). Absent =
  // no recording (existing tests unchanged). Called for EVERY served request,
  // independent of budgets; fail-open in the composition root.
  recordOAuthUsage?: RecordOAuthUsageFn,
): {
  run(ir: PipelineIR, identity: MessagesIdentity, signal: AbortSignal): Promise<PipelineRunResult>;
} {
  return {
    async run(ir, identity, signal) {
      const meta = ir.metadata;
      const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : "anthropic-req";
      // Empty/missing messages is a CLIENT error → invalid_request (mirrors the
      // OpenAI chat schema's messages.min(1)). Throw BEFORE routing so an empty
      // request is never billed or sent upstream as a synthesized placeholder
      // (principle 2 fail-closed); the route maps it to a 400 in the right
      // protocol envelope. Raised here (not in toInternalRequest) so it carries
      // the request trace_id.
      if (!Array.isArray(ir.messages) || ir.messages.length === 0) {
        throw new PipelineError("invalid_request", "messages must be a non-empty array", traceId);
      }
      const internal = toInternalRequest(ir, identity, traceId, protocol);
      const originalMessagesForMemory = [...(internal.messages as IRMessage[])];

      // Memory scope rides ir.metadata, already stamped by the route from the
      // request headers. Inject runs before inbound observe so this turn cannot
      // be loaded as recent_raw and duplicated in the same upstream request.
      const memoryScope = memoryScopeFromMeta(ir.metadata, identity.accountId);

      // Memory inject (docs/08 Phase 2): on x-memory-mode=inject, FULL-REPLACE
      // internal.messages with the assembled docs/08 prefix BEFORE routing. The
      // Anthropic inbound transformer HOISTS the top-level `system` into a leading
      // IR system message (ir.messages[0]), so the system prompt is read from there
      // for BOTH the /v1/messages and /v1/responses surfaces (D8-bis) — never lost.
      // The BRIDGE owns the D7 plain-text gate (tool/multipart turns keep their
      // messages but still enqueue write-back); fully fail-open (never 5xx, never
      // reroute).
      // Inject metadata for the DecisionRecord (docs/08 Step 10) — held here and
      // stamped AFTER route() returns (the routing core never learns about memory).
      let memoryMeta: Omit<MemoryDecision, "thread_source"> | null = null;
      if (memory?.inject !== undefined && memoryScope.mode === "inject") {
        const wiring = memory.inject;
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
            assemble: (input) => assembleInjectedContext(input, wiring.deps),
            enqueueObserver: (scope) => enqueueObserverWriteback(scope, wiring.deps),
            tokenBudget: wiring.tokenBudget,
            now: wiring.deps.now,
            log: wiring.deps.log,
          },
        );
        internal.messages = injected.messages as InternalRequest["messages"];
        memoryMeta = injected.metadata;
      }

      // Memory observe (inbound): persist the original raw messages after
      // inject. It is write-only and fail-open; delaying it prevents self-pollution.
      if (memory !== undefined) {
        await observeInbound(memory.observe, memoryScope, originalMessagesForMemory);
      }

      const caps = identity.caps as
        | { allowCustomModel?: unknown; allowedLanes?: unknown; budget?: BudgetCaps }
        | undefined;
      const allowCustomModel = caps?.allowCustomModel === true;

      // Pre-route usage-budget gate (docs/06), shared across all three pipeline
      // faces. FAIL-CLOSED: a peek store error propagates out of run() → the route
      // surfaces a 5xx, never a silent pass. Over budget → reject (a PipelineError
      // the route maps to a protocol-correct 429) or degrade (cap the lane via
      // keyCaps.maxLane below).
      let degradeLane: string | null = null;
      const budgetCaps = caps?.budget;
      if (budget !== undefined && budgetCaps !== undefined) {
        const check = await budget.gate.check({
          keyId: internal.api_key_id,
          caps: budgetCaps,
          nowMs: budget.now(),
        });
        if (check.overBudget) {
          if (check.behavior === "reject") {
            throw new PipelineError("rate_limited", "usage budget exceeded", traceId);
          }
          degradeLane = check.degradeLane;
        }
      }
      // Display prefix only (never the plaintext key, principle 7) for the Debug
      // UI key column; null when this identity carries none.
      const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;
      // Per-key lane whitelist from the auth record (docs/04): the OUTER,
      // non-negotiable bound the core applies LAST (after policy caps). Thread it
      // straight from identity.caps so a key confined to e.g. ["economy"] is
      // honored on the Anthropic/Responses surfaces too (not just /v1/chat).
      // null = unconstrained; an identity with no caps yields {null} (no-op).
      const keyCaps = {
        allowedLanes: Array.isArray(caps?.allowedLanes) ? (caps.allowedLanes as string[]) : null,
        // Forced degrade lane for this request (docs/06); null = no degrade.
        degradeLane,
      };

      const result = await route(internal, { allowCustomModel, keyPrefix, keyCaps }, signal);
      // The subscription the pool selected (null for a configured/non-OAuth
      // provider), for per-account usage attribution (providers page Tier 2).
      const servingAccount = result.servingAccount ?? null;

      // Stamp the inject metadata onto the DecisionRecord (docs/08 Step 10) so
      // telemetry / the debug UI can see what memory did. Counts + job id only —
      // never memory content (principle 7).
      if (memoryMeta !== null) {
        result.decision.memory = { ...memoryMeta, thread_source: memoryScope.threadSource };
      }

      // Post-served usage-budget settle (docs/06), fail-OPEN. Charges the SETTLED
      // total_usd (never recomputed) + served tokens + 1 request. Shared helper for
      // both accessors; a settle failure is swallowed (never breaks a served
      // response). No-op when budgets are unwired or the key has no caps.
      const settleBudget = async (tokens: number): Promise<void> => {
        if (budget === undefined || budgetCaps === undefined) return;
        try {
          await budget.settle(
            internal.api_key_id,
            budgetCaps,
            { requests: 1, tokens, costUsd: result.decision.cost_breakdown.total_usd },
            budget.now(),
          );
        } catch {
          /* fail-open: a budget settle failure never breaks a served request */
        }
      };

      // Routing returned a structured failure WITHOUT throwing (final.status:
      // "error"). Capture it so the failure surfaces through whichever accessor
      // the route consumes — never as an empty 200 (principle 3: only "all
      // providers failed" returns an error, and it must actually return one).
      const failure =
        result.final.status === "error"
          ? new PipelineError(
              result.error?.error_class ?? "all_providers_failed",
              result.error?.message ?? "all providers failed",
              traceId,
            )
          : null;

      return {
        async collect(): Promise<unknown> {
          if (failure !== null) throw failure;
          // The route surfaces the OpenAI body; project it into the IR the
          // outbound Anthropic transformer expects.
          const irResponse = openAIBodyToIR(result.body);
          // Memory observe (outbound, non-stream): persist the assistant turn (+
          // any tool messages) from the projected IR. Fail-open inside core; it
          // cannot turn a successful response into an error.
          if (memory !== undefined) {
            const finalAlias =
              result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
            await observeOutbound(
              memory.observe,
              memoryScope,
              outboundFromIR(irResponse),
              finalAlias,
            );
          }
          // Settle the budget on the served (non-stream) response: cost is already
          // on the decision; tokens from the OpenAI body's usage.
          const servedTokens = tokensFromUsage(usageFromBody(result.body));
          await settleBudget(servedTokens);
          // Per-account OAuth usage (providers page Tier 2) — recorded regardless of
          // budgets. The served alias lets the recorder drop a STALE account after a
          // fallback. completion_usd is null for flat-rate subscriptions ("unpriced").
          recordOAuthUsage?.(servingAccount, result.decision.final.model_alias, {
            tokens: servedTokens,
            costUsd: result.decision.cost_breakdown.completion_usd,
          });
          return irResponse;
        },
        async *streamIR(): AsyncIterable<Record<string, unknown>> {
          // Surface a routing failure BEFORE any event is emitted, so the route
          // can write a terminal error frame instead of an empty (silent) stream.
          if (failure !== null) throw failure;
          if (result.stream === null) return;
          // Accumulate the assistant text from the OpenAI-side chunks (one
          // accumulator serves ALL protocols) WITHOUT buffering or altering the
          // events forwarded downstream (principle 8). observeOutbound runs in a
          // finally so a client disconnect mid-stream still records what arrived.
          const assistant = { text: "" };
          // Capture the trailing OpenAI usage chunk (include_usage) so the budget
          // settle + streamed-cost backfill below have the real token/cost — the
          // upstream is OpenAI SSE on EVERY face, so this one extractor serves all.
          let lastUsage: StreamUsage | null = null;
          const chunks = parseOpenAISSE(result.stream);
          const source = (async function* () {
            for await (const ch of chunks) {
              if (memory !== undefined) accumulateAssistantText(assistant, ch);
              if (ch.usage && typeof ch.usage === "object") lastUsage = ch.usage as StreamUsage;
              yield ch;
            }
          })();
          try {
            // Outbound stream mapping is chosen by the pipeline's stamped protocol
            // (principle 5: surfaces never conflate). Gemini consumes the SAME
            // OpenAI-shaped chunks parseOpenAISSE produces (its IRChunk IS the
            // OpenAI chat.completion.chunk), so we feed them straight into the
            // Gemini delta state machine — no Anthropic adapter (docs/05). Each
            // yielded object is a GenerateContentResponse delta frame (no `type`);
            // the route writes it as a nameless `data:` SSE frame with no [DONE].
            if (protocol === "gemini") {
              for await (const snapshot of geminiTransformer.transformStreamOut(
                source as AsyncIterable<IRChunk>,
              )) {
                yield snapshot as Record<string, unknown>;
              }
            } else {
              // openai_responses / anthropic both yield typed SSE events; the route
              // treats them as an opaque {type,...} bag, so the branch lives here.
              // The Responses machine also gets the requested model so its
              // synthesized envelope carries it (review-blocker fix d55332e).
              const events =
                protocol === "openai_responses"
                  ? convertOpenAIStreamToResponses(source as AsyncIterable<never>, {
                      model:
                        typeof ir.model === "string" && ir.model.length > 0 ? ir.model : "auto",
                    })
                  : convertOpenAIStreamToAnthropic(source as AsyncIterable<never>);
              for await (const ev of events) {
                yield ev as (AnthropicSSEEvent | ResponsesSSEEvent) & { type: string };
              }
            }
          } finally {
            // Called UNCONDITIONALLY (even when no assistant text was
            // reconstructed — e.g. a tool-call-only stream) so the served-model
            // stamp still lands for auto-compaction pricing; empty
            // responseMessages persist nothing.
            if (memory !== undefined) {
              const finalAlias =
                result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
              await observeOutbound(
                memory.observe,
                memoryScope,
                {
                  responseMessages:
                    assistant.text.length > 0
                      ? [{ role: "assistant", content: assistant.text }]
                      : [],
                  toolResults: [],
                },
                finalAlias,
              );
            }
            // Streamed-cost backfill + budget settle (docs/06). Zero-touch when
            // budgets are unwired/unmetered. The pipeline faces never settled
            // streamed cost before — price the usage tail at the served alias so the
            // decision's total_usd is real, THEN settle the budget. Fail-open.
            if (budget !== undefined && budgetCaps !== undefined) {
              const finalAlias =
                result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
              if (lastUsage && finalAlias && budget.costOf) {
                try {
                  backfillCompletionCost(
                    result.decision,
                    finalAlias,
                    budget.costOf(finalAlias, lastUsage),
                  );
                } catch {
                  /* fail-open: leave cost null on any pricing miss */
                }
              }
              await settleBudget(tokensFromUsage(lastUsage));
            }
            // Per-account OAuth usage (providers page Tier 2) — recorded for every
            // served stream, independent of budgets. The served alias drops a STALE
            // account after a fallback. completion_usd is null for flat-rate
            // subscriptions (or when the cost backfill above didn't run).
            recordOAuthUsage?.(servingAccount, result.decision.final.model_alias, {
              tokens: tokensFromUsage(lastUsage),
              costUsd: result.decision.cost_breakdown.completion_usd,
            });
          }
        },
      };
    },
  };
}
