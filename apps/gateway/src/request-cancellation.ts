export const CONCURRENCY_LEASE_LOST_REASON = "concurrency_lease_lost" as const;
export const REQUEST_TIMEOUT_REASON = "request_timeout" as const;

export type RequestCancellationReason =
  | "client_abort"
  | typeof REQUEST_TIMEOUT_REASON
  | typeof CONCURRENCY_LEASE_LOST_REASON;

export function requestCancellationReason(signal: AbortSignal): RequestCancellationReason | null {
  if (!signal.aborted) return null;
  if (signal.reason === CONCURRENCY_LEASE_LOST_REASON) return CONCURRENCY_LEASE_LOST_REASON;
  if (signal.reason === REQUEST_TIMEOUT_REASON) return REQUEST_TIMEOUT_REASON;
  return "client_abort";
}
