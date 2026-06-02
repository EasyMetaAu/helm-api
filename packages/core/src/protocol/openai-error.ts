import { type ErrorClass, type HelmError, makeHelmError } from "@helm/shared";

// HelmError -> native OpenAI error shape (docs/05 errors are translated into the
// client protocol's shape, docs/07). The outbound error half of the OpenAI
// Protocol Adapter: a structured internal error becomes the wire envelope the
// OpenAI SDK expects
//
//   { "error": { "message": <text>, "type": <openai_type>,
//                "code": null, "param": null } }
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). The gateway
// NEVER hand-assembles an error string — it hands a HelmError here and serializes
// the result. HTTP status comes from the shared ERROR_CLASS_HTTP_STATUS table (via
// err.http_status) so the status and the body's type cannot drift.

// —— error_class -> OpenAI error.type (the SDK's documented error types). ————————
// OpenAI's documented set (authentication_error / invalid_request_error /
// rate_limit_error / server_error) is narrower than Helm's 8 classes, so several
// internal classes collapse onto server_error while the precise Helm class
// survives in telemetry / trace_id. Exhaustive over ErrorClass (compile error if a
// class is added).
const OPENAI_ERROR_TYPE: Record<ErrorClass, string> = {
  auth_error: "authentication_error",
  invalid_request: "invalid_request_error",
  lane_unavailable: "server_error",
  all_providers_failed: "server_error",
  capability_unsatisfiable: "invalid_request_error",
  upstream_error: "server_error",
  timeout: "server_error",
  rate_limited: "rate_limit_error",
};

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}

/**
 * Translate a HelmError into the native OpenAI error envelope plus its HTTP
 * status. Pure. The message is assumed already-redacted by the producer
 * (principle 7); this function only re-shapes, never inspects payload. `code` and
 * `param` are always null — Helm does not surface OpenAI's request-field-level
 * diagnostics — but the keys stay present so SDKs that read them do not NPE.
 */
export function transformErrorOut(err: HelmError): {
  status: number;
  body: OpenAIErrorEnvelope;
} {
  return {
    status: err.http_status,
    body: {
      error: {
        message: err.message,
        type: OPENAI_ERROR_TYPE[err.error_class],
        code: null,
        param: null,
      },
    },
  };
}

/**
 * Convenience: build a HelmError and translate it in one step. Used by the
 * gateway's auth/short-circuit paths that have only a class + message + trace_id.
 */
export function makeOpenAIError(args: {
  error_class: ErrorClass;
  message: string;
  trace_id: string;
}): { status: number; body: OpenAIErrorEnvelope } {
  return transformErrorOut(makeHelmError(args));
}
