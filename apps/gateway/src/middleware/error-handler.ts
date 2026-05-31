import {
  ERROR_CLASS_HTTP_STATUS,
  type ErrorClass,
  type HelmError,
  HelmErrorSchema,
} from "@helm/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";

// error_class -> OpenAI error shape (type/code). HTTP status comes from the
// shared ERROR_CLASS_HTTP_STATUS map (docs/07). Exhaustive over the enum.
const OPENAI_SHAPE: Record<ErrorClass, { type: string; code: string }> = {
  auth_error: { type: "invalid_request_error", code: "invalid_api_key" },
  invalid_request: { type: "invalid_request_error", code: "invalid_request" },
  lane_unavailable: { type: "api_error", code: "lane_unavailable" },
  all_providers_failed: { type: "api_error", code: "all_providers_failed" },
  capability_unsatisfiable: { type: "invalid_request_error", code: "capability_unsatisfiable" },
  upstream_error: { type: "api_error", code: "upstream_error" },
  timeout: { type: "api_error", code: "timeout" },
  rate_limited: { type: "rate_limit_error", code: "rate_limited" },
};

// Throwable wrapper so a structured HelmError survives Hono's onError (which
// only catches thrown Error instances, not plain objects). core/gateway code
// throws this; handleError unwraps it.
export class HelmHttpError extends Error {
  readonly helm: HelmError;
  constructor(helm: HelmError) {
    super(helm.message);
    this.name = "HelmHttpError";
    this.helm = helm;
  }
}

// Detect a client disconnect/abort — NOT a provider fault, not a 5xx (docs/02).
function isClientDisconnect(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.message.includes("aborted");
  }
  return false;
}

function asHelmError(err: unknown): HelmError | null {
  // Unwrap the throwable wrapper, or accept a bare HelmError-shaped object.
  const candidate = err instanceof HelmHttpError ? err.helm : err;
  const parsed = HelmErrorSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Serialize any thrown value into an OpenAI-shaped error response. HelmErrors map
// by their class; unknown errors fall back to upstream_error(502) without leaking
// stack/message detail. Always includes trace_id; logs one error line (redacted).
export function handleError(err: unknown, c: Context<AppEnv>): Response {
  const traceId = c.get("trace_id") ?? "unknown";
  const logger = c.get("logger");

  if (isClientDisconnect(err)) {
    // Client went away — do not map to 5xx, do not record a provider fault.
    logger.log("info", "request.client_disconnect", { trace_id: traceId });
    return c.body(null, 499 as ContentfulStatusCode);
  }

  const helm = asHelmError(err);
  const errorClass: ErrorClass = helm?.error_class ?? "upstream_error";
  const httpStatus = ERROR_CLASS_HTTP_STATUS[errorClass];
  const shape = OPENAI_SHAPE[errorClass];
  // Redacted, generic message for non-HelmError fallbacks (never leak raw text).
  const message = helm?.message ?? "internal error";

  logger.log("error", "request.error", {
    trace_id: traceId,
    error_class: errorClass,
    http_status: httpStatus,
  });

  return c.json(
    { error: { message, type: shape.type, code: shape.code, trace_id: traceId } },
    httpStatus as ContentfulStatusCode,
  );
}
