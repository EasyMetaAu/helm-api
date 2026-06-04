import type { IRRequest, IRResponse } from "./ir.js";

// —— The cross-protocol translation matrix (P8). FOUR protocols — OpenAI Chat,
// Anthropic Messages, Gemini generateContent, and OpenAI Responses — each of which
// can be both a SOURCE (nativeIn -> IR) and a TARGET (IR -> nativeOut). The full
// matrix is therefore 4×4 = 16 round-trip paths, INCLUDING the four identity/self
// paths (openai->openai, …) which guard that a protocol's own inbound and outbound
// halves compose losslessly. Translation is always nativeIn -> IR -> nativeOut, so
// these 16 paths are exercised by 4 inbound + 4 outbound transforms, never 16 direct
// converters.
//
// Each (path, dimension) cell is a fixture: it asserts either round-trip PRESERVATION
// or a DOCUMENTED degradation (a provider_raw passthrough or a structured warning).
// A cell with no feasible mapping today is `todo` with a >20-char reason, so gaps are
// explicit instead of silently green.
export const protocols = ["openai", "anthropic", "gemini", "responses"] as const;
export type ProtocolName = (typeof protocols)[number];

export const protocolMatrixDimensions = [
  "request",
  "response",
  "streaming",
  "tool-call",
  "multimodal",
  "json-schema",
  "error",
  "usage",
] as const;
export type ProtocolMatrixDimension = (typeof protocolMatrixDimensions)[number];

export type FixtureStatus = "passing" | "todo";

export interface ProtocolMatrixFixture {
  readonly id: string;
  readonly dimension: ProtocolMatrixDimension;
  readonly status: FixtureStatus;
  readonly assertion: string;
  readonly todoReason?: string;
}

export interface ProtocolMatrixPath {
  readonly from: ProtocolName;
  readonly to: ProtocolName;
  readonly fixtures: readonly ProtocolMatrixFixture[];
}

export const protocolMatrixProvenance =
  "Fixture matrix is based on public LiteLLM behavior/checklist observations only; no LiteLLM code is copied, vendored, or translated.";

function fixture(
  dimension: ProtocolMatrixDimension,
  status: FixtureStatus,
  assertion: string,
  todoReason?: string,
): ProtocolMatrixFixture {
  return {
    id: `${dimension}:${status}:${assertion.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    dimension,
    status,
    assertion,
    ...(todoReason !== undefined ? { todoReason } : {}),
  };
}

// —— Per-TARGET capability of the executable renderers. The matrix's `passing`
// status is keyed on what the TARGET protocol's IR->native renderer can faithfully
// emit (the source side is always a full nativeIn->IR normalizer). Cells listed here
// are documented degradations on the OUTBOUND (IR -> target) side. ————————————————————
const TARGET_DEGRADATIONS: Partial<
  Record<ProtocolName, Partial<Record<ProtocolMatrixDimension, string>>>
> = {
  // The Responses IR->native request renderer collapses content to text
  // (contentToText) and carries structured-output via the `text` field rather than a
  // response_format clone, so these two OUTBOUND dimensions are documented gaps.
  // (Inline base64 images DO round-trip to Gemini inlineData — only a REMOTE
  // image_url is a non-goal, issue #49; the canonical fixture uses an inline image so
  // X->gemini multimodal is passing.)
  responses: {
    multimodal:
      "The Responses IR->native request renderer folds content to text (contentToText), so image parts are not re-emitted as input_image on the outbound request path yet.",
    "json-schema":
      "Responses carries structured output via the native `text`/format field, not a response_format clone; the IR->Responses request renderer does not yet re-emit a JSON schema there.",
  },
};

// —— SOURCE-side documented gaps. A knob whose NATIVE inbound shape does not
// normalize into the IR shape the other targets read. ————————————————————————————————
const SOURCE_DEGRADATIONS: Partial<
  Record<ProtocolName, Partial<Record<ProtocolMatrixDimension, string>>>
> = {
  // The Responses structured-output shape is `text.format.{json_schema}`, which the
  // inbound normalizer parks on IR.response_format VERBATIM — it is NOT the OpenAI
  // `response_format.{type,json_schema}` shape the Anthropic/Gemini outbound renderers
  // expect, so a responses-origin JSON schema does not yet re-render to those targets'
  // structured-output surface. (A responses->responses self round-trip is fine.)
  responses: {
    "json-schema":
      "Responses carries structured output as text.format.{json_schema}; the inbound normalizer keeps it verbatim on IR.response_format, which is NOT the OpenAI response_format shape the Anthropic/Gemini outbound renderers read.",
  },
};

function dimensionFixture(
  from: ProtocolName,
  to: ProtocolName,
  dimension: ProtocolMatrixDimension,
): ProtocolMatrixFixture {
  const self = from === to;
  const label = self ? `${from} self` : `${from}->${to}`;
  const degraded = TARGET_DEGRADATIONS[to]?.[dimension];
  // A SOURCE gap only applies to cross paths — a self round-trip reads its own shape
  // back and is lossless.
  const sourceGap = self ? undefined : SOURCE_DEGRADATIONS[from]?.[dimension];

  if (degraded !== undefined) {
    return fixture(
      dimension,
      "todo",
      `${label} ${dimension}: documented target degradation`,
      degraded,
    );
  }

  if (sourceGap !== undefined) {
    return fixture(
      dimension,
      "todo",
      `${label} ${dimension}: documented source degradation`,
      sourceGap,
    );
  }

  // Passing assertions: a concise human-readable statement of the invariant the
  // executable harness guards for this cell.
  const passing: Record<ProtocolMatrixDimension, string> = {
    request: `${label} request normalizes to a schema-valid IR before any ${to} nativeOut`,
    response: `${label} renders a canonical IR response as a ${to} native response`,
    streaming: `${label} streams IR chunks to ordered ${to} native stream events`,
    "tool-call": `${label} preserves the tool call through IR into the ${to} native tool surface`,
    multimodal: `${label} preserves an inline image through IR into the ${to} native image surface`,
    "json-schema": `${label} preserves the JSON schema through IR into the ${to} structured-output surface`,
    error: `${label} renders a Helm error into the ${to} native error envelope`,
    usage: `${label} keeps cached/prompt/completion usage non-double-billed through IR`,
  };
  return fixture(dimension, "passing", passing[dimension]);
}

function buildPath(from: ProtocolName, to: ProtocolName): ProtocolMatrixPath {
  return {
    from,
    to,
    fixtures: protocolMatrixDimensions.map((d) => dimensionFixture(from, to, d)),
  };
}

// The FULL 4×4 matrix, including the four identity/self paths.
export const protocolMatrix: readonly ProtocolMatrixPath[] = protocols.flatMap((from) =>
  protocols.map((to) => buildPath(from, to)),
);

// Non-identity cross paths (kept as a named export for callers that only want the
// 12 distinct-protocol conversions).
export const protocolCrossPathMatrix: readonly ProtocolMatrixPath[] = protocolMatrix.filter(
  (p) => p.from !== p.to,
);

// Identity/self paths only (the 4 round-trips through a single protocol's own halves).
export const protocolIdentityMatrix: readonly ProtocolMatrixPath[] = protocolMatrix.filter(
  (p) => p.from === p.to,
);

export const canonicalRequestIR: IRRequest = {
  model: "matrix-model",
  messages: [
    { role: "system", content: "Be precise." },
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this image and call the tool." },
        { type: "image", url: "data:image/png;base64,AAAA", mediaType: "image/png" },
      ],
    },
    {
      role: "assistant",
      content: "Calling weather.",
      tool_calls: [
        {
          id: "call_weather_0",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Melbourne"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_weather_0", content: "18C" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather by city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string", format: "city-name" } },
          required: ["city"],
        },
      },
    },
  ],
  tool_choice: "auto",
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "weather_answer",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
  stream: true,
};

// A reasoning-bearing assistant response carried in BOTH IR shapes: a
// {type:"thinking"} content part AND the flat reasoning_content/thinking_blocks
// carriers. Used by the P6 reasoning cross-path checks to assert reasoning survives
// nativeOut into every target's native thinking surface.
export const canonicalReasoningResponseIR: IRResponse = {
  id: "matrix-reasoning-1",
  model: "matrix-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "Reasoning step.", signature: "sig-matrix" },
          { type: "text", text: "Here is the answer." },
        ],
        reasoning_content: "Reasoning step.",
        thinking_blocks: [
          { type: "thinking", thinking: "Reasoning step.", signature: "sig-matrix" },
        ],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, reasoning_tokens: 6 },
};

// An annotation/citation-bearing assistant response. Used by the P8 citations cross-
// path check: a url_citation annotation must survive nativeIn->IR->nativeOut into each
// target that has a citation surface, or be documented as a provider_raw passthrough.
export const canonicalAnnotationResponseIR: IRResponse = {
  id: "matrix-annotation-1",
  model: "matrix-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Sydney is in Australia.",
        annotations: [
          {
            type: "url_citation",
            url: "https://example.com/au",
            title: "Australia",
            start_index: 0,
            end_index: 6,
          },
        ],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 5 },
};

export const canonicalResponseIR: IRResponse = {
  id: "matrix-response-1",
  model: "matrix-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Here is the answer.",
        tool_calls: [
          {
            id: "call_weather_0",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Melbourne"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, cached_tokens: 3, completion_tokens: 4 },
  provider_raw: {
    stop_reason: "tool_calls",
    usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
  },
};
