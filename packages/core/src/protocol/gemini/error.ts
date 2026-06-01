import { type ErrorClass, type HelmError, makeHelmError } from "@helm/shared";

// HelmError -> native Gemini error shape (docs/05 §errors are also translated into
// the client protocol's shape, docs/07). The outbound error half of the Gemini
// Protocol Adapter: a structured internal error becomes the wire envelope the
// Gemini SDK / REST client expects
//
//   { "error": { "code": <http_status>, "message": <text>, "status": <ENUM> } }
//
// `code` is the HTTP status integer; `status` is Google's canonical error enum
// (https://cloud.google.com/apis/design/errors). Pure function: zero network, zero
// framework (CLAUDE.md principle 1). The gateway NEVER hand-assembles an error — it
// hands a HelmError here and serializes the result. HTTP status comes from the
// shared ERROR_CLASS_HTTP_STATUS table (via makeHelmError) so the status and the
// body's `code` cannot drift. Reimplemented from the public Gemini docs.

// —— error_class -> Google canonical status enum. Google's set is narrower than
// Helm's 8 classes, so several map onto the same canonical status while the precise
// Helm class survives in the response trace_id / telemetry. Exhaustive over
// ErrorClass (compile error if a class is added). ——————————————————————————————————
const GEMINI_ERROR_STATUS: Record<ErrorClass, string> = {
  auth_error: "UNAUTHENTICATED",
  invalid_request: "INVALID_ARGUMENT",
  lane_unavailable: "UNAVAILABLE",
  all_providers_failed: "UNAVAILABLE",
  capability_unsatisfiable: "INVALID_ARGUMENT",
  upstream_error: "UNAVAILABLE",
  timeout: "DEADLINE_EXCEEDED",
  rate_limited: "RESOURCE_EXHAUSTED",
};

export interface GeminiErrorEnvelope {
  error: { code: number; message: string; status: string };
}

/**
 * Translate a HelmError into the native Gemini error envelope plus its HTTP status.
 * Pure. The message is assumed already-redacted by the producer (principle 7); this
 * function only re-shapes, never inspects payload.
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
 * Convenience: build a HelmError and translate it in one step. Used by the gateway's
 * auth / short-circuit / streaming-termination paths that have only a class +
 * message + trace_id.
 */
export function makeGeminiError(args: {
  error_class: ErrorClass;
  message: string;
  trace_id: string;
}): { status: number; body: GeminiErrorEnvelope } {
  return transformErrorOut(makeHelmError(args));
}
