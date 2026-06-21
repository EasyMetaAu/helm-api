import type { AttemptErrorDetail } from "@helm/shared";

// One row of the decision record's `provider_attempts` (docs/02). Field-for-field
// aligned with shared `ProviderAttemptSchema` so this array feeds it directly.
//
// Extracted from the former executor/fallback.ts: that module re-implemented the
// execution-fallback loop (`runFallback`) but was never wired into the gateway —
// the production loop lives in apps/gateway/src/routes/execute.ts and is covered
// by execute.test.ts. The duplicate was removed (review finding C1); this record
// type is the one piece the telemetry layer still shares, so it lives here.
export interface AttemptRecord {
  alias: string;
  skipped: boolean;
  skip_reason: string | null; // circuit_open | capability:<reason> | free_429 | ...
  status: "ok" | "error";
  error_class: string | null;
  latency_ms: number;
  cost_usd: number | null;
  // Upstream failure detail for THIS attempt (admin-debug-error-detail). Non-null
  // only for a genuine pre-first-chunk provider failure; null for ok/skipped rows.
  error_detail: AttemptErrorDetail | null;
}
