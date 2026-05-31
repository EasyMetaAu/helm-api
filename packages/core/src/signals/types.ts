import type { DecisionRecord, RoutingSignal } from "@helm/shared";

// Agentic Signals — POST-MVP low-cost production-feedback layer (docs/02
// telemetry; research-notes「Plano」). A signal is an aggregated, REDACTED
// observation rolled up by (task_type, lane) over a time window, distilled
// ASYNCHRONOUSLY from already-persisted decision records. It NEVER adds latency
// to the main request path and (this task) NEVER feeds back into routing —
// observe-only. The consumption side is a future task.
//
// Zod is the single source of truth (CLAUDE.md): RoutingSignal is z.infer'd in
// @helm/shared; we re-export it here so signals code reads one local type.
export type { RoutingSignal } from "@helm/shared";

// The ONLY input to signal production: one already-persisted, redacted decision
// record. Read-only — the aggregator reads aggregate dimensions, never plaintext
// keys or private payloads (principle 7).
export type SignalDecisionRecord = DecisionRecord;

// A re-export for downstream signal modules that want the local alias.
export type { DecisionRecord } from "@helm/shared";

// Convenience: the shape used internally while folding records into a signal.
export type SignalAccumulator = Pick<RoutingSignal, "taskType" | "lane">;
