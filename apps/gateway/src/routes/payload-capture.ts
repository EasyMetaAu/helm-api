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
  /** Resolve the served attempt's USD cost from the trailing usage chunk: an
   *  upstream-BILLED cost in it (`cost_usd` / OpenRouter `cost`) OVERRIDES the
   *  catalog estimate, else tokens × `alias`'s pricing; null when neither is
   *  available. Closed over the catalog + resolveCostUsd in the composition root. */
  costOf?: (alias: string, usage: StreamUsage) => number | null;
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Upstream-billed cost, when the relay reports it in the usage chunk. OpenRouter
   *  uses `cost`; others `cost_usd`. resolveCostUsd prefers these over the estimate. */
  cost?: number;
  cost_usd?: number;
}

export function captureEnabled(deps: PayloadCaptureDeps): boolean {
  return deps.capturePayloads?.() === true;
}

export interface RecordServedDeps extends PayloadCaptureDeps {
  /** Redactor for the decision before it is persisted to telemetry (never store a
   *  plaintext key / secret). Same redactor the chat route uses. */
  redact: (decision: DecisionRecord) => DecisionRecord;
  now: () => number;
}

// Record ONE served request: the telemetry row (always — this is what makes the
// request appear in /admin/requests) plus the verbatim request/response payload
// (gated by capture_payloads). Shared by the three pipeline faces (/v1/responses,
// /v1/messages, gemini) so the recording logic can never drift between them again.
// Fully FAIL-OPEN: a telemetry/payload failure must never turn a served response
// into a 5xx or break a stream.
export async function recordServed(
  deps: RecordServedDeps,
  args: {
    requestId: string;
    apiKeyId: string;
    decision: DecisionRecord;
    requestJson: string;
    responseJson: string | null;
  },
  log: (msg: string) => void,
): Promise<void> {
  await persistPayload(
    deps,
    {
      requestId: args.requestId,
      requestJson: args.requestJson,
      responseJson: args.responseJson,
      now: deps.now(),
    },
    log,
  );
  try {
    await deps.telemetry.insert({
      decision: deps.redact(args.decision),
      apiKeyId: args.apiKeyId,
      createdAt: new Date(deps.now()),
    });
  } catch {
    log("telemetry.insert_failed");
  }
}

// Total served tokens (prompt + completion) from an OpenAI-style usage object, for
// the per-key token budget (docs/06). Tolerant of a missing/partial usage: a field
// absent counts as 0. Used by every face's post-served budget settle — the usage
// always rides the UPSTREAM OpenAI stream/body, so one extractor serves all.
export function tokensFromUsage(usage: StreamUsage | null | undefined): number {
  if (!usage) return 0;
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

// Extract the OpenAI `usage` object from a NON-streaming response body (the
// assembled chat.completion / equivalent). Mirrors usageFromSSE for the buffered
// path. null when the body has no usage object.
export function usageFromBody(body: unknown): StreamUsage | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (usage && typeof usage === "object") return usage as StreamUsage;
  return null;
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
