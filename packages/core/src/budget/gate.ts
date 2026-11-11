import type { BudgetDim, BudgetStore } from "../store/ports.js";
import type { BudgetCaps, BudgetCheckResult, BudgetConfig } from "./types.js";
import { WEEK_MS } from "./weekly.js";

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
  if (caps.weeklyAnchor != null) return WEEK_MS;
  return (caps.windowSeconds ?? config.defaultWindowSeconds) * 1000;
}

export interface BudgetProbe {
  keyId: string;
  caps: BudgetCaps;
  nowMs: number;
}

export interface BudgetGateDeps {
  store: Pick<BudgetStore, "peek" | "reserveRequest">;
  config: BudgetConfig;
}

const WITHIN_BUDGET: BudgetCheckResult = {
  overBudget: false,
  limitedBy: null,
  behavior: "degrade",
  degradeLane: null,
};

// Build the pre-route budget gate. core-only: pure logic + a Store port, no web
// framework (principle 1). The gate checks remaining balance per active
// dimension (peek remaining > 0) — it does NOT pre-estimate the request's cost,
// so a single in-flight request may push a bucket slightly negative, settled
// post-served (D5 tolerance, same as the rate limiter's token estimate). A key
// with no caps is a zero-touch fast path (no store read). FAIL-CLOSED boundary:
// a peek store error PROPAGATES (the middleware turns it into a 5xx), never a
// silent "within budget" pass. Returns the FIRST exhausted dimension; the caller
// decides what to do (degrade vs reject) from `behavior`. Weekly mode always
// rejects exhaustion and atomically reserves one request after all peeks pass.
export function createBudgetGate(deps: BudgetGateDeps): {
  check(probe: BudgetProbe): Promise<BudgetCheckResult>;
} {
  const { store, config } = deps;

  async function check(probe: BudgetProbe): Promise<BudgetCheckResult> {
    const dims = activeDims(probe.caps);
    if (dims.length === 0) return WITHIN_BUDGET; // zero-touch: no caps to enforce

    const windowMs = windowMsFor(probe.caps, config);
    const anchorMs =
      probe.caps.weeklyAnchor == null ? undefined : Date.parse(probe.caps.weeklyAnchor);
    const nowMs = anchorMs === undefined ? probe.nowMs : (probe.caps.admittedAtMs ?? probe.nowMs);
    for (const { dim, capacity } of dims) {
      const args = [probe.keyId, dim, capacity, windowMs, nowMs] as const;
      const r =
        anchorMs === undefined ? await store.peek(...args) : await store.peek(...args, anchorMs);
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
          behavior: anchorMs === undefined ? probe.caps.behavior : "reject",
          degradeLane: probe.caps.degradeLane ?? config.defaultDegradeLane,
        };
      }
    }
    if (anchorMs !== undefined && probe.caps.requests != null) {
      if (!store.reserveRequest) throw new Error("weekly request reservation unavailable");
      if (
        !(await store.reserveRequest(probe.keyId, probe.caps.requests, windowMs, nowMs, anchorMs))
      )
        return { overBudget: true, limitedBy: "req", behavior: "reject", degradeLane: null };
    }
    return WITHIN_BUDGET;
  }

  return { check };
}
