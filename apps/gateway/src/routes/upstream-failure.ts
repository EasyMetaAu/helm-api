import { errorDetailOf } from "./execute.js";
import { buildImageDecision } from "./image-telemetry.js";
import { type RecordServedDeps, recordServed } from "./payload-capture.js";

/** Diagnostics for model-pinned utility calls and asynchronous task polling. */
export async function recordUpstreamFailure(
  deps: RecordServedDeps | undefined,
  input: {
    keyId: string;
    alias: string;
    model: string;
    operation: string;
    error: unknown;
    requestId?: string;
    traceId?: string;
  },
): Promise<void> {
  if (!deps) return;
  const requestId = input.requestId ?? crypto.randomUUID();
  const decision = buildImageDecision({
    requestId,
    traceId: input.traceId ?? requestId,
    keyPrefix: null,
    requested: input.model,
    selectedLane: input.operation,
    candidateChain: [input.alias],
    attempts: [
      {
        alias: input.alias,
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: "upstream_error",
        latency_ms: 0,
        cost_usd: null,
        error_detail: errorDetailOf(input.error),
      },
    ],
    served: null,
    finalErrorClass: "upstream_error",
    usage: null,
    policyReason: input.operation,
  });
  await recordServed(
    deps,
    {
      requestId,
      apiKeyId: input.keyId,
      decision,
      requestJson: "",
      responseJson: null,
      omitContent: true,
    },
    () => {},
  );
}
