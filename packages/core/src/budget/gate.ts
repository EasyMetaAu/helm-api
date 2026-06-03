import type { BudgetDim, BudgetStore } from "../store/ports.js";
import type { BudgetCaps, BudgetCheckResult, BudgetConfig } from "./types.js";

// The active (capped) budget dimensions for a key. A dimension is active only
// when its cap is a positive number. null means "no cap" (the schema rejects 0 and
// negatives, so a cap is always strictly positive); the `> 0` guard is defensive
// against a legacy/hand-edited row, and skips the store entirely for uncapped dims.
export function activeDims(caps: BudgetCaps): Array<{ dim: BudgetDim; capacity: number }> {
  const out: Array<{ dim: BudgetDim; capacity: number }> = [];
  if (caps.requests !== null && caps.requests > 0)
    out.push({ dim: "req", capacity: caps.requests });
  if (caps.tokens !== null && caps.tokens > 0) out.push({ dim: "tok", capacity: caps.tokens });
  if (caps.spendUsd !== null && caps.spendUsd > 0)
    out.push({ dim: "usd", capacity: caps.spendUsd });
  return out;
}

export function windowMsFor(caps: BudgetCaps, config: BudgetConfig): number {
  return (caps.windowSeconds ?? config.defaultWindowSeconds) * 1000;
}

export interface BudgetProbe {
  keyId: string;
  caps: BudgetCaps;
  nowMs: number;
}

export interface BudgetGateDeps {
  store: Pick<BudgetStore, "peek">;
  config: BudgetConfig;
}

const WITHIN_BUDGET: BudgetCheckResult = {
  overBudget: false,
  limitedBy: null,
  behavior: "degrade",
  degradeLane: null,
};

// Build the pre-route budget gate. core-only: pure logic + a Store port, no web
// framework (principle 1). The gate does a PURE BALANCE SIGN CHECK per active
// dimension (peek remaining > 0) — it does NOT pre-estimate the request's cost,
// so a single in-flight request may push a bucket slightly negative, settled
// post-served (D5 tolerance, same as the rate limiter's token estimate). A key
// with no caps is a zero-touch fast path (no store read). FAIL-CLOSED boundary:
// a peek store error PROPAGATES (the middleware turns it into a 5xx), never a
// silent "within budget" pass. Returns the FIRST exhausted dimension; the caller
// decides what to do (degrade vs reject) from `behavior`.
export function createBudgetGate(deps: BudgetGateDeps): {
  check(probe: BudgetProbe): Promise<BudgetCheckResult>;
} {
  const { store, config } = deps;

  async function check(probe: BudgetProbe): Promise<BudgetCheckResult> {
    const dims = activeDims(probe.caps);
    if (dims.length === 0) return WITHIN_BUDGET; // zero-touch: no caps to enforce

    const windowMs = windowMsFor(probe.caps, config);
    for (const { dim, capacity } of dims) {
      const r = await store.peek(probe.keyId, dim, capacity, windowMs, probe.nowMs);
      // Over-budget threshold differs by dimension. req/tok are DISCRETE units, so
      // "over" means you can't afford even ONE more unit (remaining < 1) — without
      // this, the rolling window's continuous micro-refill leaves a positive epsilon
      // right after exhaustion and a budget of N would let N+1 through. usd is
      // FRACTIONAL and settled post-served (cost unknown pre-request, D5), so it
      // stays a pure sign check (remaining <= 0): one in-flight request may push it
      // slightly negative, then subsequent requests are over.
      const overBudget = dim === "usd" ? r.remaining <= 0 : r.remaining < 1;
      if (overBudget) {
        return {
          overBudget: true,
          limitedBy: dim,
          behavior: probe.caps.behavior,
          degradeLane: probe.caps.degradeLane ?? config.defaultDegradeLane,
        };
      }
    }
    return WITHIN_BUDGET;
  }

  return { check };
}
