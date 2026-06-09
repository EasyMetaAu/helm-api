import type { InternalRequest } from "@helm/shared";

// LiteLLM/OpenAI-compatible request knobs that are not part of routing identity
// but must survive HTTP protocol adapters into the provider execution body.
const REQUEST_PARAM_KEYS = [
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "n",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "stream_options",
  "modalities",
  "reasoning_effort",
  "user",
  "service_tier",
  "tool_choice",
  "cache_control",
  "thinking",
  "functions",
  "function_call",
  "prediction",
  "audio",
  "logit_bias",
  "web_search_options",
  "include_server_side_tool_invocations",
  "verbosity",
  "safety_identifier",
] as const;

export function copyLiteLLMRequestParams(
  source: Record<string, unknown>,
): Partial<InternalRequest> {
  const out: Record<string, unknown> = {};
  for (const key of REQUEST_PARAM_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<InternalRequest>;
}

export function providerRawFromRequest(
  source: Record<string, unknown>,
  options: { includeMetadata?: boolean } = {},
): Record<string, unknown> | undefined {
  const existing =
    source.provider_raw && typeof source.provider_raw === "object"
      ? (source.provider_raw as Record<string, unknown>)
      : {};
  const raw: Record<string, unknown> = { ...existing };
  // `metadata` is an OpenAI/Responses provider parameter, but InternalRequest also
  // has gateway metadata. Keep the provider value in provider_raw to avoid collision.
  const keys =
    options.includeMetadata === false
      ? ["store", "previous_response_id", "truncation", "context_management"]
      : ["metadata", "store", "previous_response_id", "truncation", "context_management"];
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) raw[key] = value;
  }
  return Object.keys(raw).length > 0 ? raw : undefined;
}
