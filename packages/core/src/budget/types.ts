import type { OverBudgetBehavior } from "@helm/shared";
import type { BudgetDim } from "../store/ports.js";

export type { OverBudgetBehavior };

// The per-key budget caps, resolved from the key record (docs/06 "usage budgets").
// Each cap is a number (the ceiling consumed over the rolling window) or null
// (no cap for that dimension). windowSeconds null => the system default window.
// degradeLane null => the system default degrade lane (economy).
export interface BudgetCaps {
  requests: number | null;
  tokens: number | null;
  spendUsd: number | null;
  windowSeconds: number | null;
  behavior: OverBudgetBehavior;
  degradeLane: string | null;
}

// System-wide budget defaults (the fallbacks for a key's null window / degrade
// lane). No global on/off switch: a key with no caps is a zero-touch fast path.
export interface BudgetConfig {
  defaultWindowSeconds: number;
  defaultDegradeLane: string;
}

// One pre-route gate decision. overBudget = at least one active dimension is
// exhausted. limitedBy = the first dimension that tripped (null when within
// budget). behavior + degradeLane describe what the caller should DO when over
// budget: "reject" => 429; "degrade" => cap the lane to degradeLane.
export interface BudgetCheckResult {
  overBudget: boolean;
  limitedBy: BudgetDim | null;
  behavior: OverBudgetBehavior;
  degradeLane: string | null;
}

// The actual served usage to settle post-request. requests is normally 1.
// costUsd null = "not measured" (pricing unknown) => settles 0 for the spend
// dimension (NEVER recomputed; D4-style auditable under-billing).
export interface BudgetUsage {
  requests: number;
  tokens: number;
  costUsd: number | null;
}
