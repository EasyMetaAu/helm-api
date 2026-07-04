import type { OAuthQuotaWindow } from "@helm/shared";

// Usage-limit detection (auto-park). When an OAuth account's rate-limit window
// saturates, the account is parked out of the scheduling pool until the window
// resets. These are the shared thresholds + the pure predicate every detection site
// funnels through, so "what counts as limited" lives in ONE place.

// A window counts as exhausted at 100% used — the parsers clamp usedPercent to
// [0,100], so 100 is the saturation ceiling. Starting strict avoids parking an
// account that is still serving at 99%.
export const LIMIT_THRESHOLD = 100;

// After a real 429 has already parked an account, use a slightly softer threshold
// to identify the active provider window. Anthropic's usage endpoint can report the
// 5h window as 98-99% while the account is already hard-limited, so exact 100% would
// leave the account on the generic 60s fallback.
export const ACTIVE_LIMIT_RECOVERY_THRESHOLD = 95;

// Fallback cooldown for a 429 that carries no reset hint: short, so a transient 429
// self-heals quickly and we re-probe rather than parking for hours on an ambiguous
// signal. The precise (long) cooldown comes from the quota-window path when present.
export const DEFAULT_429_COOLDOWN_MS = 60_000;

// Anthropic scoped weekly model windows are named `7d-<model>` (for example
// `7d-fable` / `7d-sonnet`). They mean "this model is capped", not "the whole
// account is capped"; only account-wide windows may park the account globally.
export function isAccountWideQuotaWindow(window: OAuthQuotaWindow): boolean {
  return !window.key.startsWith("7d-");
}

// The cooldown end implied by a set of rate-limit windows, or null when none is
// exhausted. Returns the LATEST future reset among saturated windows: while ANY
// saturated window is still active the account stays limited, so un-parking must
// wait for the last one to free. PURE — a saturated window with no future reset
// cannot bound a cooldown and is ignored (the 429 path supplies the fallback).
export function windowsToUsageLimit(windows: OAuthQuotaWindow[], nowMs: number): number | null {
  let until: number | null = null;
  for (const w of windows) {
    if (!isAccountWideQuotaWindow(w)) continue;
    if (w.usedPercent < LIMIT_THRESHOLD) continue;
    if (w.resetsAtMs === null || w.resetsAtMs <= nowMs) continue;
    if (until === null || w.resetsAtMs > until) until = w.resetsAtMs;
  }
  return until;
}

// Recovery time for an account that is ALREADY parked by a real upstream 429. This
// is deliberately softer than windowsToUsageLimit: it must not pre-park a healthy
// 98% account, but once the account is known limited, the near-full window gives a
// better cooldown than the generic 60s fallback. Choose the nearest future reset
// because subscription UIs surface one active limiter at a time.
export function windowsToActiveUsageRecovery(
  windows: OAuthQuotaWindow[],
  nowMs: number,
): number | null {
  let until: number | null = null;
  for (const w of windows) {
    if (!isAccountWideQuotaWindow(w)) continue;
    if (w.usedPercent < ACTIVE_LIMIT_RECOVERY_THRESHOLD) continue;
    if (w.resetsAtMs === null || w.resetsAtMs <= nowMs) continue;
    if (until === null || w.resetsAtMs < until) until = w.resetsAtMs;
  }
  return until;
}
