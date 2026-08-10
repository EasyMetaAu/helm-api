import type {
  OAuthQuotaWindow,
  OAuthResetPeriod,
  OAuthUsageBucket,
  OAuthUsagePeriod,
} from "@helm/shared";
import { windowMinutesForKey } from "./window-minutes.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const RESET_JITTER_MS = 30 * MINUTE_MS;

export function detectQuotaResetPeriods(input: {
  providerId: string;
  account: string;
  previous: OAuthQuotaWindow[];
  next: OAuthQuotaWindow[];
  observedAtMs: number;
}): OAuthResetPeriod[] {
  const oldByKey = new Map(input.previous.map((window) => [window.key, window] as const));
  const periods: OAuthResetPeriod[] = [];

  for (const next of input.next) {
    const previous = oldByKey.get(next.key);
    if (previous?.resetsAtMs == null || next.resetsAtMs == null) continue;
    const oldMinutes = windowMinutesForKey(previous.key, previous.windowMinutes);
    const nextMinutes = windowMinutesForKey(next.key, next.windowMinutes);
    if (oldMinutes === null || nextMinutes === null) continue;

    const oldStart = previous.resetsAtMs - oldMinutes * MINUTE_MS;
    const nextStart = next.resetsAtMs - nextMinutes * MINUTE_MS;
    const resetDeadlineAdvanced = next.resetsAtMs - previous.resetsAtMs > RESET_JITTER_MS;
    const usageDropped = next.usedPercent + 1 < previous.usedPercent;
    const resetAtMs = resetDeadlineAdvanced ? nextStart : usageDropped ? input.observedAtMs : null;
    if (
      resetAtMs === null ||
      resetAtMs <= oldStart ||
      resetAtMs > input.observedAtMs + RESET_JITTER_MS
    ) {
      continue;
    }

    const maxWindowMs = Math.max(oldMinutes, nextMinutes) * MINUTE_MS;
    if (resetAtMs - oldStart > maxWindowMs * 1.5) continue;
    periods.push({
      providerId: input.providerId,
      account: input.account,
      windowKey: next.key,
      periodStartMs: oldStart,
      periodEndMs: resetAtMs,
      detectedAtMs: input.observedAtMs,
    });
  }

  return periods;
}

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
  // Optional REAL reset boundaries per window key (from oauth_reset_period), each a
  // half-open [startMs, endMs). When present, history uses these exact boundaries
  // (approximate:false) and only rolls back the fixed-window approximation for the
  // GAP older than the earliest recorded boundary. Absent/empty → all-approximate.
  recordedBoundaries?: Record<string, Array<{ startMs: number; endMs: number }>>;
}

// Cadence-derived boundaries are exact only on an hour floor. Recorded reset points can
// be exact at any timestamp because the writer starts a new sub-hour usage bucket there.
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
  const { windows, buckets, nowMs, dataStartMs, limit, recordedBoundaries } = input;
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

    // Recorded real boundaries for this window (phase 2), newest first. Real periods may
    // be slightly off a fixed winMs (the recorder tolerates ±winMs/2), so abutment is
    // matched with the same tolerance rather than strict equality — otherwise a real
    // period whose length ≠ winMs would never line up and the recordings would go unused
    // (grok review P2R2-1). A boundary is only usable if its span is sane.
    const recorded = (recordedBoundaries?.[w.key] ?? [])
      .filter((b) => b.startMs < b.endMs)
      .sort((a, b) => b.endMs - a.endMs);
    const tol = winMs / 2;
    const abuts = (endMs: number, cursor: number): boolean => Math.abs(endMs - cursor) <= tol;

    // The current (open) period's start comes from the recorded chain when a recording
    // ends at `reset` (the in-progress window), giving its TRUE length; else fall back
    // to the fixed reset − winMs. Consuming that open row here also stops it from
    // burning a history slot later (grok review P2R2-2).
    let curStart = reset - winMs;
    let recIdx = 0;
    // Skip recordings that end AFTER reset (future / already-superseded).
    while (recIdx < recorded.length && (recorded[recIdx]?.endMs ?? 0) > reset + tol) recIdx++;
    let curBoundaryReal = false;
    const openRow = recorded[recIdx];
    if (openRow && abuts(openRow.endMs, reset)) {
      curStart = openRow.startMs;
      curBoundaryReal = true; // start came from a real recorded boundary
      recIdx++;
    } else if (openRow && openRow.endMs <= nowMs && openRow.endMs > curStart) {
      // A provider/reset-credit can cut a window short without changing its next reset
      // deadline. The newest CLOSED period then ends at the real reset point inside the
      // cadence-derived current span; start current usage there.
      curStart = openRow.endMs;
      curBoundaryReal = true;
    }

    // Current: [curStart, min(reset, now)). Exact only when the START boundary is a
    // confirmed reset (not advanced). A recorded mid-hour start is exact because usage
    // buckets split there. curEnd is `now`, a LIVE cap on an in-progress period,
    // not a period-grid cut, so its (almost never hour-aligned) value must NOT force the
    // period approximate — else current would be ≈ forever and defeat phase 2 (grok
    // review P2R3-1). A real recorded curStart still needs hour-alignment.
    const curEnd = Math.min(reset, nowMs);
    const curExact =
      !boundaryAdvanced && (curBoundaryReal || (isHourAligned(reset) && isHourAligned(curStart)));
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

    // Drop any recordings that reach INTO the current period (endMs > curStart): they
    // overlap it and must never become a history row (grok review — overlapping boundary).
    while (recIdx < recorded.length && (recorded[recIdx]?.endMs ?? 0) > curStart) recIdx++;

    // History: walk backward from curStart. Every period ENDS exactly at the cursor —
    // never above it — so the walk stays strictly contiguous and can never double-count
    // (grok review P2R3-2). A recorded boundary is used when it abuts the cursor from
    // BELOW within tolerance (its end at/just under the cursor); then the period is
    // [rec.startMs, cursor) (its real length, exact when both ends hour-aligned). No
    // abutting recording → roll back one fixed window [cursor - winMs, cursor)
    // (approximate). Both consume the cursor, so a missing recording is an approximate
    // step, never a dropped period.
    let cursor = curStart;
    for (let emitted = 0; emitted < limit; emitted++) {
      if (cursor <= dataStartMs) break; // nothing retained older than the cursor
      // Skip recordings whose end is above the cursor (already covered / overlapping).
      while (recIdx < recorded.length && (recorded[recIdx]?.endMs ?? 0) > cursor) recIdx++;
      const rec = recorded[recIdx];
      const end = cursor; // ALWAYS the cursor — guarantees contiguity, no overlap
      let start: number;
      let approximate: boolean;
      // Usable when the recording's end sits at/just under the cursor (gap ≤ tol) and its
      // start is strictly older — its real start becomes the next cursor.
      if (rec && cursor - rec.endMs <= tol && rec.startMs < cursor) {
        start = rec.startMs;
        approximate = false;
        recIdx++;
      } else {
        start = cursor - winMs;
        approximate = true;
      }
      const sums = sumWindow(buckets, start, end);
      periods.push({
        windowKey: w.key,
        periodStartMs: start,
        periodEndMs: end,
        ...sums,
        approximate,
        partial: start < dataStartMs,
      });
      cursor = start;
    }
  }

  return { current, periods };
}
