import { z } from "zod";
import {
  type IRContentPart,
  type IRMessage,
  IRReasoningEffortSchema,
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
// Responses file input: a PDF/document via uploaded handle (file_id), inline base64
// (file_data data-url) or a remote url (file_url). Mirrors the outbound input_file the
// IR-document renderer emits, so a documents round-trip is lossless (Codex P2).
const ResponsesInputFileSchema = z
  .object({
    type: z.literal("input_file"),
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    file_url: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();
// Responses audio input: mirrors OpenAI Chat's input_audio.{data,format} so audio is
// folded into an IR audio part instead of degrading to a JSON text placeholder. (RESP-01)
const ResponsesInputAudioSchema = z
  .object({
    type: z.literal("input_audio"),
    input_audio: z
      .object({ data: z.string().optional(), format: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const ResponsesUnknownPartSchema = z.object({ type: z.string() }).passthrough();
const ResponsesContentPartSchema = z.union([
  ResponsesInputTextSchema,
  ResponsesOutputTextSchema,
  ResponsesInputImageSchema,
  ResponsesInputFileSchema,
  ResponsesInputAudioSchema,
  ResponsesUnknownPartSchema,
]);

// —— Inbound Responses top-level items (the `input[]` stream). ————————————————————
const ResponsesMessageItemSchema = z
  .object({
    // `type` is OPTIONAL per the Responses spec: the official openai SDK (and
    // pi-ai) omit it on input messages, sending bare { role, content }. Default
    // it to "message" so a typeless item folds here instead of 400ing on the
    // union. The required `role` (which non-message items lack) keeps this from
    // absorbing function_call/reasoning items in the non-discriminated union.
    type: z.literal("message").optional().default("message"),
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
    // Reasoning config: effort maps onto the cross-protocol IR.reasoning_effort; the
    // full object (incl summary) rides provider_raw for lossless reconstruction.
    reasoning: z
      .object({
        // Tolerant (litellm parity): a real client (Codex) sends newer tiers like
        // `xhigh`; the shared IR schema accepts any string and clamps unknowns to
        // `high` rather than 400ing. Known tiers (incl. xhigh/max/none) survive.
        effort: IRReasoningEffortSchema.optional(),
        summary: z.union([z.boolean(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
    // Context-window truncation control — no IR home, rides provider_raw.
    truncation: z.enum(["auto", "disabled"]).optional(),
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
    user: z.string().optional(),
    service_tier: z.string().optional(),
    prompt_cache_key: z.string().optional(),
    prompt_cache_retention: z.string().optional(),
    web_search_options: z.unknown().optional(),
    context_management: z.unknown().optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

// IR thinking extension shape (mirrors the anthropic transformer's local type).
type IRThinkingExt = { type: "thinking"; text: string; signature?: string };

// —— Structured-output canonicalization (order 1, the keystone). Responses nests the
// schema under `text.format.{type,name,schema,strict}`, but the IR is OpenAI-Chat-
// shaped and the Anthropic/Gemini renderers read `response_format.{type, json_schema}`.
// Without this fold a Responses structured-output request is silently dropped when
// routed to a non-Responses backend. We canonicalize inbound and reverse outbound;
// the RAW Responses `text` is also stashed in provider_raw.text for a lossless
// responses->responses self round-trip. ————————————————————————————————————————————
function responsesTextToResponseFormat(text: unknown): unknown {
  if (typeof text !== "object" || text === null) return undefined;
  const format = (text as { format?: unknown }).format;
  if (typeof format !== "object" || format === null) return undefined;
  const f = format as Record<string, unknown>;
  if (f.type === "json_schema") {
    const json_schema: Record<string, unknown> = {};
    if (typeof f.name === "string") json_schema.name = f.name;
    if (f.schema !== undefined) json_schema.schema = f.schema;
    if (f.strict !== undefined) json_schema.strict = f.strict;
    return { type: "json_schema", json_schema };
  }
  if (f.type === "json_object") return { type: "json_object" };
  // `text` (plain) or an unknown format => no structured-output request.
  return undefined;
}

function responseFormatToResponsesText(rf: unknown): unknown {
  if (typeof rf !== "object" || rf === null) return undefined;
  const f = rf as Record<string, unknown>;
  if (f.type === "json_schema") {
    const js = (
      typeof f.json_schema === "object" && f.json_schema !== null ? f.json_schema : {}
    ) as Record<string, unknown>;
    const format: Record<string, unknown> = { type: "json_schema" };
    if (typeof js.name === "string") format.name = js.name;
    if (js.schema !== undefined) format.schema = js.schema;
    if (js.strict !== undefined) format.strict = js.strict;
    return { format };
  }
  if (f.type === "json_object") return { format: { type: "json_object" } };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Responses function tools are flat (`{type:"function", name, parameters}`), while
// Chat Completions upstreams require `{type:"function", function:{...}}`.
function responsesToolToChatTool(tool: unknown): unknown {
  if (!isRecord(tool) || tool.type !== "function" || isRecord(tool.function)) return tool;
  if (typeof tool.name !== "string") return tool;

  const fn: Record<string, unknown> = { name: tool.name };
  if (typeof tool.description === "string") fn.description = tool.description;
  if (tool.parameters !== undefined) fn.parameters = tool.parameters;
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: "function", function: fn };
}

function chatToolToResponsesTool(tool: unknown): unknown {
  if (!isRecord(tool) || tool.type !== "function") return tool;
  if (typeof tool.name === "string" && !isRecord(tool.function)) return tool;
  if (!isRecord(tool.function) || typeof tool.function.name !== "string") return tool;

  const fn = tool.function;
  const out: Record<string, unknown> = { type: "function", name: fn.name };
  if (typeof fn.description === "string") out.description = fn.description;
  if (fn.parameters !== undefined) out.parameters = fn.parameters;
  if (fn.strict !== undefined) out.strict = fn.strict;
  return out;
}

function responsesToolChoiceToChat(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") return toolChoice;
  if (typeof toolChoice.name !== "string" || isRecord(toolChoice.function)) return toolChoice;
  return { type: "function", function: { name: toolChoice.name } };
}

function chatToolChoiceToResponses(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") return toolChoice;
  if (typeof toolChoice.name === "string" && !isRecord(toolChoice.function)) return toolChoice;
  if (!isRecord(toolChoice.function) || typeof toolChoice.function.name !== "string") {
    return toolChoice;
  }
  return { type: "function", name: toolChoice.function.name };
}

function rejectUnsupportedPreviousResponseContinuation(
  parsed: z.infer<typeof ResponsesRequestSchema>,
): void {
  if (parsed.previous_response_id === undefined || typeof parsed.input === "string") return;

  const localFunctionCalls = new Set<string>();
  for (const item of parsed.input) {
    if (item.type === "function_call") {
      const call = item as z.infer<typeof ResponsesFunctionCallItemSchema>;
      const id = call.call_id ?? call.id;
      if (id !== undefined) localFunctionCalls.add(id);
      continue;
    }
    if (item.type !== "function_call_output") continue;

    const output = item as z.infer<typeof ResponsesFunctionCallOutputItemSchema>;
    if (output.call_id === undefined || !localFunctionCalls.has(output.call_id)) {
      throw new Error(
        "previous_response_id continuation is not supported without local function_call history",
      );
    }
  }
}

function normalizeResponsesTools(tools: unknown[] | undefined): {
  tools?: unknown[];
  rawTools?: unknown[];
} {
  if (tools === undefined) return {};
  const normalized = tools.map(responsesToolToChatTool);
  const changed = normalized.some((tool, index) => tool !== tools[index]);
  return { tools: normalized, ...(changed ? { rawTools: tools } : {}) };
}

// —— content-part folding: Responses parts -> IR parts. Unknown parts degrade to a
// JSON text placeholder so nothing is silently dropped (fail-open). ————————————————
function foldContentPart(part: z.infer<typeof ResponsesContentPartSchema>): IRContentPart {
  switch (part.type) {
    case "input_text":
    case "output_text":
      return { type: "text", text: (part as { text: string }).text };
    case "input_image": {
      const p = part as z.infer<typeof ResponsesInputImageSchema>;
      return {
        type: "image",
        url: p.image_url ?? "",
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      };
    }
    case "input_audio": {
      const p = part as z.infer<typeof ResponsesInputAudioSchema>;
      const ia = p.input_audio ?? {};
      return {
        type: "audio",
        data: typeof ia.data === "string" ? ia.data : "",
        format: typeof ia.format === "string" ? ia.format : "wav",
      };
    }
    case "input_file": {
      const p = part as z.infer<typeof ResponsesInputFileSchema>;
      const name = p.filename !== undefined ? { filename: p.filename } : {};
      if (p.file_id !== undefined) return { type: "document", fileId: p.file_id, ...name };
      // file_data is a base64 data-url (data:<mime>;base64,<data>) when present.
      const m = p.file_data !== undefined ? /^data:([^;]+);base64,(.*)$/.exec(p.file_data) : null;
      if (m?.[1] !== undefined && m[2] !== undefined) {
        return { type: "document", data: m[2], mediaType: m[1], ...name };
      }
      return { type: "document", url: p.file_url ?? p.file_data ?? "", ...name };
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
  rejectUnsupportedPreviousResponseContinuation(parsed);
  const normalizedTools = normalizeResponsesTools(parsed.tools);

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
  if (parsed.context_management !== undefined)
    providerRaw.context_management = parsed.context_management;
  if (normalizedTools.rawTools !== undefined)
    providerRaw.responses_tools = normalizedTools.rawTools;
  // Reasoning config + truncation have no IR field of their own; preserve verbatim.
  // NB: a distinct key — provider_raw.reasoning already holds inbound reasoning ITEMS.
  if (parsed.reasoning !== undefined) providerRaw.reasoning_config = parsed.reasoning;
  if (parsed.truncation !== undefined) providerRaw.truncation = parsed.truncation;
  // Preserve the raw Responses `text` so a responses->responses round-trip is lossless
  // even after we canonicalize it into IR.response_format for other backends.
  if (parsed.text !== undefined) providerRaw.text = parsed.text;

  const responseFormat = responsesTextToResponseFormat(parsed.text);

  const ir: IRRequest = {
    model: parsed.model,
    messages,
    ...(normalizedTools.tools !== undefined ? { tools: normalizedTools.tools } : {}),
    ...(parsed.tool_choice !== undefined
      ? { tool_choice: responsesToolChoiceToChat(parsed.tool_choice) }
      : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.max_output_tokens !== undefined ? { max_tokens: parsed.max_output_tokens } : {}),
    ...(parsed.stream !== undefined ? { stream: parsed.stream } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
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
    ...(parsed.user !== undefined ? { user: parsed.user } : {}),
    ...(parsed.service_tier !== undefined ? { service_tier: parsed.service_tier } : {}),
    ...(parsed.prompt_cache_key !== undefined ? { prompt_cache_key: parsed.prompt_cache_key } : {}),
    ...(parsed.prompt_cache_retention !== undefined
      ? { prompt_cache_retention: parsed.prompt_cache_retention }
      : {}),
    ...(parsed.web_search_options !== undefined
      ? { web_search_options: parsed.web_search_options }
      : {}),
    ...(parsed.reasoning?.effort !== undefined
      ? { reasoning_effort: parsed.reasoning.effort }
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

  const rawReasoning = parsed.provider_raw?.reasoning;
  if (Array.isArray(rawReasoning)) {
    for (const item of rawReasoning) {
      if (!isRecord(item) || item.type !== "reasoning") continue;
      const { status: _status, ...sanitized } = item;
      input.push(sanitized);
    }
  }

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
        output: contentToFunctionCallOutput(m.content),
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
      content: contentToResponsesParts(m.content, m.role === "assistant"),
    });
  }

  const raw = parsed.provider_raw;
  // Structured output: prefer the lossless raw Responses `text` (responses origin);
  // else synthesize it from the canonical IR.response_format (chat/anthropic/gemini
  // origin) so structured output is honored on the Responses wire either way.
  const text =
    raw?.text !== undefined ? raw.text : responseFormatToResponsesText(parsed.response_format);
  return {
    model: parsed.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
    ...(text !== undefined ? { text } : {}),
    ...(Array.isArray(raw?.responses_tools)
      ? { tools: raw.responses_tools }
      : parsed.tools !== undefined
        ? { tools: parsed.tools.map(chatToolToResponsesTool) }
        : {}),
    ...(parsed.tool_choice !== undefined
      ? { tool_choice: chatToolChoiceToResponses(parsed.tool_choice) }
      : {}),
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
    ...(parsed.user !== undefined ? { user: parsed.user } : {}),
    ...(parsed.service_tier !== undefined ? { service_tier: parsed.service_tier } : {}),
    ...(parsed.prompt_cache_key !== undefined ? { prompt_cache_key: parsed.prompt_cache_key } : {}),
    ...(parsed.prompt_cache_retention !== undefined
      ? { prompt_cache_retention: parsed.prompt_cache_retention }
      : {}),
    ...(parsed.web_search_options !== undefined
      ? { web_search_options: parsed.web_search_options }
      : {}),
    // Responses-only knobs come back out of provider_raw if they were stashed there.
    ...(raw?.store !== undefined ? { store: raw.store } : {}),
    ...(raw?.previous_response_id !== undefined
      ? { previous_response_id: raw.previous_response_id }
      : {}),
    ...(raw?.metadata !== undefined ? { metadata: raw.metadata } : {}),
    ...(raw?.logit_bias !== undefined ? { logit_bias: raw.logit_bias } : {}),
    ...(raw?.context_management !== undefined
      ? { context_management: raw.context_management }
      : {}),
    // Reasoning config: prefer the preserved native object, else synthesize from the
    // cross-protocol IR.reasoning_effort so o-series reasoning survives chat->responses.
    ...(raw?.reasoning_config !== undefined
      ? { reasoning: raw.reasoning_config }
      : parsed.reasoning_effort !== undefined
        ? { reasoning: { effort: parsed.reasoning_effort } }
        : {}),
    ...(raw?.truncation !== undefined ? { truncation: raw.truncation } : {}),
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

function contentToFunctionCallOutput(
  content: IRMessage["content"],
): string | Array<Record<string, unknown>> {
  if (content === null || typeof content === "string") return contentToText(content);
  return contentToResponsesParts(content, true);
}

// IR content -> Responses content parts, PRESERVING multimodality (order 25): text ->
// input_text/output_text, image -> input_image, audio -> input_audio, document ->
// input_file. Collapsing to a single text part dropped media silently. video/thinking
// have no Responses input surface and are omitted (text already carries the prompt;
// response-side thinking renders as reasoning items elsewhere).
function contentToResponsesParts(
  content: IRMessage["content"],
  isAssistant: boolean,
): Array<Record<string, unknown>> {
  const textType = isAssistant ? "output_text" : "input_text";
  if (content === null) return [{ type: textType, text: "" }];
  if (typeof content === "string") return [{ type: textType, text: content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const p of content) {
    if (p.type === "text") parts.push({ type: textType, text: p.text });
    else if (p.type === "image") {
      parts.push({
        type: "input_image",
        image_url: p.url,
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      });
    } else if (p.type === "audio") {
      parts.push({
        type: "input_audio",
        input_audio: { data: p.data, format: p.format },
      });
    } else if (p.type === "document") {
      const name = p.filename !== undefined ? { filename: p.filename } : {};
      if (p.fileId !== undefined) parts.push({ type: "input_file", file_id: p.fileId, ...name });
      else if (p.data !== undefined)
        parts.push({
          type: "input_file",
          ...name,
          file_data: `data:${p.mediaType ?? "application/octet-stream"};base64,${p.data}`,
        });
      else if (p.url !== undefined) parts.push({ type: "input_file", file_url: p.url, ...name });
    }
  }
  return parts.length > 0 ? parts : [{ type: textType, text: "" }];
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
  const messageContent: Array<Record<string, unknown>> = [];

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

  // order 20/23: citations/grounding (message.annotations) and per-choice logprobs ride
  // the output_text content part (litellm's shape), so a Responses client that reads
  // annotations/logprobs off the part still sees them. Attach to the first text part.
  const firstText = messageContent.find((p) => p.type === "output_text");
  if (firstText !== undefined) {
    if (message.annotations !== undefined && message.annotations.length > 0) {
      firstText.annotations = message.annotations;
    }
    if (choice?.logprobs != null) firstText.logprobs = choice.logprobs;
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

  // order 21: reconstruct the FULL input (cached + non-cached) and lift the per-modality
  // / reasoning detail so o-series billing survives. Responses reports cache writes under
  // input_tokens_details.cache_creation_input_tokens and reasoning under output_tokens_details.
  let usage: Record<string, unknown> | undefined;
  if (parsed.usage !== undefined) {
    const u = parsed.usage;
    const cached = u.cached_tokens ?? 0;
    const cacheCreation = u.cache_creation_tokens ?? 0;
    const inputDetails: Record<string, number> = {};
    if (cached > 0) inputDetails.cached_tokens = cached;
    if (cacheCreation > 0) inputDetails.cache_creation_input_tokens = cacheCreation;
    const outputDetails: Record<string, number> = {};
    if (u.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = u.reasoning_tokens;
    const inputTokens = (u.prompt_tokens ?? 0) + cached + cacheCreation;
    const outputTokens = u.completion_tokens ?? 0;
    usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      // total_tokens is part of OpenAI's Responses usage shape — Codex's deserializer
      // rejects a completed response without it ("missing field total_tokens").
      total_tokens: inputTokens + outputTokens,
      ...(Object.keys(inputDetails).length > 0 ? { input_tokens_details: inputDetails } : {}),
      ...(Object.keys(outputDetails).length > 0 ? { output_tokens_details: outputDetails } : {}),
    };
  }

  // order 19: an incomplete terminal status must name WHY (content_filter / max_tokens).
  const incompleteReason =
    status === "incomplete"
      ? ((
          {
            content_filter: "content_filter",
            length: "max_tokens",
            max_tokens: "max_tokens",
          } as Record<string, string>
        )[raw ?? ""] ?? "server_error")
      : undefined;

  return {
    id: parsed.id,
    object: "response",
    model: parsed.model,
    status,
    ...(incompleteReason !== undefined ? { incomplete_details: { reason: incompleteReason } } : {}),
    output,
    ...(usage !== undefined ? { usage } : {}),
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
    total_tokens: z.number().int().nonnegative().optional(),
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
    // Why the response is incomplete (max_output_tokens / content_filter); drives a
    // real IR finish_reason so downstream protocols don't see "incomplete" -> stop.
    incomplete_details: z.object({ reason: z.string().optional() }).passthrough().optional(),
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
  // order 20/23: collect annotations + logprobs riding the output_text parts so they
  // fold back onto the IR message/choice (otherwise citations/grounding are stripped).
  const annotations: unknown[] = [];
  let foldedLogprobs: unknown;

  for (const item of parsed.output) {
    switch (item.type) {
      case "message": {
        const m = item as z.infer<typeof ResponsesMessageItemSchema>;
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            const p = part as { type?: unknown; annotations?: unknown; logprobs?: unknown };
            if (p.type === "output_text" && Array.isArray(p.annotations))
              annotations.push(...p.annotations);
            if (
              p.type === "output_text" &&
              p.logprobs !== undefined &&
              foldedLogprobs === undefined
            )
              foldedLogprobs = p.logprobs;
          }
        }
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
  const cacheCreation = parsed.usage?.input_tokens_details?.cache_creation_input_tokens ?? 0;
  const reasoningTokens = parsed.usage?.output_tokens_details?.reasoning_tokens;
  const fullInput = parsed.usage?.input_tokens;

  // Lift reasoning items (folded into thinking content parts above) onto the flat
  // reasoning_content/thinking_blocks carriers for downstream OpenAI clients. (P6)
  const message: IRMessage = liftReasoningToFlat({
    role: "assistant",
    content: parts.length > 0 ? parts : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(annotations.length > 0 ? { annotations: annotations as IRMessage["annotations"] } : {}),
  });

  // Map status + incomplete_details.reason -> a REAL IR finish_reason (not the raw
  // "incomplete" string, which collapses to stop downstream and hides truncation).
  const incompleteReasonIn = parsed.incomplete_details?.reason;
  const finishReason =
    parsed.status === "incomplete"
      ? incompleteReasonIn === "content_filter"
        ? "content_filter"
        : "length" // max_output_tokens / unspecified truncation
      : parsed.status === "completed"
        ? "stop"
        : (parsed.status ?? null);

  const ir = {
    id: parsed.id,
    model: parsed.model,
    choices: [
      {
        index: 0,
        message,
        // Real finish_reason (above); the raw status still rides provider_raw.stop_reason.
        finish_reason: finishReason,
        // order 23: logprobs that rode the output_text part fold back onto the choice.
        ...(foldedLogprobs !== undefined ? { logprobs: foldedLogprobs } : {}),
      },
    ],
    ...(parsed.usage !== undefined
      ? {
          usage: {
            ...(fullInput !== undefined
              ? { prompt_tokens: Math.max(0, fullInput - cached - cacheCreation) }
              : {}),
            ...(parsed.usage.output_tokens !== undefined
              ? { completion_tokens: parsed.usage.output_tokens }
              : {}),
            ...(cached > 0 ? { cached_tokens: cached } : {}),
            // output_tokens_details.reasoning_tokens -> IRUsage.reasoning_tokens;
            // input_tokens_details.cache_creation_input_tokens -> cache_creation_tokens.
            ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
            ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
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
