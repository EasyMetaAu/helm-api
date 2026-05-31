import { z } from "zod";

// Routing signal (POST-MVP Agentic Signals feedback layer). One aggregated,
// REDACTED observation rolled up by (task_type, lane) over a time window from
// already-persisted decision records. Single source of truth via z.infer.
//
// Principle 7: a signal carries ONLY non-sensitive aggregate dimensions —
// task_type / lane / status counts / latency / cost. NEVER a plaintext key, a
// user message, or any private payload. The aggregator reads decision records
// (themselves already redacted) and never touches raw request bodies.
//
// Principle 5: `fallbackRate` measures the EXECUTION fallback (in-chain model
// swap: more than one non-skipped provider attempt). It is NEVER conflated with
// the CLASSIFICATION fallback (classifier.decided_by → balanced); that lives in
// `classifierFallbackRate` so the two mechanisms stay separately observable.
//
// This task is OBSERVE-ONLY: signals are produced and persisted, never fed back
// into routing. The consumption side (influencing lane selection) is a future
// task — keeping the MVP route deterministic.
export const RoutingSignalSchema = z
  .object({
    taskType: z.string(),
    lane: z.string(),
    windowStart: z.number(), // epoch ms, inclusive
    windowEnd: z.number(), // epoch ms, exclusive
    samples: z.number().int().nonnegative(), // # decision records in the group
    successRate: z.number().min(0).max(1), // final.status === 'ok' share
    fallbackRate: z.number().min(0).max(1), // EXECUTION fallback share (in-chain swap)
    classifierFallbackRate: z.number().min(0).max(1), // CLASSIFICATION fallback share (→ balanced)
    errorRate: z.number().min(0).max(1), // final.status === 'error' share
    p50LatencyMs: z.number().nonnegative(),
    p95LatencyMs: z.number().nonnegative(),
    avgCostUsd: z.number().nullable(), // null when no record carried a cost
    updatedAt: z.number(), // epoch ms the signal was (re)computed
  })
  .strict();

export type RoutingSignal = z.infer<typeof RoutingSignalSchema>;
