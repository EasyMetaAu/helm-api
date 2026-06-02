import type { IRRequest, IRResponse } from "./ir.js";

export const protocols = ["openai", "anthropic", "gemini"] as const;
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

function path(
  from: ProtocolName,
  to: ProtocolName,
  fixtures: readonly ProtocolMatrixFixture[],
): ProtocolMatrixPath {
  return { from, to, fixtures };
}

const openaiToAnthropic = path("openai", "anthropic", [
  fixture(
    "request",
    "todo",
    "OpenAI request can be normalized to IR; Anthropic request nativeOut is not implemented yet",
    "PR A records the gap only; adding IR->Anthropic request behavior belongs to a later PR.",
  ),
  fixture("response", "passing", "IR assistant response renders as Anthropic message response"),
  fixture("streaming", "passing", "OpenAI chunks render as ordered Anthropic SSE events"),
  fixture("tool-call", "passing", "OpenAI tool_calls render as Anthropic tool_use blocks"),
  fixture(
    "multimodal",
    "todo",
    "OpenAI image_url to Anthropic image source requires request nativeOut support",
    "Keep as matrix coverage until IR->Anthropic request conversion is designed.",
  ),
  fixture(
    "json-schema",
    "todo",
    "OpenAI response_format to Anthropic JSON mode/output_format strategy is undecided",
    "Issue #45 requires Trent policy before silent mapping.",
  ),
  fixture("error", "passing", "Helm ErrorClass can render an Anthropic-native error envelope"),
  fixture("usage", "passing", "Cached prompt tokens stay separate in Anthropic usage"),
]);

const anthropicToOpenai = path("anthropic", "openai", [
  fixture("request", "passing", "Anthropic request normalizes to IR and OpenAI request nativeOut"),
  fixture(
    "response",
    "todo",
    "Anthropic provider-native response to IR is not implemented",
    "Current Anthropic response module is IR->Anthropic only.",
  ),
  fixture(
    "streaming",
    "todo",
    "Anthropic inbound stream to OpenAI chunk conversion is not implemented",
    "Current stream module covers OpenAI chunks -> Anthropic events.",
  ),
  fixture("tool-call", "passing", "Anthropic tool_use/tool_result normalizes to OpenAI-shaped IR"),
  fixture("multimodal", "passing", "Anthropic base64 image source normalizes to IR image data URL"),
  fixture(
    "json-schema",
    "todo",
    "Anthropic JSON mode/output_format to OpenAI response_format fixture is pending",
    "No current transformer behavior to exercise without changing behavior.",
  ),
  fixture(
    "error",
    "passing",
    "Helm ErrorClass renders an OpenAI-native error envelope for Anthropic-origin failures",
  ),
  fixture("usage", "passing", "Anthropic cache_read_input_tokens can stay distinct in IR usage"),
]);

const openaiToGemini = path("openai", "gemini", [
  fixture(
    "request",
    "passing",
    "OpenAI request normalizes to IR and Gemini generateContent nativeOut",
  ),
  fixture(
    "response",
    "passing",
    "IR assistant response renders as Gemini generateContent response",
  ),
  fixture("streaming", "passing", "OpenAI chunks render as Gemini full-snapshot SSE events"),
  fixture("tool-call", "passing", "OpenAI tool_calls render as Gemini functionCall parts"),
  fixture(
    "multimodal",
    "todo",
    "OpenAI remote image_url outbound to Gemini is an explicit non-goal",
    "Remote image fetch/proxy is a non-goal for issue #49; Gemini nativeOut emits an explicit text placeholder until a later fetch/proxy design exists.",
  ),
  fixture(
    "json-schema",
    "passing",
    "OpenAI response_format JSON schema renders as Gemini generationConfig.responseSchema",
  ),
  fixture(
    "error",
    "passing",
    "Helm ErrorClass renders a Gemini-native google.rpc.Status error envelope",
  ),
  fixture(
    "usage",
    "passing",
    "IR usage renders as Gemini usageMetadata without double-counting cache",
  ),
]);

const geminiToOpenai = path("gemini", "openai", [
  fixture(
    "request",
    "passing",
    "Gemini generateContent normalizes to IR and OpenAI request nativeOut",
  ),
  fixture("response", "passing", "Gemini response normalizes to IR and OpenAI response nativeOut"),
  fixture(
    "streaming",
    "todo",
    "Gemini snapshot stream to OpenAI chunks is not exposed as a target fixture yet",
    "Current Gemini stream helper normalizes snapshots to IR chunks; OpenAI SSE serialization is gateway-level.",
  ),
  fixture(
    "tool-call",
    "passing",
    "Gemini functionCall/functionResponse normalizes with synthesized tool ids",
  ),
  fixture("multimodal", "passing", "Gemini inlineData normalizes to IR image data URL"),
  fixture(
    "json-schema",
    "passing",
    "Gemini responseSchema/functionDeclarations normalize into IR fields",
  ),
  fixture(
    "error",
    "passing",
    "Helm ErrorClass renders an OpenAI-native error envelope for Gemini-origin failures",
  ),
  fixture("usage", "passing", "Gemini cachedContentTokenCount remains distinct in IR usage"),
]);

const anthropicToGemini = path("anthropic", "gemini", [
  fixture("request", "passing", "Anthropic request normalizes to IR and Gemini request nativeOut"),
  fixture(
    "response",
    "todo",
    "Anthropic provider-native response to Gemini response is not implemented",
    "Current Anthropic response module is IR->Anthropic only.",
  ),
  fixture(
    "streaming",
    "todo",
    "Anthropic stream to Gemini snapshot stream has no implemented source stream normalizer",
    "PR A records the cross-stream gap only.",
  ),
  fixture(
    "tool-call",
    "passing",
    "Anthropic tool_use/tool_result can become Gemini functionCall/functionResponse via IR",
  ),
  fixture(
    "multimodal",
    "passing",
    "Anthropic base64 image source can become Gemini inlineData via IR",
  ),
  fixture(
    "json-schema",
    "todo",
    "Anthropic JSON mode/output_format to Gemini responseSchema strategy is pending",
    "No current transformer behavior to exercise without changing behavior.",
  ),
  fixture(
    "error",
    "passing",
    "Helm ErrorClass renders Gemini-native google.rpc.Status envelopes for Anthropic-origin failures",
  ),
  fixture("usage", "passing", "IR cached usage can render to Gemini usageMetadata"),
]);

const geminiToAnthropic = path("gemini", "anthropic", [
  fixture(
    "request",
    "todo",
    "Gemini request normalizes to IR; Anthropic request nativeOut is not implemented yet",
    "PR A records the gap only; adding IR->Anthropic request behavior belongs to a later PR.",
  ),
  fixture(
    "response",
    "passing",
    "Gemini response can normalize to IR and render as Anthropic response",
  ),
  fixture(
    "streaming",
    "todo",
    "Gemini snapshot stream to Anthropic events needs a source stream normalizer plus target renderer",
    "Current helpers do not expose that full path without new behavior.",
  ),
  fixture(
    "tool-call",
    "passing",
    "Gemini functionCall can render as Anthropic tool_use through IR",
  ),
  fixture(
    "multimodal",
    "passing",
    "Gemini inlineData normalizes to IR image data URL for Anthropic policy decisions",
  ),
  fixture(
    "json-schema",
    "todo",
    "Gemini responseSchema to Anthropic JSON mode/output_format strategy is pending",
    "No current transformer behavior to exercise without changing behavior.",
  ),
  fixture(
    "error",
    "passing",
    "Helm ErrorClass can render Anthropic-native envelopes for Gemini-origin failures",
  ),
  fixture(
    "usage",
    "passing",
    "Gemini cached usage can render as Anthropic cache_read_input_tokens",
  ),
]);

export const protocolCrossPathMatrix = [
  openaiToAnthropic,
  anthropicToOpenai,
  openaiToGemini,
  geminiToOpenai,
  anthropicToGemini,
  geminiToAnthropic,
] as const;

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
