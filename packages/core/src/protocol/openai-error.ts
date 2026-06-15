import { type ErrorClass, type HelmError, makeHelmError } from "@helm/shared";

// HelmError -> native OpenAI error shape (docs/05 errors are translated into the
// client protocol's shape, docs/07). The outbound error half of the OpenAI
// Protocol Adapter: a structured internal error becomes the wire envelope the
// OpenAI SDK expects
//
//   { "error": { "message": <text>, "type": <type>, "code": <code>,
//                "trace_id": <id> } }
//
// SINGLE SOURCE OF TRUTH: this is the one canonical OpenAI error mapping for the
// whole codebase. The gateway's Hono onError handler imports OPENAI_ERROR_SHAPE /
// transformErrorOut from here instead of defining its own table, so the wire
// contract cannot drift between the protocol layer and the gateway. `trace_id` is
// carried ON the wire deliberately (docs/07: restorable in the Debug UI) — it is
// not a secret; the redaction rule (principle 7) is about payload/keys, not the
// trace id.
//
// Pure function: zero network, zero framework (CLAUDE.md principle 1). HTTP status
// comes from the shared ERROR_CLASS_HTTP_STATUS table (via err.http_status) so the
// status and the body's type cannot drift.

// —— error_class -> OpenAI error.type + .code. Exhaustive over ErrorClass (compile
// error if a class is added). Mirrors OpenAI's documented `type` set
// (invalid_request_error / api_error / rate_limit_error) while the precise Helm
// class is preserved verbatim in `code` for debuggability. ————————————————————————
export const OPENAI_ERROR_SHAPE: Record<ErrorClass, { type: string; code: string }> = {
  auth_error: { type: "invalid_request_error", code: "invalid_api_key" },
  invalid_request: { type: "invalid_request_error", code: "invalid_request" },
  lane_unavailable: { type: "api_error", code: "lane_unavailable" },
  all_providers_failed: { type: "api_error", code: "all_providers_failed" },
  capability_unsatisfiable: { type: "invalid_request_error", code: "capability_unsatisfiable" },
  upstream_error: { type: "api_error", code: "upstream_error" },
  timeout: { type: "api_error", code: "timeout" },
  rate_limited: { type: "rate_limit_error", code: "rate_limited" },
  client_abort: { type: "api_error", code: "client_abort" },
};

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string;
    trace_id: string;
  };
}

/**
 * Translate a HelmError into the native OpenAI error envelope plus its HTTP
 * status. Pure. The message is assumed already-redacted by the producer
 * (principle 7); this function only re-shapes, never inspects payload.
 */
export function transformErrorOut(err: HelmError): {
  status: number;
  body: OpenAIErrorEnvelope;
} {
  const shape = OPENAI_ERROR_SHAPE[err.error_class];
  return {
    status: err.http_status,
    body: {
      error: {
        message: err.message,
        type: shape.type,
        code: shape.code,
        trace_id: err.trace_id,
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
