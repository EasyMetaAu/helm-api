import type {
  IRContentPart,
  IRMessage,
  IRReasoningEffort,
  IRRequest,
  IRResponse,
  IRToolCall,
} from "../ir.js";
import { IRRequestSchema, IRResponseSchema } from "../ir.js";
import { liftReasoningToFlat, resolveReasoning } from "../reasoning.js";
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
  /** true for :streamGenerateContent; alt=sse is not required for compatibility. */
  stream: boolean;
}

/**
 * Parse a Gemini `/v1beta/models/{model}:{op}` or `/models/{model}:{op}` path.
 * Returns the model and whether it is a streaming call, or null if the path is not
 * a Gemini generateContent endpoint. Pure string parsing — the gateway maps its
 * framework request onto this (core never reads a framework object).
 */
export function parseGeminiPath(pathname: string, query: string): GeminiRoute | null {
  const m = /^\/(?:v1beta\/models|models)\/(.+):(generateContent|streamGenerateContent)$/.exec(
    pathname,
  );
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const model = decodeURIComponent(m[1]);
  const op = m[2];
  // LiteLLM's Gemini stream route forces stream=true from the operation name. The
  // `alt=sse` query affects the Google wire format, but silently downgrading a
  // `streamGenerateContent` request to non-stream corrupts client expectations.
  void query;
  const stream = op === "streamGenerateContent";
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
  // litellm parity additions: image-safety / language flags -> content_filter; the
  // "should-have-stopped" diagnostics (too many tool calls, malformed/unspecified) map
  // to plain stop. Raw value is always preserved in provider_raw.stop_reason.
  LANGUAGE: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  MALFORMED_FUNCTION_CALL: "stop",
  TOO_MANY_TOOL_CALLS: "stop",
  MALFORMED_RESPONSE: "stop",
  FINISH_REASON_UNSPECIFIED: "stop",
  OTHER: "stop",
  // Gemini rarely emits this, but when it does it means the turn ended on a tool call.
  TOOL_CALLS: "tool_calls",
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

// —— modalities <-> responseModalities (litellm map_response_modalities). IR uses
// lowercase OpenAI tokens; Gemini wants uppercase enum constants. ————————————————————
const IR_TO_GEMINI_MODALITY: Record<string, string> = {
  text: "TEXT",
  image: "IMAGE",
  audio: "AUDIO",
  video: "VIDEO",
};
const GEMINI_TO_IR_MODALITY: Record<string, "text" | "image" | "audio" | "video"> = {
  TEXT: "text",
  IMAGE: "image",
  AUDIO: "audio",
  VIDEO: "video",
};

// —— reasoning_effort -> Gemini thinkingConfig (litellm _map_reasoning_effort_to_
// thinking_budget). We emit a thinkingBudget + includeThoughts. The exact litellm
// budget constants are model-family specific; we use representative monotonically
// increasing defaults (minimal < low < medium < high) so the level is honored and
// budgets order correctly. The raw effort survives in provider_raw at the request
// layer if needed; here we only need a valid, ordered thinkingConfig.
// Keyed over the FULL IR effort union (exhaustive) so it never indexes to an
// undefined budget when a newer tier (xhigh/max) or `none` reaches Gemini. Budgets
// are representative + monotonically increasing; xhigh/max sit at Gemini's ceiling.
const REASONING_EFFORT_BUDGET: Record<IRReasoningEffort, number> = {
  none: 0,
  minimal: 128,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 32768,
};

function reasoningEffortToThinkingConfig(
  effort: IRReasoningEffort | undefined,
): { thinkingBudget: number; includeThoughts: boolean } | undefined {
  if (effort === undefined) return undefined;
  const thinkingBudget = REASONING_EFFORT_BUDGET[effort];
  // `none` => budget 0 disables Gemini thinking (and no thought summaries).
  return { thinkingBudget, includeThoughts: thinkingBudget > 0 };
}

function thinkingConfigToReasoningEffort(
  thinkingConfig: { thinkingBudget?: number } | undefined,
): "minimal" | "low" | "medium" | "high" | undefined {
  const budget = thinkingConfig?.thinkingBudget;
  if (budget === undefined) return undefined;
  // Reverse the budget bands back to the nearest effort level.
  if (budget <= REASONING_EFFORT_BUDGET.minimal) return "minimal";
  if (budget <= REASONING_EFFORT_BUDGET.low) return "low";
  if (budget <= REASONING_EFFORT_BUDGET.medium) return "medium";
  return "high";
}

function nonNegativeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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

// —— inlineData routed by MIME to the correct IR INPUT part (P7 multimodal):
//   image/*  -> image (data-url, as before)
//   audio/*  -> audio {data, format}        (format = subtype, e.g. wav)
//   video/*  -> video {data, mediaType}
//   else     -> document {data, mediaType}  (application/pdf, text/plain, …)
function inlineDataToIRPart(data: { mimeType: string; data: string }): IRContentPart {
  const mime = data.mimeType;
  if (mime.startsWith("image/")) return inlineDataToImagePart(data);
  if (mime.startsWith("audio/")) {
    return { type: "audio", data: data.data, format: mime.slice("audio/".length) || mime };
  }
  if (mime.startsWith("video/")) {
    return { type: "video", data: data.data, mediaType: mime };
  }
  return { type: "document", data: data.data, mediaType: mime };
}

// —— fileData{mimeType,fileUri} (+ optional videoMetadata) -> IR part routed by MIME.
// A remote/uploaded blob reference rides on the part's `url` (gs:// or Files API uri).
function fileDataToIRPart(
  fileData: { mimeType?: string; fileUri: string },
  videoMetadata?: { fps?: number; startOffset?: string; endOffset?: string },
): IRContentPart {
  const mime = fileData.mimeType ?? "";
  const uri = fileData.fileUri;
  if (mime.startsWith("image/")) {
    return { type: "image", url: uri, mediaType: mime };
  }
  if (mime.startsWith("audio/")) {
    // IR audio is inline-base64-only; a remote audio uri has no inline data, so we keep
    // the subtype as format and leave data empty (the uri survives in provider_raw-free
    // form only via document fallback otherwise). Prefer document for losslessness.
    return { type: "document", url: uri, mediaType: mime };
  }
  if (mime.startsWith("video/") || videoMetadata !== undefined) {
    return {
      type: "video",
      url: uri,
      ...(mime !== "" ? { mediaType: mime } : {}),
      ...(videoMetadata?.fps !== undefined ? { fps: videoMetadata.fps } : {}),
      ...(videoMetadata?.startOffset !== undefined
        ? { startOffset: videoMetadata.startOffset }
        : {}),
      ...(videoMetadata?.endOffset !== undefined ? { endOffset: videoMetadata.endOffset } : {}),
    };
  }
  return { type: "document", url: uri, ...(mime !== "" ? { mediaType: mime } : {}) };
}

// —— Per-modality token detail: Gemini's [{modality,tokenCount}] -> IR token-details
// object ({text_tokens, image_tokens, audio_tokens, video_tokens}). ——————————————————
function modalityDetailsToIR(
  details: Array<{ modality?: string; tokenCount?: number }> | undefined,
): Record<string, number> | undefined {
  if (details === undefined || details.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const d of details) {
    if (d.tokenCount === undefined) continue;
    const modality = (d.modality ?? "").toUpperCase();
    const key =
      modality === "TEXT"
        ? "text_tokens"
        : modality === "IMAGE"
          ? "image_tokens"
          : modality === "AUDIO"
            ? "audio_tokens"
            : modality === "VIDEO"
              ? "video_tokens"
              : // order 31: never drop a future/unknown modality — keep its count under a
                // derived `<modality>_tokens` key (IRTokenDetailsSchema is .passthrough()).
                modality !== ""
                ? `${modality.toLowerCase()}_tokens`
                : undefined;
    if (key === undefined) continue;
    out[key] = (out[key] ?? 0) + d.tokenCount;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// —— groundingMetadata/citationMetadata -> IR annotations (url_citation). Gemini puts
// the cited sources in groundingChunks[].web.{uri,title} and the cited text spans in
// groundingSupports[].segment.{startIndex,endIndex}; citationMetadata.citationSources[]
// carries {uri,startIndex,endIndex,title}. We flatten all into the unified annotation
// shape so any downstream protocol (OpenAI url_citation) renders them. ————————————————
function groundingToAnnotations(
  groundingMetadata: unknown,
  citationMetadata: unknown,
): IRMessage["annotations"] {
  const annotations: NonNullable<IRMessage["annotations"]> = [];

  if (typeof groundingMetadata === "object" && groundingMetadata !== null) {
    const gm = groundingMetadata as {
      groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
      groundingSupports?: Array<{
        segment?: { startIndex?: unknown; endIndex?: unknown; text?: unknown };
      }>;
    };
    for (const chunk of gm.groundingChunks ?? []) {
      const uri = chunk.web?.uri;
      if (typeof uri !== "string") continue;
      annotations.push({
        type: "url_citation",
        url: uri,
        ...(typeof chunk.web?.title === "string" ? { title: chunk.web.title } : {}),
      });
    }
    for (const support of gm.groundingSupports ?? []) {
      const seg = support.segment;
      if (seg === undefined) continue;
      const start = typeof seg.startIndex === "number" ? seg.startIndex : undefined;
      const end = typeof seg.endIndex === "number" ? seg.endIndex : undefined;
      if (start === undefined && end === undefined) continue;
      annotations.push({
        type: "url_citation",
        ...(start !== undefined ? { start_index: start } : {}),
        ...(end !== undefined ? { end_index: end } : {}),
        ...(typeof seg.text === "string" ? { text: seg.text } : {}),
      });
    }
  }

  if (typeof citationMetadata === "object" && citationMetadata !== null) {
    const cm = citationMetadata as {
      citationSources?: Array<{
        uri?: unknown;
        title?: unknown;
        startIndex?: unknown;
        endIndex?: unknown;
      }>;
    };
    for (const src of cm.citationSources ?? []) {
      const uri = typeof src.uri === "string" ? src.uri : undefined;
      const start = typeof src.startIndex === "number" ? src.startIndex : undefined;
      const end = typeof src.endIndex === "number" ? src.endIndex : undefined;
      if (uri === undefined && start === undefined && end === undefined) continue;
      annotations.push({
        type: "url_citation",
        ...(uri !== undefined ? { url: uri } : {}),
        ...(typeof src.title === "string" ? { title: src.title } : {}),
        ...(start !== undefined ? { start_index: start } : {}),
        ...(end !== undefined ? { end_index: end } : {}),
      });
    }
  }

  return annotations.length > 0 ? annotations : undefined;
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
        textImageParts.push(inlineDataToIRPart(part.inlineData));
        continue;
      }
      if (part.fileData !== undefined) {
        textImageParts.push(fileDataToIRPart(part.fileData, part.videoMetadata));
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
        const response = part.functionResponse.response;
        // Pair by name + occurrence order within this same turn's calls would not
        // span turns; the call ids were assigned in the assistant turn, so re-derive
        // the deterministic id from name + the response's own occurrence index.
        const seen = responseSeenByName.get(name) ?? 0;
        responseSeenByName.set(name, seen + 1);
        toolResultMessages.push({
          role: "tool",
          content: typeof response === "string" ? response : JSON.stringify(response ?? {}),
          tool_call_id: synthToolCallId(name, seen),
          provider_raw: { gemini_function_response: response ?? {} },
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

  // —— Gemini generationConfig -> flat IR sampling/control knobs (reverse of the
  // IR -> Gemini map above). stopSequences -> stop (array kept as-is); candidateCount
  // -> n; responseLogprobs/logprobs -> logprobs/top_logprobs; responseModalities ->
  // lowercase modalities; thinkingConfig -> reasoning_effort.
  const modalities = gc?.responseModalities
    ?.map((m) => GEMINI_TO_IR_MODALITY[m])
    .filter((m): m is "text" | "image" | "audio" | "video" => m !== undefined);
  const reasoningEffort = thinkingConfigToReasoningEffort(gc?.thinkingConfig);

  const ir: IRRequest = {
    model: "gemini", // path-derived model is supplied by the route layer; default here.
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(gc?.temperature !== undefined ? { temperature: gc.temperature } : {}),
    ...(gc?.maxOutputTokens !== undefined ? { max_tokens: gc.maxOutputTokens } : {}),
    ...(gc?.topP !== undefined ? { top_p: gc.topP } : {}),
    ...(gc?.topK !== undefined ? { top_k: gc.topK } : {}),
    ...(gc?.frequencyPenalty !== undefined ? { frequency_penalty: gc.frequencyPenalty } : {}),
    ...(gc?.presencePenalty !== undefined ? { presence_penalty: gc.presencePenalty } : {}),
    ...(gc?.seed !== undefined ? { seed: gc.seed } : {}),
    ...(gc?.stopSequences !== undefined ? { stop: gc.stopSequences } : {}),
    ...(gc?.candidateCount !== undefined ? { n: gc.candidateCount } : {}),
    ...(gc?.responseLogprobs !== undefined ? { logprobs: gc.responseLogprobs } : {}),
    ...(gc?.logprobs !== undefined ? { top_logprobs: gc.logprobs } : {}),
    ...(modalities !== undefined && modalities.length > 0 ? { modalities } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(req.cachedContent !== undefined ? { cached_content: req.cachedContent } : {}),
    ...(geminiToolConfigToToolChoice(req.toolConfig) !== undefined
      ? { tool_choice: geminiToolConfigToToolChoice(req.toolConfig) }
      : {}),
    ...(req.safetySettings !== undefined
      ? { provider_raw: { safety_settings: req.safetySettings } }
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
  // Reasoning (from content-block thinking parts OR the flat reasoning_content/
  // thinking_blocks carriers — e.g. an OpenAI-origin response) renders as Gemini
  // thought parts, emitted FIRST so reasoning precedes the answer. (P6)
  const { thinkingParts } = resolveReasoning(message);
  for (const part of thinkingParts) {
    parts.push({
      text: part.text,
      thought: true,
      ...(part.signature !== undefined ? { thoughtSignature: part.signature } : {}),
    });
  }
  if (typeof content === "string") {
    if (content !== "") parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") parts.push({ text: part.text });
      // thinking parts already emitted via resolveReasoning above.
      else if (part.type === "image") {
        // data-url -> inlineData{mimeType,data}; a remote http(s) image url degrades to
        // an explicit text placeholder (no fetch/proxy — issue #49 non-goal). (Remote
        // gs:// / Files-API references for video/document use fileData below; an
        // arbitrary web image is NOT a Gemini-accessible fileData uri.)
        const match = /^data:([^;]+);base64,(.*)$/.exec(part.url);
        if (match !== null && match[1] !== undefined && match[2] !== undefined) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        } else {
          parts.push({ text: `[remote image unsupported by Gemini nativeOut: ${part.url}]` });
        }
      } else if (part.type === "audio") {
        // IR audio is inline base64 + a format subtype -> inlineData audio/<format>.
        parts.push({ inlineData: { mimeType: `audio/${part.format}`, data: part.data } });
      } else if (part.type === "document") {
        // Inline base64 -> inlineData; a remote uri -> fileData.
        if (part.data !== undefined) {
          parts.push({
            inlineData: {
              mimeType: part.mediaType ?? "application/octet-stream",
              data: part.data,
            },
          });
        } else if (part.url !== undefined) {
          parts.push({
            fileData: {
              fileUri: part.url,
              ...(part.mediaType !== undefined ? { mimeType: part.mediaType } : {}),
            },
          });
        }
      } else if (part.type === "video") {
        // Remote uri -> fileData (+ videoMetadata); inline base64 -> inlineData.
        const videoMetadata =
          part.fps !== undefined || part.startOffset !== undefined || part.endOffset !== undefined
            ? {
                ...(part.fps !== undefined ? { fps: part.fps } : {}),
                ...(part.startOffset !== undefined ? { startOffset: part.startOffset } : {}),
                ...(part.endOffset !== undefined ? { endOffset: part.endOffset } : {}),
              }
            : undefined;
        if (part.url !== undefined) {
          parts.push({
            fileData: {
              fileUri: part.url,
              ...(part.mediaType !== undefined ? { mimeType: part.mediaType } : {}),
            },
            ...(videoMetadata !== undefined ? { videoMetadata } : {}),
          });
        } else if (part.data !== undefined) {
          parts.push({
            inlineData: { mimeType: part.mediaType ?? "video/mp4", data: part.data },
            ...(videoMetadata !== undefined ? { videoMetadata } : {}),
          });
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
              response: message.provider_raw?.gemini_function_response ?? {
                content: irMessageContentToText(message.content),
              },
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

  // —— Map the flat IR sampling/control knobs onto Gemini's camelCase generationConfig
  // (litellm map_openai_params parity). stop string -> 1-element stopSequences; n ->
  // candidateCount; logprobs(bool)/top_logprobs(int) -> responseLogprobs/logprobs;
  // modalities -> uppercase responseModalities; reasoning_effort -> thinkingConfig.
  const samplingConfig: Record<string, unknown> = {
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.max_tokens !== undefined ? { maxOutputTokens: parsed.max_tokens } : {}),
    ...(parsed.top_p !== undefined ? { topP: parsed.top_p } : {}),
    ...(parsed.top_k !== undefined ? { topK: parsed.top_k } : {}),
    ...(parsed.frequency_penalty !== undefined
      ? { frequencyPenalty: parsed.frequency_penalty }
      : {}),
    ...(parsed.presence_penalty !== undefined ? { presencePenalty: parsed.presence_penalty } : {}),
    ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
    ...(parsed.stop !== undefined
      ? { stopSequences: typeof parsed.stop === "string" ? [parsed.stop] : parsed.stop }
      : {}),
    ...(parsed.n !== undefined ? { candidateCount: parsed.n } : {}),
    ...(parsed.logprobs !== undefined ? { responseLogprobs: parsed.logprobs } : {}),
    ...(parsed.top_logprobs !== undefined ? { logprobs: parsed.top_logprobs } : {}),
    ...(parsed.modalities !== undefined
      ? {
          responseModalities: parsed.modalities.map(
            (m) => IR_TO_GEMINI_MODALITY[m] ?? "MODALITY_UNSPECIFIED",
          ),
        }
      : {}),
    ...((): Record<string, unknown> => {
      const tc = reasoningEffortToThinkingConfig(parsed.reasoning_effort);
      return tc !== undefined ? { thinkingConfig: tc } : {};
    })(),
  };

  const generationConfig = mergeGenerationConfig(
    Object.keys(samplingConfig).length > 0 ? samplingConfig : undefined,
    responseFormatToGenerationConfig(parsed.response_format),
  );
  const toolConfig = irToolChoiceToGeminiToolConfig(parsed.tool_choice);
  const safetySettings = Array.isArray(parsed.provider_raw?.safety_settings)
    ? parsed.provider_raw.safety_settings
    : undefined;

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(generationConfig !== undefined ? { generationConfig } : {}),
    ...(parsed.cached_content !== undefined ? { cachedContent: parsed.cached_content } : {}),
    ...(safetySettings !== undefined ? { safetySettings } : {}),
  };
}

// —— Outbound: IR response -> native Gemini response. ——————————————————————————————

function irUsageToMetadata(usage: IRResponse["usage"]): GeminiUsageMetadata | undefined {
  if (usage === undefined) return undefined;
  const prompt =
    (usage.prompt_tokens ?? 0) + (usage.cached_tokens ?? 0) + (usage.cache_creation_tokens ?? 0);
  const candidates = usage.completion_tokens ?? 0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: prompt + candidates,
    ...(usage.cached_tokens !== undefined ? { cachedContentTokenCount: usage.cached_tokens } : {}),
    ...(usage.reasoning_tokens !== undefined ? { thoughtsTokenCount: usage.reasoning_tokens } : {}),
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
  // GENERATED media surfaces on the message, not as input content parts: inlineData
  // image/* -> images[] (IRImageOut), audio/* -> audio (IRAudioOut). Any other inline
  // mime degrades to an image content part (lossless data-url passthrough).
  const images: NonNullable<IRMessage["images"]> = [];
  let audio: IRMessage["audio"];

  for (const part of candidate.content.parts) {
    if (part.text !== undefined) {
      // A thought part (thought===true) is REASONING — it must become a thinking
      // content part, not leak into the visible text. thoughtSignature (if any) is
      // preserved on the part. liftReasoningToFlat later mirrors it onto the flat
      // reasoning_content/thinking_blocks carriers for OpenAI clients. (P6)
      if (part.thought === true) {
        parts.push({
          type: "thinking",
          text: part.text,
          ...(part.thoughtSignature !== undefined ? { signature: part.thoughtSignature } : {}),
        });
      } else {
        parts.push({ type: "text", text: part.text });
      }
    } else if (part.inlineData !== undefined) {
      const mime = part.inlineData.mimeType;
      if (mime.startsWith("image/")) {
        images.push({ b64_json: part.inlineData.data, mediaType: mime });
      } else if (mime.startsWith("audio/")) {
        audio = { data: part.inlineData.data };
      } else {
        parts.push(inlineDataToImagePart(part.inlineData));
      }
    } else if (part.functionCall !== undefined) {
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

  const annotations = groundingToAnnotations(
    candidate.groundingMetadata,
    candidate.citationMetadata,
  );

  const hasContent = parts.length > 0;
  // Lift any thinking content part onto reasoning_content/thinking_blocks (P6).
  return liftReasoningToFlat({
    role: "assistant",
    content: hasContent
      ? parts
      : toolCalls.length > 0 || images.length > 0 || audio !== undefined
        ? null
        : "",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  });
}

function transformResponseIn(native: unknown): IRResponse {
  const res = GeminiGenerateContentResponseSchema.parse(native);
  const candidate = res.candidates?.[0];
  const message: IRMessage =
    candidate !== undefined
      ? geminiCandidateToMessage(candidate)
      : { role: "assistant", content: "" };

  const um = res.usageMetadata;
  const candidateDetails = modalityDetailsToIR(um?.candidatesTokensDetails);
  // order 28: the effective cached count is the aggregate cachedContentTokenCount when
  // present, else the sum of the per-modality cacheTokensDetails (otherwise dropped).
  const cachedFromDetails = (um?.cacheTokensDetails ?? []).reduce(
    (sum, d) => sum + (d.tokenCount ?? 0),
    0,
  );
  const effectiveCached =
    um?.cachedContentTokenCount ?? (cachedFromDetails > 0 ? cachedFromDetails : undefined);
  // Merge the cached count into prompt_tokens_details (alongside the modality split).
  const basePromptDetails = modalityDetailsToIR(um?.promptTokensDetails);
  const promptDetails =
    effectiveCached !== undefined
      ? { ...(basePromptDetails ?? {}), cached_tokens: effectiveCached }
      : basePromptDetails;
  const usage =
    um !== undefined
      ? {
          ...(um.promptTokenCount !== undefined
            ? { prompt_tokens: Math.max(0, um.promptTokenCount - (effectiveCached ?? 0)) }
            : {}),
          ...(um.candidatesTokenCount !== undefined
            ? { completion_tokens: um.candidatesTokenCount }
            : {}),
          ...(effectiveCached !== undefined ? { cached_tokens: effectiveCached } : {}),
          // thoughtsTokenCount is the reasoning-token count (litellm parity).
          ...(um.thoughtsTokenCount !== undefined
            ? { reasoning_tokens: um.thoughtsTokenCount }
            : {}),
          ...(promptDetails !== undefined ? { prompt_tokens_details: promptDetails } : {}),
          ...(candidateDetails !== undefined
            ? { completion_tokens_details: candidateDetails }
            : {}),
        }
      : undefined;

  // promptFeedback.blockReason means the PROMPT was rejected (no candidate). Surface
  // it as content_filter and keep the raw block; its blockReason is also the raw stop.
  const promptBlock = res.promptFeedback?.blockReason;
  const mappedFinish =
    promptBlock !== undefined && promptBlock !== ""
      ? "content_filter"
      : mapFinishReasonToIR(candidate?.finishReason);
  // order 26: Gemini returns finishReason STOP alongside a functionCall (no TOOL_CALLS
  // enum); remap to tool_calls so an OpenAI/Anthropic client sees the correct terminal.
  const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
  const finishReason = hasToolCalls && mappedFinish === "stop" ? "tool_calls" : mappedFinish;

  // logprobsResult -> IRChoice.logprobs (kept raw under the logprobs bag; IRLogprobs is
  // permissive/.passthrough()). safetyRatings + promptFeedback live in provider_raw.
  const logprobs = candidate?.logprobsResult;

  const ir: IRResponse = {
    id: `gemini_${Date.now()}`,
    model: res.modelVersion ?? "gemini",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        ...(logprobs !== undefined && logprobs !== null
          ? { logprobs: logprobs as Record<string, unknown> }
          : {}),
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
    provider_raw: {
      ...(candidate?.finishReason !== undefined
        ? { stop_reason: candidate.finishReason }
        : promptBlock !== undefined
          ? { stop_reason: promptBlock }
          : {}),
      ...(um !== undefined ? { usage: um } : {}),
      ...(candidate?.safetyRatings !== undefined
        ? { safety_ratings: candidate.safetyRatings }
        : {}),
      ...(res.promptFeedback !== undefined ? { prompt_feedback: res.promptFeedback } : {}),
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
  argsValue: unknown;
}

function isSnapshotCompatible(previous: unknown, current: unknown): boolean {
  if (Object.is(previous, current)) return true;
  if (typeof previous === "string" && typeof current === "string") {
    return current.startsWith(previous);
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    return (
      current.length >= previous.length &&
      previous.every((value, index) => isSnapshotCompatible(value, current[index]))
    );
  }
  if (
    previous !== null &&
    current !== null &&
    typeof previous === "object" &&
    typeof current === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(current)
  ) {
    return Object.entries(previous as Record<string, unknown>).every(([key, value]) =>
      isSnapshotCompatible(value, (current as Record<string, unknown>)[key]),
    );
  }
  return false;
}

async function* transformStreamIn(src: AsyncIterable<GeminiSSEEvent>): AsyncIterable<IRChunk> {
  let started = false;
  let lastModel: string | undefined;
  let pendingFinish: string | null = null;
  let hasSeenToolCalls = false; // order 26: STOP + functionCalls -> tool_calls terminal
  let lastUsage: IRChunk["usage"];
  let groundingMeta: unknown; // latest grounding/citation metadata seen across frames
  let citationMeta: unknown;
  // Tool args are NOT append-only across Gemini snapshots: each snapshot carries the
  // CURRENT complete `args` object (which JSON.stringify may re-serialize wholesale,
  // not as a strict prefix extension). So we BUFFER the latest full args per tool and
  // flush a single complete `arguments` string at stream end — tolerating arbitrary
  // fragmentation without ever emitting a half-parsed JSON delta (docs/05 pit:
  // "tolerate partial JSON; accumulate to complete before parse"). Duplicate parallel
  // calls can share the same name and may arrive across separate frames. Gemini gives
  // no stable id/index, so only reuse a same-name slot when the new args look like a
  // compatible snapshot extension; otherwise allocate a new parallel slot.
  const toolSlots: StreamToolSlot[] = [];

  for await (const raw of src) {
    const event = GeminiSSEEventSchema.parse(raw);

    // —— A top-level error frame aborts the generation: surface it instead of silently
    // dropping (docs/05 streaming correctness). Throw so the gateway error path runs.
    if (event.error !== undefined) {
      const e = event.error;
      throw new Error(
        `Gemini stream error${e.status !== undefined ? ` [${e.status}]` : ""}: ${e.message ?? "unknown"}`,
      );
    }

    const candidate = event.candidates?.[0];
    if (event.modelVersion !== undefined) lastModel = event.modelVersion;
    if (candidate?.groundingMetadata !== undefined) groundingMeta = candidate.groundingMetadata;
    if (candidate?.citationMetadata !== undefined) citationMeta = candidate.citationMetadata;

    // order 27: a prompt-level block (no candidate) means the prompt was rejected —
    // surface it as content_filter on the terminal chunk (mirrors the non-stream path).
    const promptBlock = event.promptFeedback?.blockReason;
    if (promptBlock !== undefined && promptBlock !== "") pendingFinish = "content_filter";

    const roleField = !started ? { role: "assistant" } : {};
    started = true;

    // —— Split visible text from thought parts. A thought part (part.thought===true)
    // is reasoning, streamed as delta.reasoning_content; visible text is delta.content.
    // Gemini `?alt=sse` frames are INCREMENTAL deltas — each frame's text is the NEW
    // chunk, NOT a growing snapshot (confirmed against the official SDK; mirrors our own
    // transformStreamOut). So forward each frame's text/thought verbatim as the delta.
    // (Per-frame snapshot-prefix diffing truncated a delta that happened to start with
    // the prior one, e.g. "a" then "ab" -> "b" instead of "ab"; one explicit framing
    // mode avoids that — docs/05 streaming correctness.) ————————————————————————————————
    const parts = candidate?.content.parts ?? [];
    const isThought = (p: GeminiPart): boolean => (p as { thought?: boolean }).thought === true;
    const textDelta = parts
      .filter((p) => !isThought(p))
      .map((p) => p.text ?? "")
      .join("");
    const thoughtDelta = parts
      .filter(isThought)
      .map((p) => p.text ?? "")
      .join("");

    // —— tool-call args: buffer the latest full args per inferred tool slot. ——
    const usedToolIndexes = new Set<number>();
    for (const part of parts) {
      if (part.functionCall === undefined) continue;
      hasSeenToolCalls = true;
      const name = part.functionCall.name;
      const argsValue = part.functionCall.args ?? {};
      let slot = toolSlots.find(
        (candidate) =>
          candidate.name === name &&
          !usedToolIndexes.has(candidate.index) &&
          isSnapshotCompatible(candidate.argsValue, argsValue),
      );
      if (slot === undefined) {
        slot = { index: toolSlots.length, name, fullArgs: "", argsValue };
        toolSlots.push(slot);
      }
      usedToolIndexes.add(slot.index);
      slot.argsValue = argsValue;
      slot.fullArgs = JSON.stringify(argsValue);
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
        ...(um.thoughtsTokenCount !== undefined ? { reasoning_tokens: um.thoughtsTokenCount } : {}),
      };
    }

    // Emit a delta chunk for streamed text/reasoning and/or the first-chunk role
    // announcement; tool args + annotations are flushed at stream end. Skip a silent
    // empty mid-stream snapshot.
    const isFirst = Object.keys(roleField).length > 0;
    if (textDelta !== "" || thoughtDelta !== "" || isFirst) {
      const delta: NonNullable<IRChunk["choices"]>[number]["delta"] = {
        ...roleField,
        ...(textDelta !== "" ? { content: textDelta } : {}),
        ...(thoughtDelta !== "" ? { reasoning_content: thoughtDelta } : {}),
      };
      yield {
        ...(lastModel !== undefined ? { model: lastModel } : {}),
        choices: [{ index: 0, delta }],
      };
    }
  }

  // —— Stream end: emit accumulated grounding/citation as an annotations delta (one
  // chunk) before the tool flush + terminal finish. ————————————————————————————————
  const annotations = groundingToAnnotations(groundingMeta, citationMeta);
  if (annotations !== undefined) {
    yield {
      ...(lastModel !== undefined ? { model: lastModel } : {}),
      choices: [{ index: 0, delta: { annotations } }],
    };
  }

  // —— Stream end: flush complete tool-call args (each a fully-parseable JSON), then
  // the terminal finish_reason exactly once (idempotent close, docs/05 pit #4). ——
  for (const slot of toolSlots) {
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
  // order 26: a STOP (or absent) finish alongside emitted tool calls is really tool_calls.
  const terminalFinish =
    hasSeenToolCalls && (pendingFinish === null || pendingFinish === "stop")
      ? "tool_calls"
      : (pendingFinish ?? "stop");
  yield {
    ...(lastModel !== undefined ? { model: lastModel } : {}),
    choices: [{ index: 0, delta: {}, finish_reason: terminalFinish }],
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

  const toUsageMetadata = (usage: NonNullable<IRChunk["usage"]>): GeminiUsageMetadata => {
    const nestedPromptDetails = usage.prompt_tokens_details;
    const cached = usage.cached_tokens ?? nonNegativeToken(nestedPromptDetails?.cached_tokens);
    const cacheCreation =
      usage.cache_creation_tokens ??
      nonNegativeToken(nestedPromptDetails?.cache_creation_tokens) ??
      nonNegativeToken(nestedPromptDetails?.cache_creation_input_tokens) ??
      nonNegativeToken(nestedPromptDetails?.cache_write_tokens);
    const prompt =
      usage.prompt_tokens !== undefined
        ? usage.prompt_tokens + (cached ?? 0) + (cacheCreation ?? 0)
        : undefined;
    const candidates = usage.completion_tokens;
    return {
      ...(prompt !== undefined ? { promptTokenCount: prompt } : {}),
      ...(candidates !== undefined ? { candidatesTokenCount: candidates } : {}),
      // The real Gemini wire always carries totalTokenCount on the terminal frame.
      ...(prompt !== undefined || candidates !== undefined
        ? { totalTokenCount: (prompt ?? 0) + (candidates ?? 0) }
        : {}),
      ...(usage.reasoning_tokens !== undefined
        ? { thoughtsTokenCount: usage.reasoning_tokens }
        : {}),
      ...(cached !== undefined ? { cachedContentTokenCount: cached } : {}),
    };
  };

  // The terminal frame (text delta + functionCall parts + finishReason) is held back
  // until stream end so a late usage-only chunk merges into it as ONE frame.
  let terminalParts: GeminiPart[] | null = null;
  let terminalFinish: string | undefined;
  let latestUsage: GeminiUsageMetadata | undefined;

  for await (const chunk of src) {
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;
    const reasoning = choice?.delta?.reasoning_content;

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
      if (typeof reasoning === "string" && reasoning !== "") {
        terminalParts.push({ text: reasoning, thought: true });
      }
      if (typeof content === "string" && content !== "") terminalParts.push({ text: content });
      terminalParts.push(...flushToolParts());
      terminalFinish = mapFinishReasonToGemini(choice.finish_reason) ?? "STOP";
      continue;
    }

    // Non-terminal: forward a reasoning delta as a thought part and/or a real text
    // delta. Role-only announcements, tool-arg fragments, and usage-only chunks carry
    // no Gemini frame (Gemini has no empty/role frame; their payload surfaces on the
    // terminal frame instead).
    if (typeof reasoning === "string" && reasoning !== "") {
      yield {
        candidates: [
          { content: { role: "model", parts: [{ text: reasoning, thought: true }] }, index: 0 },
        ],
      };
    }
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
