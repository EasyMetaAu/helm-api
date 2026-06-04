import { z } from "zod";
import {
  type IRContentPart,
  type IRMessage,
  type IRRequest,
  IRRequestSchema,
  type IRResponse,
  IRResponseSchema,
  type IRToolCall,
} from "./ir.js";
import { liftReasoningToFlat, resolveReasoning } from "./reasoning.js";
import type { NativeRequest, NativeResponse, Transformer } from "./transformer.js";

// OpenAI Responses transformer (docs/05, task protocol.responses). Responses is a
// THIRD client presentation surface, structurally distinct from Chat Completions:
// instead of `messages[]` (each row = role + content), the conversation is
// flattened into a top-level `input[]` ITEM stream. user/assistant text,
// `function_call`, `function_call_output`, and `reasoning` items all sit at the
// same level — they are NOT nested inside a message. This transformer:
//   • inbound  (transformRequestOut): folds the item stream back into the
//     OpenAI-Chat-shaped IR (message items -> messages[]; function_call ->
//     assistant.tool_calls[]; function_call_output -> role:"tool"; reasoning ->
//     IR thinking ext, with `status` STRIPPED; top-level instructions -> leading
//     system message).
//   • outbound (transformResponseOut): explodes the IR response back into the
//     `output[]` item stream (assistant text -> message item; tool_calls ->
//     function_call items; thinking -> reasoning item; finish_reason -> a legal
//     Responses `status` + raw value stashed in provider_raw).
//
// Correctness is aligned item-by-item with litellm's messages_to_responses_mapping.
// Known litellm pit reproduced here: `reasoning` items carry a `status` field that
// OpenAI REJECTS on input (`Unknown parameter: 'input[X].status'`), so it MUST be
// stripped on the inbound fold; the raw item (with status) is preserved in
// provider_raw for lossless reconstruction.
//
// Pure: zero network, zero framework (CLAUDE.md principle 1). Reimplemented from
// the docs, NOT copied from litellm/musistudio. fail-closed on a structurally
// invalid request (principle 2); fail-open on unknown item types (principle 3).

// —— Inbound Responses content parts (a message item's content[]). Responses uses
// `input_text` / `input_image` on the request side and `output_text` on the
// response side; both fold into the IR multipart shape. passthrough() keeps
// forward-compatible unknown fields alive. ————————————————————————————————————————
const ResponsesInputTextSchema = z
  .object({ type: z.literal("input_text"), text: z.string() })
  .passthrough();
const ResponsesOutputTextSchema = z
  .object({ type: z.literal("output_text"), text: z.string() })
  .passthrough();
const ResponsesInputImageSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().optional(),
    // some clients nest { url } — tolerate both
    detail: z.string().optional(),
  })
  .passthrough();
const ResponsesUnknownPartSchema = z.object({ type: z.string() }).passthrough();
const ResponsesContentPartSchema = z.union([
  ResponsesInputTextSchema,
  ResponsesOutputTextSchema,
  ResponsesInputImageSchema,
  ResponsesUnknownPartSchema,
]);

// —— Inbound Responses top-level items (the `input[]` stream). ————————————————————
const ResponsesMessageItemSchema = z
  .object({
    type: z.literal("message"),
    role: z.enum(["user", "assistant", "system", "developer"]),
    // content may be a plain string or a content-part array.
    content: z.union([z.string(), z.array(ResponsesContentPartSchema)]),
  })
  .passthrough();

const ResponsesFunctionCallItemSchema = z
  .object({
    type: z.literal("function_call"),
    // call_id is the cross-item correlation key (== tool_call.id). id is the item id.
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
  })
  .passthrough();

const ResponsesFunctionCallOutputItemSchema = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string().optional(),
    // output is a string OR a content-part array per the Responses spec.
    output: z.union([z.string(), z.array(ResponsesContentPartSchema)]).optional(),
  })
  .passthrough();

const ResponsesReasoningSummarySchema = z
  .object({ type: z.literal("summary_text"), text: z.string() })
  .passthrough();

const ResponsesReasoningItemSchema = z
  .object({
    type: z.literal("reasoning"),
    id: z.string().optional(),
    // `status` is the litellm pit: present on upstream items, REJECTED by OpenAI
    // on input. We accept it here so we can deliberately strip it on the fold.
    status: z.string().optional(),
    summary: z.array(ResponsesReasoningSummarySchema).optional(),
  })
  .passthrough();

// Unknown item types are tolerated (fail-open): a future Responses item type must
// not 5xx an otherwise-valid request — it is retained verbatim in provider_raw.
const ResponsesUnknownItemSchema = z.object({ type: z.string() }).passthrough();

const ResponsesInputItemSchema = z.union([
  ResponsesMessageItemSchema,
  ResponsesFunctionCallItemSchema,
  ResponsesFunctionCallOutputItemSchema,
  ResponsesReasoningItemSchema,
  ResponsesUnknownItemSchema,
]);

const ResponsesRequestSchema = z
  .object({
    model: z.string(),
    // Responses accepts a bare string OR the item stream.
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
    instructions: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    temperature: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    text: z.unknown().optional(), // Responses' structured-output config (response_format analogue)
    // —— litellm-parity sampling/control params. The IR-backed ones (top_p, the two
    // penalties, seed, n, parallel_tool_calls) map straight onto the IR. The
    // Responses-only knobs (store/previous_response_id/metadata/logit_bias) have no
    // IR home, so they ride in provider_raw losslessly (principle: never invent IR
    // fields; non-mappable upstream data goes to provider_raw). ————————————————————
    top_p: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    seed: z.number().int().optional(),
    n: z.number().int().positive().optional(),
    parallel_tool_calls: z.boolean().optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

// IR thinking extension shape (mirrors the anthropic transformer's local type).
type IRThinkingExt = { type: "thinking"; text: string; signature?: string };

// —— content-part folding: Responses parts -> IR parts. Unknown parts degrade to a
// JSON text placeholder so nothing is silently dropped (fail-open). ————————————————
function foldContentPart(part: z.infer<typeof ResponsesContentPartSchema>): IRContentPart {
  switch (part.type) {
    case "input_text":
    case "output_text":
      return { type: "text", text: (part as { text: string }).text };
    case "input_image": {
      const p = part as z.infer<typeof ResponsesInputImageSchema>;
      return { type: "image", url: p.image_url ?? "" };
    }
    default:
      return { type: "text", text: JSON.stringify(part) };
  }
}

function foldMessageContent(
  content: z.infer<typeof ResponsesMessageItemSchema>["content"],
): IRMessage["content"] {
  if (typeof content === "string") return content;
  return content.map(foldContentPart);
}

// —— Inbound: native Responses request -> IR. Folds the flat item stream into
// messages[]: text items stay messages; function_call lifts into assistant
// tool_calls; function_call_output becomes role:"tool"; reasoning collapses into
// the IR thinking ext (status stripped) with the raw item preserved. ——————————————
function toIRRequest(req: NativeRequest): IRRequest {
  // fail-closed: a structurally invalid request never enters the pipeline.
  const parsed = ResponsesRequestSchema.parse(req);

  const messages: IRMessage[] = [];
  const thinking: IRThinkingExt[] = [];
  const rawReasoning: unknown[] = [];
  const unknownItems: unknown[] = [];

  // instructions / a top-level system fold to the head of messages.
  if (parsed.instructions !== undefined) {
    messages.push({ role: "system", content: parsed.instructions });
  }

  // A bare string input is a single user turn.
  if (typeof parsed.input === "string") {
    messages.push({ role: "user", content: parsed.input });
  } else {
    for (const item of parsed.input) {
      switch (item.type) {
        case "message": {
          const m = item as z.infer<typeof ResponsesMessageItemSchema>;
          // `developer` is a first-class IR role (OpenAI's renamed system tier),
          // so it survives intact; `system`/`user`/`assistant` pass through too.
          messages.push({ role: m.role, content: foldMessageContent(m.content) });
          break;
        }
        case "function_call": {
          const fc = item as z.infer<typeof ResponsesFunctionCallItemSchema>;
          // call_id is the correlation key; fall back to the item id, then a
          // synthesized id so a tool call is NEVER silently dropped.
          const id = fc.call_id ?? fc.id ?? `call_${messages.length}_${fc.name}`;
          const call: IRToolCall = {
            id,
            type: "function",
            function: { name: fc.name, arguments: fc.arguments },
          };
          // Attach to a trailing assistant turn if it has no content, else open one.
          const prev = messages[messages.length - 1];
          if (prev?.role === "assistant" && prev.tool_calls !== undefined) {
            prev.tool_calls.push(call);
          } else {
            messages.push({ role: "assistant", content: null, tool_calls: [call] });
          }
          break;
        }
        case "function_call_output": {
          const fco = item as z.infer<typeof ResponsesFunctionCallOutputItemSchema>;
          const content: IRMessage["content"] =
            fco.output === undefined
              ? ""
              : typeof fco.output === "string"
                ? fco.output
                : fco.output.map(foldContentPart);
          messages.push({
            role: "tool",
            content,
            // call_id correlates back to the function_call; tolerate omission.
            ...(fco.call_id !== undefined ? { tool_call_id: fco.call_id } : {}),
          });
          break;
        }
        case "reasoning": {
          const r = item as z.infer<typeof ResponsesReasoningItemSchema>;
          // litellm pit: STRIP `status` — OpenAI rejects input[X].status. The IR
          // thinking ext carries only the summary text. The raw item (status and
          // all) is preserved in provider_raw for lossless reconstruction.
          const text = (r.summary ?? []).map((s) => s.text).join("\n");
          thinking.push({ type: "thinking", text });
          rawReasoning.push(r);
          break;
        }
        default:
          // Unknown item type: retain structurally in provider_raw (fail-open),
          // never throw away the whole request.
          unknownItems.push(item);
          break;
      }
    }
  }

  const providerRaw: Record<string, unknown> = {};
  if (rawReasoning.length > 0) providerRaw.reasoning = rawReasoning;
  if (unknownItems.length > 0) providerRaw.unknown_items = unknownItems;
  // Responses-only request knobs with no IR home are preserved verbatim.
  if (parsed.store !== undefined) providerRaw.store = parsed.store;
  if (parsed.previous_response_id !== undefined)
    providerRaw.previous_response_id = parsed.previous_response_id;
  if (parsed.metadata !== undefined) providerRaw.metadata = parsed.metadata;
  if (parsed.logit_bias !== undefined) providerRaw.logit_bias = parsed.logit_bias;

  const ir: IRRequest = {
    model: parsed.model,
    messages,
    ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
    ...(parsed.tool_choice !== undefined ? { tool_choice: parsed.tool_choice } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.max_output_tokens !== undefined ? { max_tokens: parsed.max_output_tokens } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    ...(parsed.text !== undefined ? { response_format: parsed.text } : {}),
    // IR-backed sampling/control params map straight through.
    ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
    ...(parsed.frequency_penalty !== undefined
      ? { frequency_penalty: parsed.frequency_penalty }
      : {}),
    ...(parsed.presence_penalty !== undefined ? { presence_penalty: parsed.presence_penalty } : {}),
    ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
    ...(parsed.n !== undefined ? { n: parsed.n } : {}),
    ...(parsed.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: parsed.parallel_tool_calls }
      : {}),
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(Object.keys(providerRaw).length > 0 ? { provider_raw: providerRaw } : {}),
  };

  // Final structural validation: the IR handed downstream is always well-formed.
  return IRRequestSchema.parse(ir);
}

// —— Outbound (request direction): IR -> native Responses request. MVP upstreams
// are mostly Chat-shaped, so this direction is rarely used; we explode the IR
// messages back into an input[] item stream so the transform stays symmetric and
// lossless rather than being a lossy clamp. ——————————————————————————————————————
function toResponsesRequest(ir: IRRequest): NativeRequest {
  const parsed = IRRequestSchema.parse(ir);
  const input: Array<Record<string, unknown>> = [];
  let instructions: string | undefined;

  for (const m of parsed.messages) {
    if (m.role === "system") {
      // The first system message folds to top-level instructions; any later one
      // stays an input message (developer-style) so nothing is lost.
      if (instructions === undefined && typeof m.content === "string") {
        instructions = m.content;
        continue;
      }
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        ...(m.tool_call_id !== undefined ? { call_id: m.tool_call_id } : {}),
        output: contentToText(m.content),
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls !== undefined && m.tool_calls.length > 0) {
      for (const c of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        });
      }
      // assistant may also carry text alongside tool_calls.
      const text = contentToText(m.content);
      if (text !== "") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }
    input.push({
      type: "message",
      role: m.role,
      content: [
        {
          type: m.role === "assistant" ? "output_text" : "input_text",
          text: contentToText(m.content),
        },
      ],
    });
  }

  const raw = parsed.provider_raw;
  return {
    model: parsed.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
    ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
    ...(parsed.tool_choice !== undefined ? { tool_choice: parsed.tool_choice } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.max_tokens !== undefined ? { max_output_tokens: parsed.max_tokens } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    // IR-backed sampling/control params explode back onto the native request.
    ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
    ...(parsed.frequency_penalty !== undefined
      ? { frequency_penalty: parsed.frequency_penalty }
      : {}),
    ...(parsed.presence_penalty !== undefined ? { presence_penalty: parsed.presence_penalty } : {}),
    ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
    ...(parsed.n !== undefined ? { n: parsed.n } : {}),
    ...(parsed.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: parsed.parallel_tool_calls }
      : {}),
    // Responses-only knobs come back out of provider_raw if they were stashed there.
    ...(raw?.store !== undefined ? { store: raw.store } : {}),
    ...(raw?.previous_response_id !== undefined
      ? { previous_response_id: raw.previous_response_id }
      : {}),
    ...(raw?.metadata !== undefined ? { metadata: raw.metadata } : {}),
    ...(raw?.logit_bias !== undefined ? { logit_bias: raw.logit_bias } : {}),
  };
}

function contentToText(content: IRMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<IRContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// —— finish_reason -> Responses status (research-notes pit #1). The legal terminal
// Responses statuses are `completed` and `incomplete`; an explicit length cap maps
// to `incomplete` (it hit max_output_tokens), everything else lands on `completed`.
// The RAW finish_reason always rides along in provider_raw.stop_reason. ————————————
const STATUS_MAP: Record<string, "completed" | "incomplete"> = {
  stop: "completed",
  tool_calls: "completed",
  function_call: "completed",
  stop_sequence: "completed",
  end_turn: "completed",
  length: "incomplete",
  max_tokens: "incomplete",
  content_filter: "incomplete",
};

export function mapResponsesStatus(finish: string | null): {
  status: "completed" | "incomplete";
  raw: string | null;
} {
  if (finish === null) return { status: "completed", raw: null };
  return { status: STATUS_MAP[finish] ?? "completed", raw: finish };
}

// —— Outbound (response direction): IR response -> native Responses response. The
// assistant turn explodes back into the output[] item stream. ————————————————————
function toResponsesResponse(res: IRResponse): NativeResponse {
  const parsed = IRResponseSchema.parse(res);
  const choice = parsed.choices[0];
  const message = choice?.message ?? { role: "assistant" as const, content: null };
  const { status, raw } = mapResponsesStatus(choice?.finish_reason ?? null);

  const output: Array<Record<string, unknown>> = [];
  const messageContent: Array<{ type: "output_text"; text: string }> = [];

  // Reasoning (content-block thinking parts OR the flat reasoning_content/
  // thinking_blocks carriers — e.g. an OpenAI-Chat/Anthropic/Gemini origin) renders
  // as Responses reasoning items, emitted FIRST (reasoning precedes the answer). (P6)
  const { thinkingParts } = resolveReasoning(message);
  for (const part of thinkingParts) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: part.text }] });
  }

  const { content } = message;
  if (typeof content === "string") {
    if (content !== "") messageContent.push({ type: "output_text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        messageContent.push({ type: "output_text", text: part.text });
      }
      // thinking parts already emitted via resolveReasoning above;
      // image parts are inbound-only on the response path.
    }
  }

  if (messageContent.length > 0) {
    output.push({ type: "message", role: "assistant", content: messageContent });
  }

  for (const call of message.tool_calls ?? []) {
    output.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  return {
    id: parsed.id,
    object: "response",
    model: parsed.model,
    status,
    output,
    ...(parsed.usage !== undefined
      ? {
          usage: {
            input_tokens: parsed.usage.prompt_tokens ?? 0,
            output_tokens: parsed.usage.completion_tokens ?? 0,
          },
        }
      : {}),
    provider_raw: {
      stop_reason: raw,
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    },
  };
}

// —— Inbound (response direction): native Responses response -> IR. Folds the
// output[] item stream into a single assistant choice. ————————————————————————————
const ResponsesUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        // Anthropic-via-Responses ephemeral cache write (litellm parity addendum).
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ResponsesResponseSchema = z
  .object({
    id: z.string(),
    object: z.string().optional(),
    model: z.string(),
    status: z.string().optional(),
    output: z.array(ResponsesInputItemSchema),
    usage: ResponsesUsageSchema.optional(),
    // Echo fields the Responses API returns on the response object. They have no IR
    // home, so they are surfaced via provider_raw (optional passthrough).
    reasoning: z.unknown().optional(),
    text: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

function toIRResponse(res: NativeResponse): IRResponse {
  const parsed = ResponsesResponseSchema.parse(res);

  const parts: IRContentPart[] = [];
  const toolCalls: IRToolCall[] = [];

  for (const item of parsed.output) {
    switch (item.type) {
      case "message": {
        const m = item as z.infer<typeof ResponsesMessageItemSchema>;
        const folded = foldMessageContent(m.content);
        if (typeof folded === "string") {
          if (folded !== "") parts.push({ type: "text", text: folded });
        } else if (folded !== null) {
          parts.push(...folded);
        }
        break;
      }
      case "function_call": {
        const fc = item as z.infer<typeof ResponsesFunctionCallItemSchema>;
        toolCalls.push({
          id: fc.call_id ?? fc.id ?? `call_${toolCalls.length}_${fc.name}`,
          type: "function",
          function: { name: fc.name, arguments: fc.arguments },
        });
        break;
      }
      case "reasoning": {
        const r = item as z.infer<typeof ResponsesReasoningItemSchema>;
        const text = (r.summary ?? []).map((s) => s.text).join("\n");
        parts.push({ type: "thinking", text });
        break;
      }
      default:
        // function_call_output / unknown items are not expected on a response;
        // ignore on the IR content path (fail-open).
        break;
    }
  }

  const cached = parsed.usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheCreation = parsed.usage?.input_tokens_details?.cache_creation_input_tokens;
  const reasoningTokens = parsed.usage?.output_tokens_details?.reasoning_tokens;
  const fullInput = parsed.usage?.input_tokens;

  // Lift reasoning items (folded into thinking content parts above) onto the flat
  // reasoning_content/thinking_blocks carriers for downstream OpenAI clients. (P6)
  const message: IRMessage = liftReasoningToFlat({
    role: "assistant",
    content: parts.length > 0 ? parts : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });

  const ir = {
    id: parsed.id,
    model: parsed.model,
    choices: [
      {
        index: 0,
        message,
        // Keep the native status as the IR finish_reason surrogate; the raw value
        // also rides in provider_raw.stop_reason.
        finish_reason: parsed.status ?? null,
      },
    ],
    ...(parsed.usage !== undefined
      ? {
          usage: {
            ...(fullInput !== undefined ? { prompt_tokens: fullInput - cached } : {}),
            ...(parsed.usage.output_tokens !== undefined
              ? { completion_tokens: parsed.usage.output_tokens }
              : {}),
            ...(cached > 0 ? { cached_tokens: cached } : {}),
            // output_tokens_details.reasoning_tokens -> IRUsage.reasoning_tokens;
            // input_tokens_details.cache_creation_input_tokens -> cache_creation_tokens.
            ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
            ...(cacheCreation !== undefined ? { cache_creation_tokens: cacheCreation } : {}),
          },
        }
      : {}),
    provider_raw: {
      stop_reason: parsed.status ?? null,
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      // Echo fields surfaced losslessly (reasoning config / structured-output / tool_choice).
      ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      ...(parsed.tool_choice !== undefined ? { tool_choice: parsed.tool_choice } : {}),
    },
  };

  return IRResponseSchema.parse(ir);
}

export const responsesTransformer: Transformer = {
  name: "openai-responses",
  endPoint: "/v1/responses",

  transformRequestOut(req) {
    return toIRRequest(req);
  },

  transformResponseOut(res) {
    return toResponsesResponse(res);
  },

  transformRequestIn(ir) {
    return toResponsesRequest(ir);
  },

  transformResponseIn(res) {
    return toIRResponse(res);
  },
};
