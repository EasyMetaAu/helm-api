import type { DecisionRecord, TelemetryStore } from "@helm/core";

// Shared full request/response capture + streamed-cost backfill helpers, used by
// BOTH the OpenAI (chat.ts) and Anthropic (messages-pipeline.ts) routes.
//
// Capture is gated by the runtime setting `capture_payloads` (admin "System
// Settings", default ON). When off, nothing is written. The stored bodies are
// VERBATIM (not redacted) — they carry no plaintext API key because the bearer
// lives in the request's Authorization header, never in the chat body.
//
// Everything here is FAIL-OPEN: a capture or cost-backfill failure must never
// turn a served request into a 5xx or break an in-flight stream.

export interface PayloadCaptureDeps {
  telemetry: TelemetryStore;
  /** Live getter for the capture_payloads runtime setting. */
  capturePayloads?: () => boolean;
  /** Live getter for payload_retention_days expressed in ms (drives auto-prune). */
  payloadRetentionMs?: () => number;
  /** Cost of `usage` tokens at `alias`'s pricing, or null when pricing unknown.
   *  Closed over the catalog in the composition root. */
  costOf?: (alias: string, usage: StreamUsage) => number | null;
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export function captureEnabled(deps: PayloadCaptureDeps): boolean {
  return deps.capturePayloads?.() === true;
}

// Persist the verbatim request/response bodies + opportunistically prune expired
// rows. Never throws — logs via the provided sink on failure.
export async function persistPayload(
  deps: PayloadCaptureDeps,
  args: { requestId: string; requestJson: string; responseJson: string | null; now: number },
  log: (msg: string) => void,
): Promise<void> {
  if (!captureEnabled(deps)) return;
  try {
    await deps.telemetry.insertPayload({
      requestId: args.requestId,
      requestJson: args.requestJson,
      responseJson: args.responseJson,
      createdAt: new Date(args.now),
    });
    const retentionMs = deps.payloadRetentionMs?.();
    if (retentionMs && retentionMs > 0) {
      await deps.telemetry.prunePayloads(args.now - retentionMs);
    }
  } catch {
    log("payload.capture_failed");
  }
}

// Extract the OpenAI `usage` object from accumulated streaming SSE text. With
// `stream_options.include_usage` the upstream emits a final `data:` chunk that
// carries a top-level `usage`. Scan data lines last-to-first and return the first
// one that has it; null if the stream never reported usage. Non-JSON keepalive
// lines are skipped.
export function usageFromSSE(raw: string): StreamUsage | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as { usage?: unknown };
      if (obj && typeof obj === "object" && obj.usage && typeof obj.usage === "object") {
        return obj.usage as StreamUsage;
      }
    } catch {
      // keepalive / non-JSON line — ignore
    }
  }
  return null;
}

// Backfill the streamed completion cost onto the decision record IN PLACE (#6:
// streamed usage is unknown at peek time, so execute() recorded cost null). Sets
// the matching ok attempt's cost and the cost_breakdown completion/total. No-op
// when cost is null (pricing unknown / no usage) — the record keeps its honest
// "not measured" null rather than a misleading 0.
export function backfillCompletionCost(
  decision: DecisionRecord,
  alias: string | null,
  cost: number | null,
): void {
  if (cost === null) return;
  if (alias) {
    for (const a of decision.provider_attempts) {
      if (a.alias === alias && a.status === "ok") a.cost_usd = cost;
    }
  }
  const evalUsd = decision.cost_breakdown.eval_usd;
  decision.cost_breakdown.completion_usd = cost;
  decision.cost_breakdown.total_usd = (evalUsd ?? 0) + cost;
}
