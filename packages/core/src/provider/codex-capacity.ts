import { UpstreamError } from "./openai.js";
import { type OverloadRetryBudget, waitForOverloadRetry } from "./retry.js";

const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
const CAPACITY_BACKOFF_MS = [1_000, 3_000, 5_000] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Only call at the Codex pre-output boundary. A message in a fetch exception,
// successful output, or post-send outcome-unknown envelope is not a rejection.
export function isCodexCapacityRejection(error: unknown): error is UpstreamError {
  if (!(error instanceof UpstreamError) || error.errorClass !== "upstream_error") return false;
  if (error.upstreamStatus !== null && ![429, 503, 529].includes(error.upstreamStatus))
    return false;
  let raw = record(error.providerRaw);
  if (error.upstreamStatus === 429 && record(raw?.body)) raw = record(raw?.body);
  if (error.upstreamStatus === null && raw?.type !== "error" && raw?.type !== "response.failed")
    return false;
  const candidate = record(raw?.error) ?? record(record(raw?.response)?.error);
  if (candidate?.message !== CAPACITY_MESSAGE) return false;
  if (
    candidate.type !== undefined &&
    candidate.type !== null &&
    !["server_error", "service_unavailable_error", "rate_limit_error"].includes(
      String(candidate.type),
    )
  )
    return false;
  // Codes with auth/quota/request semantics must not be overridden by prose.
  const code = candidate.code;
  return (
    code === undefined ||
    code === null ||
    ["server_is_overloaded", "service_unavailable", "rate_limit_exceeded"].includes(String(code))
  );
}

export class CodexCapacityRetryExhaustedError extends UpstreamError {
  constructor(error: UpstreamError, retries: number, accountUnavailable = false) {
    const message = `${CAPACITY_MESSAGE} Retried ${retries} times on the same account. ${accountUnavailable ? "That account is now unavailable. " : ""}Try another account manually.`;
    super(
      "upstream_error",
      message,
      {
        error: { type: "server_error", code: "codex_model_capacity_exhausted", message },
        retry_count: retries,
        advice: "switch_account",
        upstream: error.providerRaw,
      },
      error.upstreamStatus,
      error.upstreamHeaders,
      error,
    );
    this.name = "CodexCapacityRetryExhaustedError";
  }
}

export async function waitForCodexCapacityRetry(
  error: UpstreamError,
  budget: OverloadRetryBudget,
  signal?: AbortSignal,
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  if (
    !(await waitForOverloadRetry(budget, {
      reason: "codex_model_capacity",
      signal,
      sleep,
      retryAfter: error.upstreamHeaders?.["retry-after"],
      backoffMs: CAPACITY_BACKOFF_MS,
    }))
  )
    throw new CodexCapacityRetryExhaustedError(error, budget.attempt);
}
