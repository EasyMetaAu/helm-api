import type { OAuthQuotaWindow } from "@helm/shared";

// Usage-limit detection (auto-park). When an OAuth account's rate-limit window
// saturates, the account is parked out of the scheduling pool until the window
// resets. These are the shared thresholds + the pure predicate every detection site
// funnels through, so "what counts as limited" lives in ONE place.

// A window counts as exhausted at 100% used — the parsers clamp usedPercent to
// [0,100], so 100 is the saturation ceiling. Starting strict avoids parking an
// account that is still serving at 99%.
export const LIMIT_THRESHOLD = 100;

// Fallback cooldown for a 429 that carries no reset hint: short, so a transient 429
// self-heals quickly and we re-probe rather than parking for hours on an ambiguous
// signal. The precise (long) cooldown comes from the quota-window path when present.
export const DEFAULT_429_COOLDOWN_MS = 60_000;

// The cooldown end implied by a set of rate-limit windows, or null when none is
// exhausted. Returns the LATEST future reset among saturated windows: while ANY
// saturated window is still active the account stays limited, so un-parking must
// wait for the last one to free. PURE — a saturated window with no future reset
// cannot bound a cooldown and is ignored (the 429 path supplies the fallback).
export function windowsToUsageLimit(windows: OAuthQuotaWindow[], nowMs: number): number | null {
  let until: number | null = null;
  for (const w of windows) {
    if (w.usedPercent < LIMIT_THRESHOLD) continue;
    if (w.resetsAtMs === null || w.resetsAtMs <= nowMs) continue;
    if (until === null || w.resetsAtMs > until) until = w.resetsAtMs;
  }
  return until;
}
