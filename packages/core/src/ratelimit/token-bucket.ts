// Pure-function token bucket. Capacity = the quota for a window; tokens refill
// linearly at capacity/windowMs. The window defaults to 60s (so rate limits stay
// "per minute"), but is configurable so the SAME math backs per-key usage budgets
// over a longer rolling window (e.g. capacity = spend cap, window = a day). State
// is immutable so a Store adapter can read, transform, and write it back
// atomically. No clock, no I/O — `nowMs` is always injected so refill/consume are
// deterministic and unit-testable (no real sleep).

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_WINDOW_MS = 60_000;

// Advance a bucket to `nowMs`, adding capacity/windowMs tokens per elapsed ms,
// clamped at `capacity`. Going backwards in time (clock skew) never removes
// tokens. capacity <= 0 is treated as "no refill needed" by the caller (unlimited
// dimensions skip the bucket entirely), but is handled here defensively by
// returning the state unchanged. `windowMs` defaults to 60s (rate-limit semantics).
export function refill(
  state: BucketState,
  capacity: number,
  nowMs: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): BucketState {
  if (capacity <= 0) return { ...state, lastRefillMs: nowMs };
  const elapsed = nowMs - state.lastRefillMs;
  if (elapsed <= 0) return state;
  const refilled = (elapsed / windowMs) * capacity;
  const tokens = Math.min(capacity, state.tokens + refilled);
  return { tokens, lastRefillMs: nowMs };
}

// Seconds until the bucket would gain one more whole unit of capacity (used for
// x-ratelimit-reset / retry-after). 0 when the dimension never refills. From a
// fractional level it is the time to reach the next integer; from a whole level
// it is the time to accrue one full unit. Refill rate is capacity per windowMs.
function secondsToNextUnit(tokens: number, capacity: number, windowMs: number): number {
  if (capacity <= 0) return 0;
  const frac = tokens - Math.floor(tokens);
  const need = frac === 0 ? 1 : 1 - frac; // tokens to the next integer
  const perSecond = capacity / (windowMs / 1000);
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
  capacity: number,
  cost: number,
  nowMs: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): ConsumeResult {
  const refilled = refill(state, capacity, nowMs, windowMs);
  if (refilled.tokens >= cost) {
    const next = { tokens: refilled.tokens - cost, lastRefillMs: refilled.lastRefillMs };
    return {
      state: next,
      ok: true,
      remaining: Math.max(0, Math.floor(next.tokens)),
      resetSeconds: secondsToNextUnit(next.tokens, capacity, windowMs),
    };
  }
  return {
    state: refilled,
    ok: false,
    remaining: Math.max(0, Math.floor(refilled.tokens)),
    resetSeconds: secondsToNextUnit(refilled.tokens, capacity, windowMs),
  };
}
