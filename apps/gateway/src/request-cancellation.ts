import type { DecisionRecord } from "@helm/core";

export const CONCURRENCY_LEASE_LOST_REASON = "concurrency_lease_lost" as const;
export const REQUEST_TIMEOUT_REASON = "request_timeout" as const;

export type RequestCancellationReason =
  | "client_abort"
  | typeof REQUEST_TIMEOUT_REASON
  | typeof CONCURRENCY_LEASE_LOST_REASON;

export function requestCancellationReason(
  signal: AbortSignal,
  caught?: unknown,
): RequestCancellationReason | null {
  if (signal.aborted) {
    if (signal.reason === CONCURRENCY_LEASE_LOST_REASON) return CONCURRENCY_LEASE_LOST_REASON;
    if (signal.reason === REQUEST_TIMEOUT_REASON) return REQUEST_TIMEOUT_REASON;
    return "client_abort";
  }
  return caught instanceof Error &&
    (caught.name === "AbortError" || caught.message.includes("aborted"))
    ? "client_abort"
    : null;
}

export function markStartedStreamCancellation(
  decision: DecisionRecord,
  reason: RequestCancellationReason,
): void {
  const streamOutcome =
    reason === CONCURRENCY_LEASE_LOST_REASON
      ? "truncated"
      : reason === REQUEST_TIMEOUT_REASON
        ? "failed"
        : "client_aborted";
  decision.stream_outcome = streamOutcome;
  decision.final = {
    ...decision.final,
    status: "error",
    error_reason: reason === REQUEST_TIMEOUT_REASON ? "timeout" : reason,
  };
}
