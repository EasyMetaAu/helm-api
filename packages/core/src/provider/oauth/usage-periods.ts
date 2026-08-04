import type { OAuthQuotaWindow, OAuthUsageBucket, OAuthUsagePeriod } from "@helm/shared";
import { windowMinutesForKey } from "./window-minutes.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ComputeUsagePeriodsInput {
  // The account's current quota windows (each names a reset cadence: 5h / 7d / ...).
  windows: OAuthQuotaWindow[];
  // The account's raw hour buckets over [dataStartMs, nowMs), any order.
  buckets: OAuthUsageBucket[];
  nowMs: number;
  // Oldest instant with trustworthy data (max of retention floor and earliest bucket).
  // A period starting before this is `partial` (it undercounts); rollback stops once a
  // period ends at/under it.
  dataStartMs: number;
  // Max historical periods to roll back per window.
  limit: number;
}

// A period's boundary is "exact" only when it comes from a real upstream resetsAtMs
// AND lands on an hour floor — because usage lives in whole UTC-hour buckets, a
// mid-hour boundary can mis-bin up to one hour of tokens on each side, so those
// totals are approximate too (grok review: current mustn't claim exactness it lacks).
function isHourAligned(ms: number): boolean {
  return ms % HOUR_MS === 0;
}

export interface UsagePeriodsResult {
  current: OAuthUsagePeriod[];
  periods: OAuthUsagePeriod[];
}

// Sum tokens/requests/cost over the half-open [startMs, endMs) hour buckets. Cost is
// null-aware: null only when EVERY overlapping bucket is unpriced (a measured value —
// even 0 — makes the total concrete), mirroring the SQL SUM(cost_usd) contract.
function sumWindow(
  buckets: OAuthUsageBucket[],
  startMs: number,
  endMs: number,
): { requests: number; tokens: number; costUsd: number | null } {
  let requests = 0;
  let tokens = 0;
  let cost = 0;
  let anyPriced = false;
  for (const b of buckets) {
    if (b.bucketMs < startMs || b.bucketMs >= endMs) continue;
    requests += b.requests;
    tokens += b.tokens;
    if (b.costUsd !== null) {
      cost += b.costUsd;
      anyPriced = true;
    }
  }
  return { requests, tokens, costUsd: anyPriced ? cost : null };
}

// Reconstruct per-reset-period usage for each anchorable window. Token totals are
// exact; only historical BOUNDARIES are approximate (rolled back a fixed window
// length from the current resetsAtMs — the quota snapshot keeps no boundary history).
// The current in-progress period uses the real upstream resetsAtMs (approximate:false).
export function computeUsagePeriods(input: ComputeUsagePeriodsInput): UsagePeriodsResult {
  const { windows, buckets, nowMs, dataStartMs, limit } = input;
  const current: OAuthUsagePeriod[] = [];
  const periods: OAuthUsagePeriod[] = [];

  for (const w of windows) {
    // Need a real reset instant to anchor the period grid, and a resolvable window
    // length. Either missing → the window can't be sliced (skip; the UI shows "—").
    if (w.resetsAtMs === null) continue;
    const winMinutes = windowMinutesForKey(w.key, w.windowMinutes);
    if (winMinutes === null) continue;
    const winMs = winMinutes * MINUTE_MS;

    // The quota snapshot can be STALE: resetsAtMs may already be in the past (Anthropic
    // 5h windows reset often; this page is cache-only, no live pull). Naively that
    // labels an already-FINISHED window as "current" and drops all post-reset traffic.
    // Advance the boundary by whole windows until it is in the future, so `reset` is
    // the next real reset and [reset-winMs, reset) is the genuinely in-progress period.
    // A boundary we had to advance is no longer a confirmed upstream instant → the
    // period it anchors is approximate (grok review R1-1).
    let reset = w.resetsAtMs;
    let boundaryAdvanced = false;
    if (reset <= nowMs) {
      const steps = Math.floor((nowMs - reset) / winMs) + 1;
      reset += steps * winMs;
      boundaryAdvanced = true;
    }

    // Current: [reset - winMs, reset). Cap the end at now so an in-progress period
    // never claims future buckets (there are none, but keep the span honest).
    const curStart = reset - winMs;
    const curEnd = Math.min(reset, nowMs);
    // Exact only if the boundary is a confirmed upstream reset AND hour-aligned (else
    // hour-bucket quantization makes the totals approximate — see isHourAligned).
    const curExact = !boundaryAdvanced && isHourAligned(reset) && isHourAligned(curStart);
    if (curEnd > curStart) {
      const sums = sumWindow(buckets, curStart, curEnd);
      current.push({
        windowKey: w.key,
        periodStartMs: curStart,
        periodEndMs: curEnd,
        ...sums,
        approximate: !curExact,
        partial: curStart < dataStartMs,
      });
    }

    // History: roll back whole windows from `curStart` (the current period's start),
    // so the newest historical period sits immediately before the current one and
    // never overlaps it. Each period is [end - winMs, end). Always approximate — the
    // boundary is rolled back, not a confirmed reset event.
    for (let k = 1; k <= limit; k++) {
      const end = curStart - (k - 1) * winMs; // k==1 → ends where current begins
      const start = end - winMs;
      if (end <= dataStartMs) break; // fully older than retained data — stop
      const sums = sumWindow(buckets, start, end);
      periods.push({
        windowKey: w.key,
        periodStartMs: start,
        periodEndMs: end,
        ...sums,
        approximate: true, // boundary rolled back, not a real reset event
        partial: start < dataStartMs,
      });
    }
  }

  return { current, periods };
}
