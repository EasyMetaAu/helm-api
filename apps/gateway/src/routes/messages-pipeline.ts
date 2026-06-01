import {
  type AnthropicSSEEvent,
  convertOpenAIStreamToAnthropic,
  type ExecutionResult,
  type IRMessage,
  type IRResponse,
  type MemoryScope,
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  type RouteOptions,
  resolveMemoryMode,
} from "@helm/core";
import type { InternalRequest, Protocol } from "@helm/shared";
import type { MessagesIdentity, PipelineRunResult } from "./messages.js";

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
) => Promise<ExecutionResult>;

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
  const memoryScope = memoryScopeFromMeta(ir.metadata);

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
function memoryScopeFromMeta(meta: PipelineIR["metadata"]): MemoryScope {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    threadId: str(meta?.thread_id),
    resourceId: str(meta?.resource_id),
    projectId: str(meta?.project_id),
    mode: resolveMemoryMode(typeof meta?.memory_mode === "string" ? meta.memory_mode : null),
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
// decoded byte chunks (NOT line-aligned), so we buffer across chunks, split on
// blank-line SSE event boundaries, drop the `data: ` prefix, skip `[DONE]`, and
// JSON.parse each frame. A malformed frame is skipped (fail-open) rather than
// 5xx'ing the stream. The shape is fed verbatim into the Anthropic state machine.
async function* parseOpenAISSE(raw: AsyncIterable<string>): AsyncIterable<Record<string, unknown>> {
  let buffer = "";
  for await (const piece of raw) {
    buffer += piece;
    // SSE events are separated by a blank line.
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const chunk = parseFrame(event);
      if (chunk !== null) yield chunk;
      sep = buffer.indexOf("\n\n");
    }
  }
  // flush any trailing event without a terminating blank line.
  const tail = parseFrame(buffer);
  if (tail !== null) yield tail;
}

function parseFrame(event: string): Record<string, unknown> | null {
  for (const line of event.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return null; // malformed frame: skip (fail-open).
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
  memory?: { observe: ObserveDeps },
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

      // Memory observe (inbound): persist the request's raw messages BEFORE
      // routing (docs/08 Phase 1). observe is write-only — it never mutates the
      // messages nor changes routing, self-gates to a no-op on off/null-thread,
      // and never throws (fail-open inside core). The scope rides ir.metadata,
      // already stamped by the route from the request headers.
      const memoryScope = memoryScopeFromMeta(ir.metadata);
      if (memory !== undefined) {
        await observeInbound(memory.observe, memoryScope, internal.messages as IRMessage[]);
      }

      const caps = identity.caps as
        | { allowCustomModel?: unknown; maxLane?: unknown; allowedLanes?: unknown }
        | undefined;
      const allowCustomModel = caps?.allowCustomModel === true;
      // Display prefix only (never the plaintext key, principle 7) for the Debug
      // UI key column; null when this identity carries none.
      const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;
      // Per-key lane caps from the auth record (docs/04): the OUTER, non-negotiable
      // bound the core applies LAST (after policy caps). Thread it straight from
      // identity.caps so a key confined to e.g. maxLane:"economy" is honored on the
      // Anthropic/Responses surfaces too (not just /v1/chat). Each axis null =
      // unconstrained; an identity with no caps yields {null,null} (no-op).
      const keyCaps = {
        maxLane: typeof caps?.maxLane === "string" ? caps.maxLane : null,
        allowedLanes: Array.isArray(caps?.allowedLanes) ? (caps.allowedLanes as string[]) : null,
      };

      const result = await route(internal, { allowCustomModel, keyPrefix, keyCaps }, signal);

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
            await observeOutbound(memory.observe, memoryScope, outboundFromIR(irResponse));
          }
          return irResponse;
        },
        async *streamIR(): AsyncIterable<{ type: string; [k: string]: unknown }> {
          // Surface a routing failure BEFORE any event is emitted, so the route
          // can write a terminal error frame instead of an empty (silent) stream.
          if (failure !== null) throw failure;
          if (result.stream === null) return;
          // Accumulate the assistant text from the OpenAI-side chunks (one
          // accumulator serves BOTH protocols) WITHOUT buffering or altering the
          // events forwarded downstream (principle 8). observeOutbound runs in a
          // finally so a client disconnect mid-stream still records what arrived.
          const assistant = { text: "" };
          const chunks = parseOpenAISSE(result.stream);
          const source =
            memory === undefined
              ? chunks
              : (async function* () {
                  for await (const ch of chunks) {
                    accumulateAssistantText(assistant, ch);
                    yield ch;
                  }
                })();
          try {
            for await (const ev of convertOpenAIStreamToAnthropic(source as AsyncIterable<never>)) {
              yield ev as AnthropicSSEEvent & { type: string };
            }
          } finally {
            if (memory !== undefined && assistant.text.length > 0) {
              await observeOutbound(memory.observe, memoryScope, {
                responseMessages: [{ role: "assistant", content: assistant.text }],
                toolResults: [],
              });
            }
          }
        },
      };
    },
  };
}
