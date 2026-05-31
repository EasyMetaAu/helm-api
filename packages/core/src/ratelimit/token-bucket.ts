// Pure-function token bucket. Capacity = the quota (rpm or tpm); tokens refill
// linearly at capacity/60s. State is immutable so a Store adapter can read,
// transform, and write it back atomically. No clock, no I/O — `nowMs` is always
// injected so refill/consume are deterministic and unit-testable (no real sleep).

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

// Advance a bucket to `nowMs`, adding capacity/60000 tokens per elapsed ms,
// clamped at `capacityPerMin`. Going backwards in time (clock skew) never
// removes tokens. capacityPerMin <= 0 is treated as "no refill needed" by the
// caller (unlimited dimensions skip the bucket entirely), but is handled here
// defensively by returning the state unchanged.
export function refill(state: BucketState, capacityPerMin: number, nowMs: number): BucketState {
  if (capacityPerMin <= 0) return { ...state, lastRefillMs: nowMs };
  const elapsed = nowMs - state.lastRefillMs;
  if (elapsed <= 0) return state;
  const refilled = (elapsed / 60_000) * capacityPerMin;
  const tokens = Math.min(capacityPerMin, state.tokens + refilled);
  return { tokens, lastRefillMs: nowMs };
}

// Seconds until the bucket would gain one more whole unit of capacity (used for
// x-ratelimit-reset / retry-after). 0 when the dimension never refills. From a
// fractional level it is the time to reach the next integer; from a whole level
// it is the time to accrue one full unit.
function secondsToNextUnit(tokens: number, capacityPerMin: number): number {
  if (capacityPerMin <= 0) return 0;
  const frac = tokens - Math.floor(tokens);
  const need = frac === 0 ? 1 : 1 - frac; // tokens to the next integer
  const perSecond = capacityPerMin / 60;
  return Math.ceil(need / perSecond);
}

export interface ConsumeResult {
  state: BucketState;
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

// Refill to `nowMs`, then try to take `cost` tokens. On success returns the
// debited state; on failure returns the (refilled) state untouched by the cost.
// `remaining` is floored to a whole token for header reporting.
export function tryConsume(
  state: BucketState,
  capacityPerMin: number,
  cost: number,
  nowMs: number,
): ConsumeResult {
  const refilled = refill(state, capacityPerMin, nowMs);
  if (refilled.tokens >= cost) {
    const next = { tokens: refilled.tokens - cost, lastRefillMs: refilled.lastRefillMs };
    return {
      state: next,
      ok: true,
      remaining: Math.max(0, Math.floor(next.tokens)),
      resetSeconds: secondsToNextUnit(next.tokens, capacityPerMin),
    };
  }
  return {
    state: refilled,
    ok: false,
    remaining: Math.max(0, Math.floor(refilled.tokens)),
    resetSeconds: secondsToNextUnit(refilled.tokens, capacityPerMin),
  };
}
