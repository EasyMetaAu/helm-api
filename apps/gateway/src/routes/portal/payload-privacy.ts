import { nextSSEFrameBoundary, parseSSEFrame, type RequestPayloadPart, redact } from "@helm/core";
import { redactPortalDiagnostics } from "./privacy.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only protocol content/options are inspectable. New upstream identity fields
// stay private until explicitly reviewed here; the original request is untouched.
const forwardedFields = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "stop",
  "stop_sequences",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "response_format",
  "text",
  "reasoning",
  "thinking",
  "output_config",
  "service_tier",
  "modalities",
  "audio",
  "prediction",
  "n",
  "store",
  "truncation",
  "include",
  "previous_response_id",
  "conversation",
  "context_management",
  "cache_control",
  "contents",
  "systemInstruction",
  "system_instruction",
  "generationConfig",
  "generation_config",
  "safetySettings",
  "safety_settings",
  "toolConfig",
  "tool_config",
  "cachedContent",
  "metadata",
  "client_metadata",
]);

// Preserve caller/model content. Only generated forwarding metadata and error
// envelopes are projections; original client request bytes remain replayable.
export function projectPortalPayload(json: string, part: RequestPayloadPart): string {
  if (part === "request") return json;
  const diagnostics = (value: unknown) =>
    redactPortalDiagnostics(redact(value, { payloadKeys: [] }));
  const project = (value: unknown): unknown => {
    if (!object(value)) return value;
    if (part === "upstream_request") {
      for (const field of Object.keys(value)) if (!forwardedFields.has(field)) delete value[field];
      for (const field of ["metadata", "client_metadata"]) {
        if (object(value[field])) value[field] = diagnostics(value[field]);
      }
    }
    if (value.type === "error") return diagnostics(value);
    if (value.error !== undefined) value.error = diagnostics(value.error);
    if (object(value.response) && value.response.error !== undefined)
      value.response.error = diagnostics(value.response.error);
    return value;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    if (part === "upstream_request") throw new Error("invalid forwarded payload JSON");
    const projectFrame = (wire: string): string => {
      const frame = parseSSEFrame(wire.replace(/\r\n|\r/g, "\n"));
      if (!frame || frame.data.trim() === "[DONE]") return wire;
      const declaredError = /(?:^|[._-])(?:error|failed|failure)$/i.test(frame.event ?? "");
      let event: unknown;
      try {
        event = JSON.parse(frame.data);
      } catch {
        if (!declaredError) return wire;
        event = {
          error: {
            message: "Captured error event could not be decoded",
            code: "portal_unreadable_error",
          },
        };
      }
      const errorEnvelope =
        object(event) &&
        (event.error !== undefined ||
          event.type === "error" ||
          (object(event.response) && event.response.error !== undefined));
      if (!declaredError && !errorEnvelope) return wire;
      const safe = declaredError ? diagnostics(event) : project(event);
      return `${frame.event ? `event: ${frame.event}\n` : ""}data: ${JSON.stringify(safe)}`;
    };
    const output: string[] = [];
    let tail = json;
    while (true) {
      const boundary = nextSSEFrameBoundary(tail);
      if (!boundary) {
        output.push(projectFrame(tail));
        break;
      }
      output.push(
        projectFrame(tail.slice(0, boundary.index)),
        tail.slice(boundary.index, boundary.index + boundary.length),
      );
      tail = tail.slice(boundary.index + boundary.length);
    }
    return output.join("");
  }
  return JSON.stringify(project(parsed));
}
