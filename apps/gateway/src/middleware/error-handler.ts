import { makeOpenAIError, openaiTransformErrorOut } from "@helm/core";
import { type ErrorClass, type HelmError, HelmErrorSchema } from "@helm/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";

// The OpenAI error wire shape (type/code/status) lives in ONE place —
// @helm/core's openai-error transformer (OPENAI_ERROR_SHAPE) — so the gateway's
// onError response and the protocol-layer renderer cannot drift. This handler
// only adds gateway concerns: client-disconnect handling, logging, and the
// redacted fallback for non-HelmError throws (docs/07).

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

  // Render via the canonical OpenAI transformer. A real HelmError renders
  // directly; a non-HelmError throw falls back to a redacted upstream_error so we
  // never leak raw stack/message text. trace_id is always the request's trace_id.
  const { status, body } = helm
    ? openaiTransformErrorOut({ ...helm, trace_id: traceId })
    : makeOpenAIError({
        error_class: "upstream_error",
        message: "internal error",
        trace_id: traceId,
      });

  logger.log("error", "request.error", {
    trace_id: traceId,
    error_class: errorClass,
    http_status: status,
  });

  return c.json(body, status as ContentfulStatusCode);
}
