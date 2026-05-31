import {
  type AnthropicSSEEvent,
  convertOpenAIStreamToAnthropic,
  type ExecutionResult,
  type IRResponse,
  type RouteOptions,
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
  const messages =
    Array.isArray(ir.messages) && ir.messages.length > 0
      ? (ir.messages as InternalRequest["messages"])
      : [{ role: "user", content: "" }];
  const model = typeof ir.model === "string" && ir.model.length > 0 ? ir.model : "auto";
  const accountId = typeof identity.accountId === "string" ? identity.accountId : "";
  const keyId = typeof identity.keyId === "string" ? identity.keyId : "";
  // conversation_id (session-momentum key) is stamped onto the IR metadata bag by
  // the route from the `x-session-key` header (or carried by the inbound IR).
  const conversationId =
    typeof ir.metadata?.conversation_id === "string" && ir.metadata.conversation_id.length > 0
      ? ir.metadata.conversation_id
      : null;

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
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  };
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
): {
  run(ir: PipelineIR, identity: MessagesIdentity, signal: AbortSignal): Promise<PipelineRunResult>;
} {
  return {
    async run(ir, identity, signal) {
      const meta = ir.metadata;
      const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : "anthropic-req";
      const internal = toInternalRequest(ir, identity, traceId, protocol);
      const caps = identity.caps as { allowCustomModel?: unknown } | undefined;
      const allowCustomModel = caps?.allowCustomModel === true;
      // Display prefix only (never the plaintext key, principle 7) for the Debug
      // UI key column; null when this identity carries none.
      const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;

      const result = await route(internal, { allowCustomModel, keyPrefix }, signal);

      return {
        async collect(): Promise<unknown> {
          // The route surfaces the OpenAI body; project it into the IR the
          // outbound Anthropic transformer expects.
          return openAIBodyToIR(result.body);
        },
        async *streamIR(): AsyncIterable<{ type: string; [k: string]: unknown }> {
          if (result.stream === null) return;
          const chunks = parseOpenAISSE(result.stream);
          for await (const ev of convertOpenAIStreamToAnthropic(chunks as AsyncIterable<never>)) {
            yield ev as AnthropicSSEEvent & { type: string };
          }
        },
      };
    },
  };
}
