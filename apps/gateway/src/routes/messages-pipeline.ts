import { Buffer } from "node:buffer";
import {
  type AnthropicSSEEvent,
  assembleInjectedContext,
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  convertOpenAIStreamToAnthropic,
  convertOpenAIStreamToResponses,
  createSSEIncompleteFrameGuard,
  type ExecutionResult,
  enqueueObserverWriteback,
  geminiTransformer,
  type InjectDeps,
  type IRChunk,
  type IRMessage,
  type IRResponse,
  injectIntoIR,
  type MemoryScope,
  nextSSEFrameBoundary,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  projectScopedThreadId,
  type ResponsesSSEEvent,
  type ResponseWorkAdmission,
  type RouteOptions,
  resolveMemoryMode,
  runtimeMemoryBudget,
  runtimeResponseWorkAdmission,
  splitCompleteSSEFrames,
  UpstreamError,
} from "@helm/core";
import type { InternalRequest, MemoryDecision, Protocol } from "@helm/shared";
import {
  cloneCarrierWithBody,
  isEmptyNativeResponsesContinuation,
  isEmptyNativeResponsesPrewarm,
  isNativePassthroughCarrier,
  nativePassthroughBody,
} from "@helm/shared";
import {
  markStartedStreamCancellation,
  requestCancellationReason,
} from "../request-cancellation.js";
import type { ServingAccount } from "../runtime/serving-account.js";
import type { WriteQueue } from "../runtime/write-queue.js";
import { downgradeClientFastModeIfDisallowed } from "./fast-mode.js";
import { copyLiteLLMRequestParams, providerRawFromRequest } from "./internal-request-params.js";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";
import {
  appendMemoryToAnthropicBody,
  appendMemoryToGeminiBody,
  appendMemoryToResponsesBody,
} from "./native-memory-inject.js";
import {
  backfillCompletionCost,
  createResponsesDeltaAccumulator,
  createStreamGenerationTimer,
  estimateInterruptedResponsesUsage,
  type StreamUsage,
  tokensFromUsage,
  usageFromAnthropicResponse,
  usageFromAnthropicSSE,
  usageFromBody,
  usageFromGeminiResponse,
  usageFromGeminiSSE,
  usageFromResponsesResponse,
  usageFromResponsesSSE,
} from "./payload-capture.js";
import { clampClientReasoningEffortToKeyMax } from "./reasoning-cap.js";

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

// Tool XML recovery is request-path behavior, but its operator kill switch is
// runtime mutable. Keep the getter live so an admin change applies to the next
// translated Anthropic stream without rebuilding the shared pipeline closure.
export interface PipelineRuntimeOptions {
  toolCallXmlRecoveryEnabled?: () => boolean;
}

function irFunctionToolNames(tools: unknown): readonly string[] {
  if (!Array.isArray(tools)) return [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;
    if (record.type !== "function") continue;
    const fn = record.function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return [...names];
}

// Count strings already held by the normalized request without serializing or
// copying its complete object graph. Native carriers preserve their exact raw body;
// translated requests retain message content/tool arguments directly.
function retainedRequestBytes(request: InternalRequest): number {
  let bytes = 0;
  if (isNativePassthroughCarrier(request.native_request)) {
    bytes += Buffer.byteLength(request.native_request.raw_body ?? "", "utf8");
  }
  const add = (value: unknown): void => {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
  };
  for (const message of request.messages) {
    add(message.role);
    add(message.content);
    add(message.name);
    add(message.tool_call_id);
    add(message.reasoning_content);
    for (const part of Array.isArray(message.content) ? message.content : []) {
      for (const value of Object.values(part)) add(value);
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (call === null || typeof call !== "object") continue;
      const record = call as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      add(record.id);
      add(record.function?.name);
      add(record.function?.arguments);
    }
  }
  return bytes;
}

// Gateway-side inject wiring (docs/08 Phase 2). Bundles the core InjectDeps with
// the per-deployment token budget (D9). Optional so existing pipeline tests that
// pass only `{ observe }` are unaffected (inject absent → inject is a no-op).
export interface InjectWiring {
  deps: InjectDeps;
  tokenBudget: number;
  // Salient-fact fast path (Change B) — see chat.ts InjectWiring. Absent ⇒ off.
  injectKnownFacts?: boolean;
  maxFactsInjected?: number;
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
  readonly provider_raw: Record<string, unknown> | null;
  constructor(
    error_class: string,
    message: string,
    trace_id: string,
    provider_raw: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "PipelineError";
    this.error_class = error_class;
    this.trace_id = trace_id;
    this.provider_raw = provider_raw;
  }
}

// —— IR request → normalized InternalRequest (Protocol Adapter, anthropic_messages).
// Mirrors chat.ts's toInternalRequest but sources the loose normalized fields
// from the Anthropic-derived IR. The IR messages are already OpenAI-shaped, so
// they pass straight into the pipeline's loose MessageSchema.
function toInternalRequest(
  ir: PipelineIR,
  identity: MessagesIdentity,
  requestId: string,
  traceId: string,
  protocol: Protocol,
): InternalRequest {
  // `run` already rejected empty messages except a pinned Responses continuation or
  // strict generate:false prewarm; no path synthesizes a placeholder (see PipelineError).
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
  const providerRaw = providerRawFromRequest(ir, { includeMetadata: false });
  // Native-protocol-passthrough carrier (#217): the verbatim parsed inbound body
  // the route stamped onto ir.metadata (same HTTP→core hand-off bag as
  // client_billing_header). The core guard + executor read it to forward the
  // request UNTRANSLATED when the inbound protocol matches the upstream's native
  // one. Present only on the anthropic /v1/messages non-stream face (the route
  // stamps it there); absent everywhere else → the field stays unset and routing
  // is identical to today.
  const nativeRequest =
    ir.metadata?.native_request !== null &&
    typeof ir.metadata?.native_request === "object" &&
    !Array.isArray(ir.metadata.native_request)
      ? (ir.metadata.native_request as InternalRequest["native_request"])
      : undefined;

  return {
    request_id: requestId,
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
    ...copyLiteLLMRequestParams(ir),
    ...(providerRaw !== undefined ? { provider_raw: providerRaw } : {}),
    ...(nativeRequest !== undefined ? { native_request: nativeRequest } : {}),
    stream: ir.stream === true,
    metadata: {
      trace_id: traceId,
      conversation_id: conversationId,
      thread_id: memoryScope.threadId,
      resource_id: memoryScope.resourceId,
      project_id: memoryScope.projectId,
      memory_mode: memoryScope.mode,
      ...(typeof ir.metadata?.stateful_provider_alias === "string" &&
      ir.metadata.stateful_provider_alias.length > 0
        ? { stateful_provider_alias: ir.metadata.stateful_provider_alias }
        : {}),
      ...(typeof ir.metadata?.stateful_provider_account === "string" &&
      ir.metadata.stateful_provider_account.length > 0
        ? { stateful_provider_account: ir.metadata.stateful_provider_account }
        : {}),
      ...(typeof ir.metadata?.stateful_lane === "string" && ir.metadata.stateful_lane.length > 0
        ? { stateful_lane: ir.metadata.stateful_lane }
        : {}),
      // The CLI's captured billing identity (anthropic route stamps it; absent on the
      // OpenAI/Gemini surfaces). The native-Anthropic executor reads it to re-emit the
      // client's own version. Length-capped: it is re-emitted into the upstream header.
      ...(typeof ir.metadata?.client_billing_header === "string" &&
      ir.metadata.client_billing_header.length <= 128
        ? { client_billing_header: ir.metadata.client_billing_header }
        : {}),
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

// Reconstruct a minimal assistant turn from a VERBATIM Anthropic-native response
// for observeOutbound on the native-passthrough path (#217). The native body was
// NOT projected into an IR (that is the whole point of passthrough), so this reads
// the response's content[].text blocks directly and concatenates them. Fail-open:
// a missing/degraded content yields an empty turn (observeOutbound then persists
// nothing but still stamps the served model). NEVER throws.
function assistantTurnFromNativeAnthropic(body: unknown): IRMessage[] {
  const content = (body as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  let text = "";
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text.length > 0 ? [{ role: "assistant", content: text }] : [];
}

// Reconstruct a minimal assistant turn from a VERBATIM Codex Responses non-stream
// response for observeOutbound on the native-passthrough path (#217 Phase 3). The
// native body was NOT projected into an IR, so this reads the Responses `output`
// array directly: each `message` item carries a `content[]` of `output_text` parts
// whose `text` is concatenated. Fail-open: a missing/degraded output yields an empty
// turn (observeOutbound persists nothing but still stamps the served model). NEVER
// throws. Codex is stream-only so this is rarely exercised, but kept correct.
function assistantTurnFromNativeResponses(body: unknown): IRMessage[] {
  const output = (body as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return [];
  let text = "";
  for (const item of output) {
    const it = item as { type?: unknown; content?: unknown } | null;
    if (it?.type !== "message" || !Array.isArray(it.content)) continue;
    for (const part of it.content) {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p?.type === "output_text" && typeof p.text === "string") text += p.text;
    }
  }
  return text.length > 0 ? [{ role: "assistant", content: text }] : [];
}

// Reconstruct a minimal assistant turn from a VERBATIM Gemini GenerateContent
// non-stream response for observeOutbound on the native-passthrough path (P2-GEM-01
// governance). The native body was NOT projected into an IR, so this reads the Gemini
// `candidates[].content.parts[]` directly, concatenating each part's `text`. Fail-open:
// a missing/degraded body yields an empty turn (observeOutbound persists nothing but
// still stamps the served model). NEVER throws.
function assistantTurnFromNativeGemini(body: unknown): IRMessage[] {
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return [];
  let text = "";
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } } | null)?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { text?: unknown } | null;
      if (typeof p?.text === "string") text += p.text;
    }
  }
  return text.length > 0 ? [{ role: "assistant", content: text }] : [];
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
  const frameGuard = createSSEIncompleteFrameGuard(runtimeResponseWorkAdmission());
  try {
    for await (const piece of raw) {
      frameGuard.resize(Buffer.byteLength(buffer) + Buffer.byteLength(piece));
      buffer += piece;
      const { frames, tail } = splitCompleteSSEFrames(buffer);
      buffer = tail;
      frameGuard.resize(Buffer.byteLength(buffer));
      for (const event of frames) {
        const chunk = parseFrame(event);
        if (chunk !== null) yield chunk;
      }
    }
    const tail = parseFrame(buffer);
    if (tail !== null) yield tail;
  } finally {
    frameGuard.release();
  }
}

function parseFrame(event: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of event.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
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

// —— Native-passthrough SSE frame splitter (#217 Phase 2/3). The raw upstream SSE
// text (AsyncIterable<string>, NOT frame-aligned) is buffered across chunks and
// split on the blank-line `\n\n` event boundary — the SAME buffering as
// parseOpenAISSE, but it NEVER JSON-parses/re-serializes. PROTOCOL-NEUTRAL: Anthropic
// (event/data pairs) and openai_responses (Codex: event/data pairs) share the exact
// SSE wire framing, so one splitter serves both passthrough faces. For each complete
// frame it extracts the VERBATIM `event:` line value and the VERBATIM `data:` payload
// STRING (everything after `data:`, with at most one leading space stripped per the
// SSE spec) and yields them alongside the frame's raw text. The data payload reaches
// the client byte-for-byte — only the SSE envelope is reframed downstream by Hono's
// writeSSE (semantically identical). This ELIMINATES the per-protocol SSE re-mapping
// state machine (the #221/#222 reasoning/tool mangling source) instead of replacing
// it (principle 8).
export interface RawSSEFrame {
  /** The verbatim `event:` line value (empty when the frame carries no event line). */
  event: string;
  /** The verbatim `data:` payload string (the exact upstream JSON), unparsed. */
  data: string;
  /** The frame's raw text incl. event/data lines + trailing blank line. The route's
   *  raw writer forwards this byte-for-byte; the usage tee scans data lines off it. */
  raw: string;
}

function parseRawSSEFrame(event: string, raw: string): RawSSEFrame | null {
  if (event.length === 0 && raw.length === 0) return null;
  let evtName = "";
  const dataLines: string[] = [];
  for (const line of event.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("event:")) {
      evtName = line.slice("event:".length).replace(/^ /, "");
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  // Multi-line data is joined with \n per the SSE spec (both protocols use single-line).
  return { event: evtName, data: dataLines.join("\n"), raw };
}

function assertNativeSSEFrameFits(frame: string, maxFrameBytes: number): void {
  if (maxFrameBytes === 0 || Buffer.byteLength(frame) <= maxFrameBytes) return;
  throw new UpstreamError("upstream_error", "upstream SSE frame exceeds the runtime memory budget");
}

export async function* splitSSEFrames(
  raw: AsyncIterable<string>,
  maxFrameBytes = 0,
  workAdmission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): AsyncIterable<RawSSEFrame> {
  const acquired = workAdmission.acquire(0);
  if (!acquired.ok) {
    throw new UpstreamError(
      "upstream_error",
      "upstream response memory capacity is temporarily exhausted",
    );
  }
  const { lease } = acquired;
  let buffer = "";
  const resize = (wireBytes: number): void => {
    if (lease.resize(wireBytes).ok) return;
    throw new UpstreamError(
      "upstream_error",
      "upstream response memory capacity is temporarily exhausted",
    );
  };
  try {
    for await (const piece of raw) {
      resize(Buffer.byteLength(buffer) + Buffer.byteLength(piece));
      buffer += piece;
      let sep = nextSSEFrameBoundary(buffer);
      while (sep !== null) {
        const rawFrame = buffer.slice(0, sep.index + sep.length);
        assertNativeSSEFrameFits(rawFrame, maxFrameBytes);
        const frame = parseRawSSEFrame(buffer.slice(0, sep.index), rawFrame);
        buffer = buffer.slice(sep.index + sep.length);
        if (frame !== null) yield frame;
        resize(Buffer.byteLength(buffer));
        sep = nextSSEFrameBoundary(buffer);
      }
      assertNativeSSEFrameFits(buffer, maxFrameBytes);
    }
    assertNativeSSEFrameFits(buffer, maxFrameBytes);
    const tail = parseRawSSEFrame(buffer, buffer);
    if (tail !== null) yield tail;
  } finally {
    lease.release();
  }
}

// Accumulate assistant text from a VERBATIM Anthropic content_block_delta data
// payload for observeOutbound on the native-passthrough stream (#217 Phase 2). Reads
// `delta.type==='text_delta' → delta.text` off the parsed frame data. Fail-open: a
// non-JSON / non-text-delta frame contributes nothing. NEVER throws.
export interface AssistantTextAccumulator {
  text: string;
  limited: boolean;
  push(text: string): void;
}

export function createAssistantTextAccumulator(
  maxBytes = runtimeMemoryBudget().responseCaptureBytes,
): AssistantTextAccumulator {
  const limit = Math.max(0, Math.floor(maxBytes));
  return {
    text: "",
    limited: false,
    push(text) {
      if (this.limited) return;
      if (Buffer.byteLength(this.text) + Buffer.byteLength(text) > limit) {
        this.text = "";
        this.limited = true;
        return;
      }
      this.text += text;
    },
  };
}

function accumulateAnthropicAssistantText(
  buffer: AssistantTextAccumulator,
  dataPayload: string,
): void {
  if (dataPayload === "" || dataPayload === "[DONE]") return;
  let evt: { type?: unknown; delta?: unknown };
  try {
    evt = JSON.parse(dataPayload) as { type?: unknown; delta?: unknown };
  } catch {
    return;
  }
  if (evt?.type !== "content_block_delta") return;
  const delta = evt.delta as { type?: unknown; text?: unknown } | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string") buffer.push(delta.text);
}

// Accumulate assistant text from a VERBATIM Codex Responses SSE data payload for
// observeOutbound on the native-passthrough stream (#217 Phase 3). The Responses SSE
// carries assistant text as `response.output_text.delta` events whose `delta` is a
// plain STRING (unlike Anthropic's nested delta.text). Fail-open: a non-JSON / non-
// output-text-delta frame contributes nothing. NEVER throws.
function accumulateResponsesAssistantText(
  buffer: AssistantTextAccumulator,
  dataPayload: string,
): void {
  if (dataPayload === "" || dataPayload === "[DONE]") return;
  let evt: { type?: unknown; delta?: unknown };
  try {
    evt = JSON.parse(dataPayload) as { type?: unknown; delta?: unknown };
  } catch {
    return;
  }
  if (evt?.type !== "response.output_text.delta") return;
  if (typeof evt.delta === "string") buffer.push(evt.delta);
}

// Accumulate assistant text from a VERBATIM Gemini streamGenerateContent SSE data
// payload for observeOutbound on the native-passthrough stream (P2-GEM-01 governance).
// Gemini frames are nameless `data:` GenerateContent deltas carrying
// `candidates[].content.parts[].text` (no `type` discriminator). Fail-open: a non-JSON
// frame contributes nothing. NEVER throws.
function accumulateGeminiAssistantText(
  buffer: AssistantTextAccumulator,
  dataPayload: string,
): void {
  if (dataPayload === "" || dataPayload === "[DONE]") return;
  let evt: { candidates?: unknown };
  try {
    evt = JSON.parse(dataPayload) as { candidates?: unknown };
  } catch {
    return;
  }
  if (!Array.isArray(evt?.candidates)) return;
  for (const candidate of evt.candidates) {
    const parts = (candidate as { content?: { parts?: unknown } } | null)?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { text?: unknown } | null;
      if (typeof p?.text === "string") buffer.push(p.text);
    }
  }
}

function nonNegativeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeOpenAIStreamUsageForIR(chunk: Record<string, unknown>): Record<string, unknown> {
  const usage = objectRecord(chunk.usage);
  if (usage === undefined) return chunk;
  const promptDetails = objectRecord(usage.prompt_tokens_details);
  const completionDetails = objectRecord(usage.completion_tokens_details);
  const cached =
    nonNegativeToken(usage.cached_tokens) ?? nonNegativeToken(promptDetails?.cached_tokens) ?? 0;
  const cacheCreation =
    nonNegativeToken(usage.cache_creation_tokens) ??
    nonNegativeToken(promptDetails?.cache_creation_tokens) ??
    nonNegativeToken(promptDetails?.cache_creation_input_tokens) ??
    nonNegativeToken(promptDetails?.cache_write_tokens) ??
    0;
  const prompt = nonNegativeToken(usage.prompt_tokens);
  const completion = nonNegativeToken(usage.completion_tokens);
  const reasoning =
    nonNegativeToken(usage.reasoning_tokens) ??
    nonNegativeToken(completionDetails?.reasoning_tokens);
  return {
    ...chunk,
    usage: {
      ...(prompt !== undefined
        ? { prompt_tokens: Math.max(0, prompt - cached - cacheCreation) }
        : {}),
      ...(completion !== undefined ? { completion_tokens: completion } : {}),
      ...(cached > 0 ? { cached_tokens: cached } : {}),
      ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
      ...(promptDetails !== undefined ? { prompt_tokens_details: promptDetails } : {}),
      ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
      ...(completionDetails !== undefined ? { completion_tokens_details: completionDetails } : {}),
    },
  };
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
  // Deferred + batched write queue (perf). ABSENT = today's behavior (memory observe
  // is awaited inline; observeInbound blocks before routing). PRESENT = the fail-open
  // observe writes are enqueued (FIFO, so inbound still settles before outbound) to
  // run AFTER the response. The budget settle is NEVER deferred (quota correctness).
  writes?: WriteQueue,
  // Live runtime behavior switches. Optional for compatibility with existing callers;
  // XML recovery defaults ON when the getter is absent, matching the settings schema.
  runtime?: PipelineRuntimeOptions,
): {
  run(ir: PipelineIR, identity: MessagesIdentity, signal: AbortSignal): Promise<PipelineRunResult>;
} {
  return {
    async run(ir, identity, signal) {
      const meta = ir.metadata;
      const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : "anthropic-req";
      const requestId =
        meta && typeof meta.request_id === "string" && meta.request_id.length > 0
          ? meta.request_id
          : crypto.randomUUID();
      // Empty/missing messages is a CLIENT error → invalid_request (mirrors the
      // OpenAI chat schema's messages.min(1)). Throw BEFORE routing so an empty
      // request is never billed or sent upstream as a synthesized placeholder
      // (principle 2 fail-closed); the route maps it to a 400 in the right
      // protocol envelope. Raised here (not in toInternalRequest) so it carries
      // the request trace_id.
      if (
        !Array.isArray(ir.messages) ||
        (ir.messages.length === 0 &&
          !isEmptyNativeResponsesContinuation({
            protocol,
            messages: ir.messages,
            provider_raw: ir.provider_raw,
            native_request: ir.metadata?.native_request,
            metadata: ir.metadata,
          }) &&
          !isEmptyNativeResponsesPrewarm({
            protocol,
            messages: ir.messages,
            provider_raw: ir.provider_raw,
            native_request: ir.metadata?.native_request,
          }))
      ) {
        throw new PipelineError("invalid_request", "messages must be a non-empty array", traceId);
      }
      const internal = clampClientReasoningEffortToKeyMax(
        downgradeClientFastModeIfDisallowed(
          toInternalRequest(ir, identity, requestId, traceId, protocol),
          identity.caps?.allowFastMode === true,
        ),
        identity.caps?.maxReasoningEffort,
      );
      const originalMessagesForMemory = [...(internal.messages as IRMessage[])];
      const observeRetainedBytes = retainedRequestBytes(internal);
      // Deferred observe closures retain normalized request strings. Their exact
      // string-byte estimate is charged by WriteQueue with the runtime-derived JSON
      // amplification; inline mode remains unchanged.
      const runObserve = async (task: () => Promise<unknown>, wake = true): Promise<void> => {
        if (writes !== undefined) {
          await writes.enqueueTask(
            async () => {
              await task();
            },
            { wakeOnSettle: wake, retainedBytes: observeRetainedBytes },
          );
          return;
        }
        await task();
      };

      // Memory scope rides ir.metadata, already stamped by the route from the
      // request headers. Inject runs before inbound observe so this turn cannot
      // be loaded as recent_raw and duplicated in the same upstream request.
      const memoryScope = memoryScopeFromMeta(ir.metadata, identity.accountId);

      // Memory inject (docs/08 Phase 2, #217 Phase 4 TRAILING-REMINDER model): on
      // x-memory-mode=inject the assembler produces ONE memory TEXT BLOCK and the bridge
      // APPENDS it additively as a trailing <system-reminder> turn — never a full
      // replace, never a system-prefix edit. The translate path keeps the leading IR
      // system message (and any client cache_control on it) and every other turn (user /
      // assistant / tool, incl. tool_calls + multipart/image content) VERBATIM, with the
      // reminder last. No replacement ⇒ no structure loss ⇒ the legacy D7 plain-text gate
      // is GONE.
      //
      // For a NATIVE passthrough request (native_request present) the same memory block
      // is spliced into the VERBATIM native carrier as a trailing reminder turn on
      // messages / input, leaving system / instructions (and the client's cached prefix)
      // untouched — so passthrough fires WITH memory (the guard no longer disables inject)
      // AND keeps the upstream prompt cache. Fully fail-open (never 5xx, never reroute).
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
              ? {
                  threadId: projectScopedThreadId(
                    memoryScope.accountId,
                    memoryScope.projectId,
                    memoryScope.threadId,
                  ),
                }
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
        // TRANSLATE path: the IR carries memory merged into its system message; the
        // live turns ride through verbatim.
        internal.messages = injected.messages as InternalRequest["messages"];
        memoryMeta = injected.metadata;

        // NATIVE passthrough path: splice the SAME block into the verbatim native
        // carrier as a trailing <system-reminder> turn (cache-preserve revision of
        // decision #3) so the body the executor forwards is memory-augmented yet self-
        // consistent (memory appended AFTER the conversation; system/instructions and
        // every existing turn — including the client's cached prefix — verbatim).
        // Reassign the spliced (NEW) body; absent block / absent native_request / a
        // non-native protocol ⇒ leave native_request as-is.
        if (injected.memoryBlock !== null && internal.native_request !== undefined) {
          const nativeBody = nativePassthroughBody(internal.native_request);
          if (protocol === "anthropic_messages") {
            const body = appendMemoryToAnthropicBody(nativeBody, injected.memoryBlock);
            internal.native_request = isNativePassthroughCarrier(internal.native_request)
              ? cloneCarrierWithBody(internal.native_request, body)
              : body;
          } else if (protocol === "openai_responses") {
            const body = appendMemoryToResponsesBody(nativeBody, injected.memoryBlock);
            internal.native_request = isNativePassthroughCarrier(internal.native_request)
              ? cloneCarrierWithBody(internal.native_request, body)
              : body;
          } else if (protocol === "gemini") {
            const body = appendMemoryToGeminiBody(nativeBody, injected.memoryBlock);
            internal.native_request = isNativePassthroughCarrier(internal.native_request)
              ? cloneCarrierWithBody(internal.native_request, body)
              : body;
          }
          if (isNativePassthroughCarrier(internal.native_request)) {
            internal.native_request.mutations.memory_appended = true;
          }
        }
      }

      // Memory observe (inbound): persist the original raw messages after
      // inject. It is write-only and fail-open; delaying it prevents self-pollution.
      if (memory !== undefined) {
        const memoryObserve = memory.observe;
        await runObserve(
          () => observeInbound(memoryObserve, memoryScope, originalMessagesForMemory),
          false, // inbound: do NOT wake — wait for the outbound observe to land the turn
        );
      }

      const caps = identity.caps as
        | {
            allowCustomModel?: unknown;
            allowedLanes?: unknown;
            blockedModels?: unknown;
            budget?: BudgetCaps;
          }
        | undefined;
      const allowCustomModel = caps?.allowCustomModel === true;

      // Pre-route usage-budget gate (docs/06), shared across all three pipeline
      // faces. FAIL-CLOSED: a peek store error propagates out of run() → the route
      // surfaces a 5xx, never a silent pass. Over budget → reject (a PipelineError
      // the route maps to a protocol-correct 429) or degrade (cap the lane via
      // keyCaps.degradeLane below).
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
        blockedModels: Array.isArray(caps?.blockedModels) ? (caps.blockedModels as string[]) : null,
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
              result.error?.provider_raw ?? null,
            )
          : null;

      return {
        // The LIVE decision reference (mutated in place by backfillCompletionCost
        // in the stream finally below), exposed so the route records the FINAL
        // decision after consumption. Present even on a routing failure.
        decision: result.decision,
        // Native-protocol-passthrough flag (#217): true when route() forwarded the
        // request untranslated and `result.body` is the upstream's VERBATIM native
        // response. The route reads this to BYPASS transformResponseOut and hand the
        // native body back byte-for-byte. Absent/false → today's translate path.
        nativePassthrough: result.nativePassthrough === true,
        // The exact body forwarded upstream for the served attempt (post inject +
        // translation). Exposed so the three faces capture it into the payload table.
        upstreamRequest: result.upstreamRequest,
        // Concrete subscription account selected by the OAuth pool, or null for a
        // configured/non-OAuth provider. Routes stamp it just before telemetry write.
        servingAccount,
        responseMetadata: result.responseMetadata,
        async collect(): Promise<unknown> {
          if (failure !== null) throw failure;
          // Native passthrough (#217): the upstream's response is already in the
          // client's native protocol. Return result.body UNTOUCHED (skip
          // openAIBodyToIR) — the route then skips transformResponseOut too, so the
          // verbatim native body reaches the client byte-for-byte. Governance is
          // fully preserved: usage is normalized from the NATIVE (Anthropic) usage
          // block so cost/budget/OAuth settle identically to a translated attempt,
          // and observe-outbound persists the assistant turn reconstructed from the
          // native content. The decision record stays body-free (principle 7).
          if (result.nativePassthrough === true) {
            // Memory observe (outbound): reconstruct the assistant turn from the
            // native response (the body was never projected into an IR). Protocol-
            // aware: Anthropic reads content[].text, Responses reads output[].content[]
            // .output_text, Gemini reads candidates[].content.parts[].text. Fail-open —
            // an empty/degraded body persists nothing.
            if (memory !== undefined) {
              const finalAlias =
                result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
              const memoryObserve = memory.observe;
              const responseMessages =
                protocol === "openai_responses"
                  ? assistantTurnFromNativeResponses(result.body)
                  : protocol === "gemini"
                    ? assistantTurnFromNativeGemini(result.body)
                    : assistantTurnFromNativeAnthropic(result.body);
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
            // Cost/budget settle: normalize the native usage block into the OpenAI-
            // shaped StreamUsage the helpers understand (cost was already settled on the
            // decision by execute()). Protocol-aware: Responses + Gemini count cache
            // INSIDE the prompt count, Anthropic reports it separately.
            const servedUsage =
              protocol === "openai_responses"
                ? usageFromResponsesResponse(result.body)
                : protocol === "gemini"
                  ? usageFromGeminiResponse(result.body)
                  : usageFromAnthropicResponse(result.body);
            try {
              backfillCompletionCost(result.decision, null, null, servedUsage);
            } catch {
              /* fail-open: leave usage null on any mapping miss */
            }
            const servedTokens = tokensFromUsage(servedUsage);
            await settleBudget(servedTokens);
            recordOAuthUsage?.(servingAccount, result.decision.final.model_alias, {
              tokens: servedTokens,
              costUsd: result.decision.cost_breakdown.completion_usd,
            });
            return result.body;
          }

          // The route surfaces the OpenAI body; project it into the IR the
          // outbound Anthropic transformer expects.
          const irResponse = openAIBodyToIR(result.body);
          // Memory observe (outbound, non-stream): persist the assistant turn (+
          // any tool messages) from the projected IR. Fail-open inside core; it
          // cannot turn a successful response into an error.
          if (memory !== undefined) {
            const finalAlias =
              result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
            const memoryObserve = memory.observe;
            const outbound = outboundFromIR(irResponse);
            await runObserve(() =>
              observeOutbound(
                memoryObserve,
                memoryScope,
                { ...outbound, messageIndexOffset: originalMessagesForMemory.length },
                finalAlias,
              ),
            );
          }
          // Settle the budget on the served (non-stream) response: cost is already
          // on the decision; tokens from the OpenAI body's usage.
          const servedUsage = usageFromBody(result.body);
          // Stamp the served token counts onto the decision BEFORE recordServed
          // persists it (cost is already settled on this path → pass null cost; only
          // `usage` is written). Dashboard token accounting. Fail-open.
          try {
            backfillCompletionCost(result.decision, null, null, servedUsage);
          } catch {
            /* fail-open: leave usage null on any mapping miss */
          }
          const servedTokens = tokensFromUsage(servedUsage);
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

          // True-TPS denominator: time the served generation window (first→last
          // yielded event) as the pipeline emits IR frames downstream. One timer
          // serves BOTH the native-passthrough and translated branches; its span is
          // stamped onto the decision in each branch's finally (next to the usage
          // backfill). Reuse the budget clock when wired (production), else wall time
          // — mirrors the sibling faces. Heartbeats are injected by the route, not
          // here, so they never count.
          const genTimer = createStreamGenerationTimer(budget?.now ?? (() => Date.now()));

          // Native-passthrough stream (#217 Phase 2/3): route() byte-relayed the
          // upstream native SSE into result.stream (raw decoded text). Forward it
          // VERBATIM as {event,data} frames — NO parseOpenAISSE → convertOpenAIStream
          // To{Anthropic,Responses} translation (the #221/#222 reasoning/tool mangling
          // state machine is ELIMINATED here, principle 8). A COPY of each frame feeds
          // usage extraction + assistant-text accumulation for governance WITHOUT
          // altering the forwarded bytes (tee). The TEE is PROTOCOL-AWARE: the usage
          // extractor + assistant-text accumulator differ between anthropic_messages
          // (split across message_start/message_delta; nested text_delta) and
          // openai_responses (totals on the terminal response.completed/incomplete;
          // string delta on response.output_text.delta), selected by the pipeline's
          // stamped `protocol`. The byte-faithful forward itself is identical.
          if (result.nativePassthrough === true) {
            const passthroughStream = result.stream;
            // Per-protocol usage extraction: Anthropic splits usage across
            // message_start/message_delta; Responses carries totals on the terminal
            // response.completed/incomplete; Gemini emits CUMULATIVE usageMetadata on
            // every frame (the last frame wins).
            const isUsageCarrierFrame = (data: string): boolean =>
              protocol === "openai_responses"
                ? data.includes("response.completed") ||
                  data.includes("response.incomplete") ||
                  data.includes("response.failed")
                : protocol === "gemini"
                  ? data.includes("usageMetadata")
                  : data.includes("message_start") || data.includes("message_delta");
            // Bounded usage buffer: keep ONLY the usage-bearing frames. Anthropic
            // carries usage on message_start (input/cache) + the trailing message_delta
            // (output); Responses carries the totals on the terminal response.completed/
            // response.incomplete event. This is O(usage frames), not O(response),
            // regardless of body length — the assistant text (which can be large) is
            // never retained, only its running concatenation in `assistant.text` which
            // observeOutbound consumes once.
            let usageBuffer = "";
            // Only semantic token-bearing DELTAS are retained. Done snapshots and
            // encrypted/base64 payloads are ignored, while fragments are joined
            // before tokenization so network chunking cannot change the estimate.
            const responsesDeltas = createResponsesDeltaAccumulator();
            const passthroughAssistant = createAssistantTextAccumulator();
            try {
              for await (const frame of splitSSEFrames(passthroughStream)) {
                // Tee (read-only): usage carriers feed the SSE usage extractor; every
                // frame's text delta feeds the assistant-turn reconstruction. Neither
                // touches the bytes yielded downstream (byte-faithful forward). The
                // usage-frame filter is generalized to catch BOTH protocols' carriers.
                if (isUsageCarrierFrame(frame.data)) {
                  // Gemini's usageMetadata is CUMULATIVE per frame → keep ONLY the latest
                  // (stays bounded). Anthropic/Responses need their distinct carriers
                  // appended (input on message_start, output on message_delta / terminal).
                  usageBuffer = protocol === "gemini" ? frame.raw : usageBuffer + frame.raw;
                }
                if (protocol === "openai_responses") {
                  responsesDeltas.observe(frame.data);
                }
                if (memory !== undefined) {
                  if (protocol === "openai_responses") {
                    accumulateResponsesAssistantText(passthroughAssistant, frame.data);
                  } else if (protocol === "gemini") {
                    accumulateGeminiAssistantText(passthroughAssistant, frame.data);
                  } else {
                    accumulateAnthropicAssistantText(passthroughAssistant, frame.data);
                  }
                }
                // Yield the VERBATIM frame: routes use `raw` when present, so comment
                // frames / keepalives / CRLF boundaries survive the Hono boundary too.
                genTimer.mark();
                yield {
                  event: frame.event,
                  data: frame.data,
                  raw: frame.raw,
                };
              }
            } finally {
              // Mirror the non-passthrough finally below: observe-outbound (assistant
              // turn from the reconstructed text), streamed token/cost backfill,
              // budget settle, and per-account OAuth usage. All fail-open. The usage
              // extractor matches the inbound protocol (Responses totals on the terminal
              // event; Anthropic split across message_start/message_delta).
              const reportedUsage =
                protocol === "openai_responses"
                  ? usageFromResponsesSSE(usageBuffer)
                  : protocol === "gemini"
                    ? usageFromGeminiSSE(usageBuffer)
                    : usageFromAnthropicSSE(usageBuffer);
              // A provider terminal usage block, including explicit zeros, always
              // wins. Any Responses stream without reported usage falls back to a
              // partial estimate, including failed/incomplete terminals that omit it.
              const nativeUsage =
                reportedUsage ??
                (protocol === "openai_responses"
                  ? estimateInterruptedResponsesUsage(
                      result.upstreamRequest,
                      responsesDeltas.channels(),
                      responsesDeltas.overflowBytes(),
                    )
                  : null);
              const finalAlias =
                result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
              if (protocol === "openai_responses") {
                const cancellation = requestCancellationReason(signal);
                if (cancellation !== null) {
                  markStartedStreamCancellation(result.decision, cancellation);
                } else {
                  const settledOutcome = responsesDeltas.outcome() ?? "truncated";
                  result.decision.stream_outcome = settledOutcome;
                  if (settledOutcome === "truncated") {
                    result.decision.final = {
                      ...result.decision.final,
                      status: "error",
                      error_reason: "upstream_error",
                    };
                  }
                }
              }
              if (memory !== undefined && !passthroughAssistant.limited) {
                const memoryObserve = memory.observe;
                const responseMessages: IRMessage[] =
                  passthroughAssistant.text.length > 0
                    ? [{ role: "assistant", content: passthroughAssistant.text }]
                    : [];
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
              try {
                const cost =
                  nativeUsage && finalAlias && budget?.costOf
                    ? budget.costOf(finalAlias, nativeUsage)
                    : null;
                // Generation time is independent of usage availability: even a
                // malformed terminal frame must not erase the measured stream span.
                backfillCompletionCost(
                  result.decision,
                  finalAlias,
                  cost,
                  nativeUsage,
                  genTimer.generationMs(),
                );
              } catch {
                /* fail-open: leave cost/usage null on any mapping miss */
              }
              await settleBudget(tokensFromUsage(nativeUsage));
              recordOAuthUsage?.(servingAccount, result.decision.final.model_alias, {
                tokens: tokensFromUsage(nativeUsage),
                costUsd: result.decision.cost_breakdown.completion_usd,
              });
            }
            return;
          }
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
              yield protocol === "gemini" ? normalizeOpenAIStreamUsageForIR(ch) : ch;
            }
          })();
          try {
            // Outbound stream mapping is chosen by the pipeline's stamped protocol
            // (principle 5: surfaces never conflate). Gemini consumes the SAME
            // OpenAI-shaped chunks parseOpenAISSE produces (its IRChunk IS the
            // OpenAI chat.completion.chunk). The source generator above normalizes
            // raw OpenAI usage into IR usage first, then feeds the Gemini delta
            // state machine — no Anthropic adapter (docs/05). Each yielded object
            // is a GenerateContentResponse delta frame (no `type`); the route
            // writes it as a nameless `data:` SSE frame with no [DONE].
            if (protocol === "gemini") {
              for await (const snapshot of geminiTransformer.transformStreamOut(
                source as AsyncIterable<IRChunk>,
              )) {
                genTimer.mark();
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
                      id:
                        typeof ir.metadata?.responses_stream_id === "string" &&
                        ir.metadata.responses_stream_id.length > 0
                          ? ir.metadata.responses_stream_id
                          : undefined,
                      model:
                        typeof ir.model === "string" && ir.model.length > 0 ? ir.model : "auto",
                    })
                  : convertOpenAIStreamToAnthropic(source as AsyncIterable<never>, {
                      id: result.decision.request_id,
                      model:
                        result.decision.final?.status === "ok"
                          ? (result.decision.final.provider_model ??
                            result.decision.final.model_alias ??
                            (typeof ir.model === "string" ? ir.model : undefined))
                          : typeof ir.model === "string"
                            ? ir.model
                            : undefined,
                      toolNames: irFunctionToolNames(ir.tools),
                      toolCallXmlRecoveryEnabled: runtime?.toolCallXmlRecoveryEnabled?.() ?? true,
                    });
              for await (const ev of events) {
                genTimer.mark();
                yield ev as (AnthropicSSEEvent | ResponsesSSEEvent) & { type: string };
              }
            }
          } finally {
            if (protocol === "openai_responses") {
              const cancellation = requestCancellationReason(signal);
              if (cancellation !== null) {
                markStartedStreamCancellation(result.decision, cancellation);
              }
            }
            // Called UNCONDITIONALLY (even when no assistant text was
            // reconstructed — e.g. a tool-call-only stream) so the served-model
            // stamp still lands for auto-compaction pricing; empty
            // responseMessages persist nothing.
            if (memory !== undefined) {
              const finalAlias =
                result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
              const memoryObserve = memory.observe;
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
            // Streamed token accounting + cost backfill. The token stamp is NOT a
            // budget feature: admin replay intentionally omits budget deps but still
            // records telemetry, so stamp usage whenever the provider emitted a
            // usage tail. Cost pricing is opportunistic when the composition root
            // wired costOf. Budget settlement remains gated inside settleBudget().
            const finalAlias =
              result.decision.final?.status === "ok" ? result.decision.final.model_alias : null;
            try {
              const cost =
                lastUsage && finalAlias && budget?.costOf
                  ? budget.costOf(finalAlias, lastUsage)
                  : null;
              backfillCompletionCost(
                result.decision,
                finalAlias,
                cost,
                lastUsage,
                genTimer.generationMs(),
              );
            } catch {
              /* fail-open: leave cost/usage null on any mapping miss */
            }
            await settleBudget(tokensFromUsage(lastUsage));
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
