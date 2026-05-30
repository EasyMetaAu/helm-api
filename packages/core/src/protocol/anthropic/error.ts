import { type ErrorClass, type HelmError, makeHelmError } from "@helm/shared";

// HelmError -> native Anthropic error shape (docs/05 §错误也按客户端协议形态翻译,
// docs/07). The outbound error half of the Protocol Adapter: a structured internal
// error becomes the wire envelope the Anthropic SDK expects
//
//   { "type": "error", "error": { "type": <anthropic_type>, "message": <text> } }
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). The gateway
// NEVER hand-assembles an error string — it hands a HelmError here and serializes
// the result. HTTP status comes from the shared ERROR_CLASS_HTTP_STATUS table so
// the status and the body's type cannot drift.

// —— error_class -> Anthropic error.type (the SDK's documented error types). ——————
// Anthropic's set is narrower than Helm's 8 classes, so several map onto the same
// native type while the precise Helm class survives in the response trace_id /
// telemetry. Exhaustive over ErrorClass (compile error if a class is added).
const ANTHROPIC_ERROR_TYPE: Record<ErrorClass, string> = {
  auth_error: "authentication_error",
  invalid_request: "invalid_request_error",
  lane_unavailable: "overloaded_error",
  all_providers_failed: "api_error",
  capability_unsatisfiable: "invalid_request_error",
  upstream_error: "api_error",
  timeout: "api_error",
  rate_limited: "rate_limit_error",
};

export interface AnthropicErrorEnvelope {
  type: "error";
  error: { type: string; message: string };
}

/**
 * Translate a HelmError into the native Anthropic error envelope plus its HTTP
 * status. Pure. The message is assumed already-redacted by the producer
 * (principle 7); this function only re-shapes, never inspects payload.
 */
export function transformErrorOut(err: HelmError): {
  status: number;
  body: AnthropicErrorEnvelope;
} {
  return {
    status: err.http_status,
    body: {
      type: "error",
      error: { type: ANTHROPIC_ERROR_TYPE[err.error_class], message: err.message },
    },
  };
}

/**
 * Convenience: build a HelmError and translate it in one step. Used by the
 * gateway's auth/short-circuit paths that have only a class + message + trace_id.
 */
export function makeAnthropicError(args: {
  error_class: ErrorClass;
  message: string;
  trace_id: string;
}): { status: number; body: AnthropicErrorEnvelope } {
  return transformErrorOut(makeHelmError(args));
}
