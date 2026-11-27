import {
  type DecisionRecord,
  nextSSEFrameBoundary,
  preOutputClassifierFor,
  streamErrorFromData,
  UpstreamError,
} from "@helm/core";
import type { Protocol } from "@helm/shared";
import { errorDetailOf } from "./routes/execute.js";

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

export function markStartedStreamError(
  decision: DecisionRecord,
  errorReason: string,
  error?: unknown,
): void {
  const detail = error === undefined ? decision.final.error_detail : errorDetailOf(error);
  const attempt = decision.provider_attempts?.findLast((a) => !a.skipped);
  if (attempt) {
    if (detail) attempt.error_detail = detail;
  }
  decision.stream_outcome = "failed";
  decision.final = {
    ...decision.final,
    status: "error",
    error_reason: errorReason,
    ...(detail ? { error_detail: detail } : {}),
  };
}

/** Observe bounded SSE frames without changing the bytes or replaying committed work. */
export function createSSEErrorObserver(
  protocol: Protocol,
  onError: (error: UpstreamError) => void,
) {
  let pending = "";
  let discarding = false;
  const classifier = preOutputClassifierFor(protocol);
  return (chunk: string): void => {
    pending += chunk;
    let boundary = nextSSEFrameBoundary(pending);
    while (boundary) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.length);
      if (!discarding && frame.length <= 65536) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (classifier?.classify(data) === "error") {
          onError(streamErrorFromData(classifier, data));
        } else if (protocol === "gemini") {
          try {
            const raw: unknown = JSON.parse(data);
            if (raw && typeof raw === "object" && "error" in raw && raw.error) {
              onError(
                new UpstreamError("upstream_error", "upstream stream error", { error: raw.error }),
              );
            }
          } catch {
            /* Non-JSON events do not provide error evidence. */
          }
        }
      }
      discarding = false;
      boundary = nextSSEFrameBoundary(pending);
    }
    if (pending.length > 65536) {
      pending = pending.slice(-3);
      discarding = true;
    }
  };
}

/** The provider executor supplies credential-scrubbed diagnostics out of band. */
export function createStreamErrorObserver(decision: DecisionRecord, _protocol: Protocol) {
  return (_chunk: string) => {
    const detail = decision.provider_attempts?.findLast((a) => !a.skipped)?.error_detail;
    if (!detail) return;
    decision.final.error_detail = detail;
    markStartedStreamError(decision, "upstream_error");
  };
}
