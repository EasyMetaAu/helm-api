import { type ErrorClass, type HelmError, makeHelmError } from "@helm/shared";

// HelmError -> native Google/Gemini error shape (docs/05 errors are translated
// into the client protocol's shape, docs/07). The outbound error half of the
// Gemini Protocol Adapter: a structured internal error becomes the wire envelope
// the Google GenAI SDK expects (the canonical google.rpc.Status shape)
//
//   { "error": { "code": <http_status>, "message": <text>, "status": <CANONICAL> } }
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). The gateway
// NEVER hand-assembles an error string — it hands a HelmError here and serializes
// the result. The numeric `code` and the HTTP status both come from
// err.http_status (the shared ERROR_CLASS_HTTP_STATUS table), so they cannot
// drift; `status` is the canonical google.rpc.Code name.

// —— error_class -> canonical Google status string (google.rpc.Code names). ——————
// Exhaustive over ErrorClass (compile error if a class is added). The precise Helm
// class survives in telemetry / trace_id even where several collapse onto INTERNAL.
const GEMINI_ERROR_STATUS: Record<ErrorClass, string> = {
  auth_error: "UNAUTHENTICATED",
  invalid_request: "INVALID_ARGUMENT",
  lane_unavailable: "UNAVAILABLE",
  all_providers_failed: "INTERNAL",
  capability_unsatisfiable: "FAILED_PRECONDITION",
  upstream_error: "INTERNAL",
  timeout: "DEADLINE_EXCEEDED",
  rate_limited: "RESOURCE_EXHAUSTED",
  client_abort: "CANCELLED", // google.rpc.Code for a caller-cancelled operation
};

export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Translate a HelmError into the native Gemini (google.rpc.Status) error envelope
 * plus its HTTP status. Pure. The message is assumed already-redacted by the
 * producer (principle 7); this function only re-shapes, never inspects payload.
 * The body's numeric `code` equals the HTTP status by Google convention.
 */
export function transformErrorOut(err: HelmError): {
  status: number;
  body: GeminiErrorEnvelope;
} {
  return {
    status: err.http_status,
    body: {
      error: {
        code: err.http_status,
        message: err.message,
        status: GEMINI_ERROR_STATUS[err.error_class],
      },
    },
  };
}

/**
 * Convenience: build a HelmError and translate it in one step. Used by the
 * gateway's auth/short-circuit paths that have only a class + message + trace_id.
 */
export function makeGeminiError(args: {
  error_class: ErrorClass;
  message: string;
  trace_id: string;
}): { status: number; body: GeminiErrorEnvelope } {
  return transformErrorOut(makeHelmError(args));
}
