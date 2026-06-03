import type { BudgetStore } from "../store/ports.js";
import { activeDims, windowMsFor } from "./gate.js";
import type { BudgetCaps, BudgetConfig, BudgetUsage } from "./types.js";

export interface SettleBudgetDeps {
  store: Pick<BudgetStore, "debit">;
  config: BudgetConfig;
}

// Post-served budget settle (fail-OPEN side; the CALLER wraps this so a store
// failure is logged, never 5xx's a request that already completed). Debits the
// ACTUAL served usage into each active dimension's bucket. Spend uses the SAME
// settled cost the telemetry pipeline computed — NEVER recomputed (single source
// of truth); a null cost ("not measured", pricing unknown) settles 0 so an
// under-priced request is auditable rather than blocking. Only active (capped)
// dimensions are touched, so the bucket table stays sparse for uncapped keys.
export async function settleBudget(
  deps: SettleBudgetDeps,
  keyId: string,
  caps: BudgetCaps,
  usage: BudgetUsage,
  nowMs: number,
): Promise<void> {
  const dims = activeDims(caps);
  if (dims.length === 0) return;
  const windowMs = windowMsFor(caps, deps.config);

  for (const { dim, capacity } of dims) {
    const amount =
      dim === "req" ? usage.requests : dim === "tok" ? usage.tokens : (usage.costUsd ?? 0);
    await deps.store.debit(keyId, dim, capacity, windowMs, amount, nowMs);
  }
}
