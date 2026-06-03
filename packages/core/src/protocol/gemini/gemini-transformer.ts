import type { IRContentPart, IRMessage, IRRequest, IRResponse, IRToolCall } from "../ir.js";
import { IRRequestSchema, IRResponseSchema } from "../ir.js";
import type { Transformer } from "../transformer.js";
import {
  type GeminiCandidate,
  type GeminiContent,
  type GeminiGenerateContentRequest,
  GeminiGenerateContentRequestSchema,
  type GeminiGenerateContentResponse,
  GeminiGenerateContentResponseSchema,
  type GeminiPart,
  type GeminiSSEEvent,
  GeminiSSEEventSchema,
  type GeminiUsageMetadata,
  type IRChunk,
} from "./gemini-types.js";
import { sanitizeSchema } from "./schema-sanitize.js";

// Gemini generateContent transformer (docs/05, task gemini.protocol). The FOURTH
// protocol: it makes Helm speak Gemini both as an inbound client surface and as an
// outbound provider, strictly via nativeIn -> IR -> nativeOut (never N×N direct).
// Gemini diverges from the OpenAI-shaped IR more than any other protocol, so this
// file is the highest-risk transformer (CLAUDE.md principle 8). The hard parts —
// each covered by a test:
//   • roles user|model (no system; system is a top-level systemInstruction);
//   • tool calls have NO stable id — functionCall/functionResponse pair by NAME, so
//     we SYNTHESIZE deterministic ids (call_<name>_<n>) and drop them outbound;
//   • streaming (?alt=sse) is delta-based both ways: outbound emits INCREMENTAL deltas
//     (clients accumulate `chunk.text`); inbound diffs provider frames into the IR
//     start->delta->stop sequence, tolerating either delta or snapshot framing;
//   • JSON-Schema `format` (date/date-time) is unsupported -> sanitizeSchema strips it;
//   • finishReason / usageMetadata are remapped, raw preserved in provider_raw.
//
// Pure, framework-agnostic (principle 1): no Hono, no network. Reimplemented from
// the public Gemini docs, NOT copied from a vendor SDK. No `any`.

// —— Routing contract (the gateway turns these into real routes; core stays
// framework-agnostic, principle 1). The Transformer.endPoint is a single base
// string; the operation suffix (:generateContent / :streamGenerateContent) and the
// {model} path param are parsed by `parseGeminiPath`. ——————————————————————————————

/** Base endpoint this transformer owns (registry primary key for mounting). */
export const GEMINI_ENDPOINT = "/v1beta/models" as const;

/** Gemini auth header — NOT `Authorization: Bearer`. Declared for the Auth Resolver. */
export const GEMINI_API_KEY_HEADER = "x-goog-api-key" as const;

export interface GeminiRoute {
  /** model parsed out of the `{model}` path segment, fed into IR.model. */
  model: string;
  /** true for :streamGenerateContent with ?alt=sse. */
  stream: boolean;
}

/**
 * Parse a Gemini `/v1beta/models/{model}:{op}` path. Returns the model and whether
 * it is a streaming call (`:streamGenerateContent` + `alt=sse`), or null if the path
 * is not a Gemini generateContent endpoint. Pure string parsing — the gateway maps
 * its framework request onto this (core never reads a framework object).
 */
export function parseGeminiPath(pathname: string, query: string): GeminiRoute | null {
  const m = /^\/v1beta\/models\/([^:/?]+):(generateContent|streamGenerateContent)$/.exec(pathname);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const model = decodeURIComponent(m[1]);
  const op = m[2];
  const params = new URLSearchParams(query);
  const stream = op === "streamGenerateContent" && params.get("alt") === "sse";
  return { model, stream };
}

// —— finishReason mapping (docs/05 pit #1). Gemini -> legal IR/OpenAI finish_reason;
// the RAW value is always preserved in provider_raw.stop_reason by the caller. ——————
const GEMINI_TO_IR_FINISH: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "stop",
  OTHER: "stop",
};

function mapFinishReasonToIR(reason: string | undefined): string | null {
  if (reason === undefined || reason === "") return null;
  return GEMINI_TO_IR_FINISH[reason] ?? "stop";
}

// —— IR/OpenAI finish_reason -> legal Gemini finishReason (outbound). ————————————————
const IR_TO_GEMINI_FINISH: Record<string, string> = {
  stop: "STOP",
  length: "MAX_TOKENS",
  content_filter: "SAFETY",
  tool_calls: "STOP",
};

function mapFinishReasonToGemini(reason: string | null): string | undefined {
  if (reason === null || reason === "") return undefined;
  return IR_TO_GEMINI_FINISH[reason] ?? "STOP";
}

// —— Synthesize a deterministic tool-call id. Gemini functionCall has no id; we make
// one from name + per-turn occurrence index so the matching functionResponse (which
// only carries `name`) can be paired back. ————————————————————————————————————————
function synthToolCallId(name: string, occurrence: number): string {
  return `call_${name}_${occurrence}`;
}

// —— inlineData{mimeType,data} -> IR image part (data-url, base64 passthrough). ————
function inlineDataToImagePart(data: { mimeType: string; data: string }): IRContentPart {
  return {
    type: "image",
    url: `data:${data.mimeType};base64,${data.data}`,
    mediaType: data.mimeType,
  };
}

// —— Inbound: Gemini generateContent request -> IR. ————————————————————————————————

function transformRequestOut(native: unknown): IRRequest {
  // fail-closed: a structurally invalid request never enters the pipeline.
  const req = GeminiGenerateContentRequestSchema.parse(native);

  const messages: IRMessage[] = [];

  // systemInstruction.parts[].text -> a single leading role:"system" message.
  if (req.systemInstruction !== undefined) {
    const text = req.systemInstruction.parts
      .map((p) => p.text ?? "")
      .filter((t) => t !== "")
      .join("\n");
    if (text !== "") messages.push({ role: "system", content: text });
  }

  for (const content of req.contents) {
    // Per-turn occurrence counter so same-name functionCall/Response pair correctly.
    const callIdsByName = new Map<string, string[]>();
    const responseSeenByName = new Map<string, number>();
    const role = content.role === "model" ? "assistant" : "user";

    const textImageParts: IRContentPart[] = [];
    const toolCalls: IRToolCall[] = [];
    const toolResultMessages: IRMessage[] = [];

    for (const part of content.parts) {
      if (part.text !== undefined) {
        textImageParts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.inlineData !== undefined) {
        textImageParts.push(inlineDataToImagePart(part.inlineData));
        continue;
      }
      if (part.functionCall !== undefined) {
        const name = part.functionCall.name;
        const ids = callIdsByName.get(name) ?? [];
        const id = synthToolCallId(name, ids.length);
        ids.push(id);
        callIdsByName.set(name, ids);
        toolCalls.push({
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
        continue;
      }
      if (part.functionResponse !== undefined) {
        const name = part.functionResponse.name;
        // Pair by name + occurrence order within this same turn's calls would not
        // span turns; the call ids were assigned in the assistant turn, so re-derive
        // the deterministic id from name + the response's own occurrence index.
        const seen = responseSeenByName.get(name) ?? 0;
        responseSeenByName.set(name, seen + 1);
        toolResultMessages.push({
          role: "tool",
          content:
            typeof part.functionResponse.response === "string"
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response ?? {}),
          tool_call_id: synthToolCallId(name, seen),
        });
        continue;
      }
      // Unknown part shape: degrade to a JSON text placeholder (fail-open).
      textImageParts.push({ type: "text", text: JSON.stringify(part) });
    }

    if (role === "assistant") {
      messages.push({
        role: "assistant",
        content: textImageParts.length > 0 ? textImageParts : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      if (textImageParts.length > 0) messages.push({ role: "user", content: textImageParts });
      for (const tr of toolResultMessages) messages.push(tr);
    }
  }

  const tools = req.tools?.flatMap((t) =>
    (t.functionDeclarations ?? []).map((d) => ({
      type: "function" as const,
      function: {
        name: d.name,
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.parameters !== undefined ? { parameters: d.parameters } : {}),
      },
    })),
  );

  const gc = req.generationConfig;
  const responseFormat =
    gc?.responseMimeType === "application/json"
      ? gc.responseSchema !== undefined
        ? { type: "json_schema", json_schema: gc.responseSchema }
        : { type: "json_object" }
      : undefined;

  const ir: IRRequest = {
    model: "gemini", // path-derived model is supplied by the route layer; default here.
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(gc?.temperature !== undefined ? { temperature: gc.temperature } : {}),
    ...(gc?.maxOutputTokens !== undefined ? { max_tokens: gc.maxOutputTokens } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(geminiToolConfigToToolChoice(req.toolConfig) !== undefined
      ? { tool_choice: geminiToolConfigToToolChoice(req.toolConfig) }
      : {}),
  };

  return IRRequestSchema.parse(ir);
}

// —— Outbound: IR request -> native Gemini request. Drops synthesized tool ids;
// sanitizes functionDeclarations parameters (format pit). ——————————————————————————

function irToolToFunctionDeclaration(tool: unknown) {
  // IR tools are OpenAI-shaped: { type:"function", function:{ name, description?, parameters? } }
  const t = tool as {
    function?: { name?: string; description?: string; parameters?: unknown };
  };
  const fn = t.function ?? {};
  return {
    name: fn.name ?? "",
    ...(fn.description !== undefined ? { description: fn.description } : {}),
    ...(fn.parameters !== undefined ? { parameters: sanitizeSchema(fn.parameters) } : {}),
  };
}

function irMessageContentToText(content: IRMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// —— System/developer fold (docs/05). Protocols without a `developer` role —
// Gemini here, and an Anthropic outbound request transform were one ever added —
// fold both `system` and `developer` turns into a single top-level system
// instruction. The text is accumulated IN MESSAGE ORDER (not overwritten) and
// joined by a blank line, so a [system, developer] pair keeps the author's
// intended precedence. This is explicit + tested, NOT a silent drop.
//
// Anthropic parity (issue #59): anthropicTransformer.transformRequestIn now folds
// `system` + `developer` into the top-level `system` param under exactly this
// policy (systemFromMessages in protocol/anthropic/request.ts). See
// implementation-notes.md (2026-06-02).
export function collectSystemText(messages: readonly IRMessage[]): string {
  const segments: string[] = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = irMessageContentToText(message.content);
    if (text !== "") segments.push(text);
  }
  return segments.join("\n\n");
}

function irMessageToParts(message: IRMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];
  const { content } = message;
  if (typeof content === "string") {
    if (content !== "") parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") parts.push({ text: part.text });
      else if (part.type === "image") {
        // data-url -> inlineData{mimeType,data}; remote urls degrade to text.
        const match = /^data:([^;]+);base64,(.*)$/.exec(part.url);
        if (match !== null && match[1] !== undefined && match[2] !== undefined) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        } else {
          parts.push({ text: `[remote image unsupported by Gemini nativeOut: ${part.url}]` });
        }
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    // DROP the synthesized id; Gemini accepts only name + args.
    parts.push({
      functionCall: { name: call.function.name, args: parseArgs(call.function.arguments) },
    });
  }
  return parts;
}

function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function geminiToolConfigToToolChoice(toolConfig: unknown): unknown {
  if (typeof toolConfig !== "object" || toolConfig === null) return undefined;
  const config = (toolConfig as { functionCallingConfig?: unknown }).functionCallingConfig;
  if (typeof config !== "object" || config === null) return undefined;
  const fcc = config as { mode?: unknown; allowedFunctionNames?: unknown };
  if (fcc.mode === "NONE") return "none";
  if (fcc.mode === "AUTO") return "auto";
  if (fcc.mode === "ANY") {
    const names = Array.isArray(fcc.allowedFunctionNames)
      ? fcc.allowedFunctionNames.filter((name): name is string => typeof name === "string")
      : [];
    if (names.length === 1) return { type: "function", function: { name: names[0] } };
    return "required";
  }
  return undefined;
}

function irToolChoiceToGeminiToolConfig(toolChoice: unknown): unknown {
  if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const choice = toolChoice as { type?: unknown; function?: { name?: unknown } };
    const name = choice.function?.name;
    if (choice.type === "function" && typeof name === "string" && name !== "") {
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
    }
  }
  return undefined;
}

function responseFormatToGenerationConfig(
  responseFormat: unknown,
): Record<string, unknown> | undefined {
  if (typeof responseFormat !== "object" || responseFormat === null) return undefined;
  const rf = responseFormat as { type?: unknown; json_schema?: unknown };
  if (rf.type === "json_object") return { responseMimeType: "application/json" };
  if (rf.type !== "json_schema") return undefined;

  const rawSchema = rf.json_schema;
  const schema =
    typeof rawSchema === "object" && rawSchema !== null && "schema" in rawSchema
      ? (rawSchema as { schema?: unknown }).schema
      : rawSchema;
  return {
    responseMimeType: "application/json",
    ...(schema !== undefined ? { responseSchema: sanitizeSchema(schema) } : {}),
  };
}

function mergeGenerationConfig(
  ...configs: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign(
    {},
    ...configs.filter((c): c is Record<string, unknown> => c !== undefined),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function transformRequestIn(ir: IRRequest): GeminiGenerateContentRequest {
  const parsed = IRRequestSchema.parse(ir);

  const contents: GeminiContent[] = [];
  // Gemini has no `developer` role: both `system` and `developer` turns fold into
  // a single systemInstruction, accumulated in message order (collectSystemText).
  const systemText = collectSystemText(parsed.messages);
  const systemInstruction: GeminiContent | undefined =
    systemText !== "" ? { parts: [{ text: systemText }] } : undefined;
  const toolNameById = new Map<string, string>();

  for (const message of parsed.messages) {
    for (const call of message.tool_calls ?? []) {
      toolNameById.set(call.id, call.function.name);
    }
    // system/developer were folded into systemInstruction above; never leak into contents.
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      // role:"tool" -> a user turn carrying functionResponse (Gemini convention).
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name:
                message.name ??
                (message.tool_call_id !== undefined
                  ? toolNameById.get(message.tool_call_id)
                  : undefined) ??
                "tool",
              response: { content: irMessageContentToText(message.content) },
            },
          },
        ],
      });
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: irMessageToParts(message) });
  }

  const tools =
    parsed.tools !== undefined && parsed.tools.length > 0
      ? [{ functionDeclarations: parsed.tools.map(irToolToFunctionDeclaration) }]
      : undefined;

  const generationConfig = mergeGenerationConfig(
    parsed.temperature !== undefined || parsed.max_tokens !== undefined
      ? {
          ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
          ...(parsed.max_tokens !== undefined ? { maxOutputTokens: parsed.max_tokens } : {}),
        }
      : undefined,
    responseFormatToGenerationConfig(parsed.response_format),
  );
  const toolConfig = irToolChoiceToGeminiToolConfig(parsed.tool_choice);

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(generationConfig !== undefined ? { generationConfig } : {}),
  };
}

// —— Outbound: IR response -> native Gemini response. ——————————————————————————————

function irUsageToMetadata(usage: IRResponse["usage"]): GeminiUsageMetadata | undefined {
  if (usage === undefined) return undefined;
  const prompt = (usage.prompt_tokens ?? 0) + (usage.cached_tokens ?? 0);
  const candidates = usage.completion_tokens ?? 0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: prompt + candidates,
    ...(usage.cached_tokens !== undefined ? { cachedContentTokenCount: usage.cached_tokens } : {}),
  };
}

function transformResponseOut(ir: IRResponse): GeminiGenerateContentResponse {
  const parsed = IRResponseSchema.parse(ir);
  const choice = parsed.choices[0];
  const message = choice?.message ?? { role: "assistant" as const, content: null };

  const candidate: GeminiCandidate = {
    content: { role: "model", parts: irMessageToParts(message as IRMessage) },
    ...(choice?.finish_reason != null
      ? { finishReason: mapFinishReasonToGemini(choice.finish_reason) ?? "STOP" }
      : {}),
    index: 0,
  };

  const out: GeminiGenerateContentResponse = {
    candidates: [candidate],
    ...(parsed.usage !== undefined ? { usageMetadata: irUsageToMetadata(parsed.usage) } : {}),
  };
  return GeminiGenerateContentResponseSchema.parse(out);
}

// —— Inbound: native Gemini response -> IR. ————————————————————————————————————————

function geminiCandidateToMessage(candidate: GeminiCandidate): IRMessage {
  const parts: IRContentPart[] = [];
  const toolCalls: IRToolCall[] = [];
  const callIdsByName = new Map<string, number>();

  for (const part of candidate.content.parts) {
    if (part.text !== undefined) parts.push({ type: "text", text: part.text });
    else if (part.inlineData !== undefined) parts.push(inlineDataToImagePart(part.inlineData));
    else if (part.functionCall !== undefined) {
      const name = part.functionCall.name;
      const n = callIdsByName.get(name) ?? 0;
      callIdsByName.set(name, n + 1);
      toolCalls.push({
        id: synthToolCallId(name, n),
        type: "function",
        function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
  }

  return {
    role: "assistant",
    content: parts.length > 0 ? parts : toolCalls.length > 0 ? null : "",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function transformResponseIn(native: unknown): IRResponse {
  const res = GeminiGenerateContentResponseSchema.parse(native);
  const candidate = res.candidates?.[0];
  const message: IRMessage =
    candidate !== undefined
      ? geminiCandidateToMessage(candidate)
      : { role: "assistant", content: "" };

  const um = res.usageMetadata;
  const usage =
    um !== undefined
      ? {
          ...(um.promptTokenCount !== undefined
            ? {
                prompt_tokens: Math.max(0, um.promptTokenCount - (um.cachedContentTokenCount ?? 0)),
              }
            : {}),
          ...(um.candidatesTokenCount !== undefined
            ? { completion_tokens: um.candidatesTokenCount }
            : {}),
          ...(um.cachedContentTokenCount !== undefined
            ? { cached_tokens: um.cachedContentTokenCount }
            : {}),
        }
      : undefined;

  const ir: IRResponse = {
    id: `gemini_${Date.now()}`,
    model: res.modelVersion ?? "gemini",
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReasonToIR(candidate?.finishReason),
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
    provider_raw: {
      ...(candidate?.finishReason !== undefined ? { stop_reason: candidate.finishReason } : {}),
      ...(um !== undefined ? { usage: um } : {}),
    },
  };
  return IRResponseSchema.parse(ir);
}

// —— Streaming inbound: Gemini ?alt=sse snapshot events -> IR chunks. ——————————————
// Each event is a COMPLETE response snapshot. We diff successive snapshots into the
// IR start->delta->stop sequence: the first chunk announces role:"assistant"; text
// is emitted as the DELTA between snapshots; functionCall args are accumulated and
// re-emitted as the full current JSON (the IR string), tolerating fragmentation;
// the terminal chunk carries the mapped finish_reason exactly once.

interface StreamToolSlot {
  index: number;
  name: string;
  fullArgs: string; // latest complete args JSON from the most recent snapshot
}

async function* transformStreamIn(src: AsyncIterable<GeminiSSEEvent>): AsyncIterable<IRChunk> {
  let started = false;
  let emittedText = "";
  let lastModel: string | undefined;
  let pendingFinish: string | null = null;
  let lastUsage: IRChunk["usage"];
  // Tool args are NOT append-only across Gemini snapshots: each snapshot carries the
  // CURRENT complete `args` object (which JSON.stringify may re-serialize wholesale,
  // not as a strict prefix extension). So we BUFFER the latest full args per tool and
  // flush a single complete `arguments` string at stream end — tolerating arbitrary
  // fragmentation without ever emitting a half-parsed JSON delta (docs/05 pit:
  // "tolerate partial JSON; accumulate to complete before parse").
  const toolNameToSlot = new Map<string, StreamToolSlot>();

  for await (const raw of src) {
    const event = GeminiSSEEventSchema.parse(raw);
    const candidate = event.candidates?.[0];
    if (event.modelVersion !== undefined) lastModel = event.modelVersion;

    const roleField = !started ? { role: "assistant" } : {};
    started = true;

    // —— text delta: diff the accumulated snapshot text (append-only by nature). ——
    const snapshotText = candidate?.content.parts.map((p) => p.text ?? "").join("") ?? "";
    let textDelta = "";
    if (snapshotText.startsWith(emittedText)) textDelta = snapshotText.slice(emittedText.length);
    else textDelta = snapshotText; // non-prefix snapshot (rare): emit the whole text
    if (snapshotText.length >= emittedText.length) emittedText = snapshotText;

    // —— tool-call args: buffer the latest full args per name (no mid-stream emit). ——
    for (const part of candidate?.content.parts ?? []) {
      if (part.functionCall === undefined) continue;
      const name = part.functionCall.name;
      let slot = toolNameToSlot.get(name);
      if (slot === undefined) {
        slot = { index: toolNameToSlot.size, name, fullArgs: "" };
        toolNameToSlot.set(name, slot);
      }
      slot.fullArgs = JSON.stringify(part.functionCall.args ?? {});
    }

    const finish = mapFinishReasonToIR(candidate?.finishReason);
    if (finish !== null) pendingFinish = finish;
    if (event.usageMetadata !== undefined) {
      const um = event.usageMetadata;
      // promptTokenCount is the FULL prompt incl. cached; subtract cached so the IR
      // prompt is the non-cached input and never double-billed (matches the non-stream
      // transformResponseIn path). cached is re-exposed when present.
      lastUsage = {
        ...(um.promptTokenCount !== undefined
          ? { prompt_tokens: Math.max(0, um.promptTokenCount - (um.cachedContentTokenCount ?? 0)) }
          : {}),
        ...(um.candidatesTokenCount !== undefined
          ? { completion_tokens: um.candidatesTokenCount }
          : {}),
        ...(um.cachedContentTokenCount !== undefined
          ? { cached_tokens: um.cachedContentTokenCount }
          : {}),
      };
    }

    // Emit a delta chunk for streamed text and/or the first-chunk role announcement;
    // tool args are flushed at stream end. Skip a silent empty mid-stream snapshot.
    const isFirst = Object.keys(roleField).length > 0;
    if (textDelta !== "" || isFirst) {
      const delta: NonNullable<IRChunk["choices"]>[number]["delta"] = {
        ...roleField,
        ...(textDelta !== "" ? { content: textDelta } : {}),
      };
      yield {
        ...(lastModel !== undefined ? { model: lastModel } : {}),
        choices: [{ index: 0, delta }],
      };
    }
  }

  // —— Stream end: flush complete tool-call args (each a fully-parseable JSON), then
  // the terminal finish_reason exactly once (idempotent close, docs/05 pit #4). ——
  for (const slot of toolNameToSlot.values()) {
    yield {
      ...(lastModel !== undefined ? { model: lastModel } : {}),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: slot.index,
                id: synthToolCallId(slot.name, slot.index),
                type: "function",
                function: { name: slot.name, arguments: slot.fullArgs },
              },
            ],
          },
        },
      ],
    };
  }

  // Terminal finish chunk, emitted exactly once after the tool flush (idempotent
  // close, docs/05 pit #4). No guard flag is needed — this runs once post-loop.
  yield {
    ...(lastModel !== undefined ? { model: lastModel } : {}),
    choices: [{ index: 0, delta: {}, finish_reason: pendingFinish ?? "stop" }],
    ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
  };
}

// —— Streaming outbound: IR chunks -> Gemini SSE delta events. ————————————————————————
// Real Gemini `streamGenerateContent?alt=sse` emits INCREMENTAL deltas — each event
// carries only the NEW text in candidates[0].content.parts, and clients accumulate
// (`text += chunk.text`). So we forward each IR text delta verbatim (NEVER a growing
// snapshot — that would double-count on the client). Tool-call fragments are buffered
// and flushed as ONE complete functionCall part on the terminal frame, which also
// carries `finishReason` + `usageMetadata`. CRUCIAL: the OpenAI source (with
// `stream_options.include_usage`, always set by execute.ts) delivers usage on a
// SEPARATE trailing chunk AFTER the finish chunk — so we hold the terminal frame until
// the stream ends and merge that late usage in, emitting exactly ONE terminal frame
// (never a `STOP` frame followed by a stray empty `usageMetadata` frame).

interface OutToolSlot {
  index: number;
  name: string;
  argBuffer: string; // accumulated argument fragments across chunks
}

async function* transformStreamOut(src: AsyncIterable<IRChunk>): AsyncIterable<GeminiSSEEvent> {
  // Tool-call fragments arrive split across chunks (id/name early, arguments later);
  // buffer per IR tool index — mirroring the inbound side — and emit each as a single
  // complete functionCall part once the stream finishes (never a half-parsed snapshot).
  const toolIndexToSlot = new Map<number, OutToolSlot>();

  // Build the completed functionCall parts in allocation order (skip un-named slots).
  const flushToolParts = (): GeminiPart[] => {
    const parts: GeminiPart[] = [];
    for (const slot of [...toolIndexToSlot.values()].sort((a, b) => a.index - b.index)) {
      if (slot.name === "") continue;
      parts.push({ functionCall: { name: slot.name, args: parseArgs(slot.argBuffer) } });
    }
    return parts;
  };

  const toUsageMetadata = (usage: NonNullable<IRChunk["usage"]>): GeminiUsageMetadata => ({
    ...(usage.prompt_tokens !== undefined ? { promptTokenCount: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined
      ? { candidatesTokenCount: usage.completion_tokens }
      : {}),
  });

  // The terminal frame (text delta + functionCall parts + finishReason) is held back
  // until stream end so a late usage-only chunk merges into it as ONE frame.
  let terminalParts: GeminiPart[] | null = null;
  let terminalFinish: string | undefined;
  let latestUsage: GeminiUsageMetadata | undefined;

  for await (const chunk of src) {
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;

    for (const tc of choice?.delta?.tool_calls ?? []) {
      let slot = toolIndexToSlot.get(tc.index);
      if (slot === undefined) {
        slot = { index: tc.index, name: tc.function?.name ?? "", argBuffer: "" };
        toolIndexToSlot.set(tc.index, slot);
      } else if (tc.function?.name !== undefined && tc.function.name !== "") {
        slot.name = tc.function.name; // backfill a late-arriving name
      }
      if (tc.function?.arguments !== undefined) slot.argBuffer += tc.function.arguments;
    }

    if (chunk.usage != null) latestUsage = toUsageMetadata(chunk.usage);

    if (choice?.finish_reason != null) {
      // Terminal chunk: assemble the final frame but hold it (usage may still trail).
      terminalParts = [];
      if (typeof content === "string" && content !== "") terminalParts.push({ text: content });
      terminalParts.push(...flushToolParts());
      terminalFinish = mapFinishReasonToGemini(choice.finish_reason) ?? "STOP";
      continue;
    }

    // Non-terminal: forward only a real text delta. Role-only announcements, tool-arg
    // fragments, and usage-only chunks carry no Gemini frame (Gemini has no empty/role
    // frame; their payload surfaces on the terminal frame instead).
    if (typeof content === "string" && content !== "") {
      yield { candidates: [{ content: { role: "model", parts: [{ text: content }] }, index: 0 }] };
    }
  }

  if (terminalParts !== null) {
    yield {
      candidates: [
        {
          content: { role: "model", parts: terminalParts },
          finishReason: terminalFinish,
          index: 0,
        },
      ],
      ...(latestUsage !== undefined ? { usageMetadata: latestUsage } : {}),
    };
    return;
  }

  // Defensive: the IR stream ended WITHOUT a finish chunk (e.g. an abort). Still
  // surface any buffered tool calls + usage once so the client loses nothing.
  const parts = flushToolParts();
  if (parts.length > 0 || latestUsage !== undefined) {
    yield {
      candidates: [{ content: { role: "model", parts }, index: 0 }],
      ...(latestUsage !== undefined ? { usageMetadata: latestUsage } : {}),
    };
  }
}

// —— The transformer object the registry indexes (5 methods + name + endPoint). The
// streaming + path-routing helpers are exported separately above. ————————————————

export const geminiTransformer: Transformer & {
  transformStreamIn: (src: AsyncIterable<GeminiSSEEvent>) => AsyncIterable<IRChunk>;
  transformStreamOut: (src: AsyncIterable<IRChunk>) => AsyncIterable<GeminiSSEEvent>;
} = {
  name: "gemini",
  endPoint: GEMINI_ENDPOINT,
  transformRequestOut,
  transformResponseOut,
  transformRequestIn,
  transformResponseIn,
  transformStreamIn,
  transformStreamOut,
};
