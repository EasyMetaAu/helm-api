import type { OAuthQuotaWindow, OAuthUsageBucket, OAuthUsagePeriod } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { computeUsagePeriods } from "./usage-periods.js";

// Helper: the single current period for a given window key (the function returns an
// array — one per anchorable window; tests below pass one window at a time mostly).
function currentFor(
  out: { current: OAuthUsagePeriod[] },
  key: string,
): OAuthUsagePeriod | undefined {
  return out.current.find((p) => p.windowKey === key);
}

const HOUR = 3_600_000;

// Build a contiguous run of hour buckets, each carrying `tokensPerBucket` tokens and
// 1 request, starting at `startMs` (must be an hour floor).
function buckets(startMs: number, count: number, tokensPerBucket: number): OAuthUsageBucket[] {
  return Array.from({ length: count }, (_, i) => ({
    bucketMs: startMs + i * HOUR,
    requests: 1,
    tokens: tokensPerBucket,
    costUsd: null,
  }));
}

function win(
  key: string,
  resetsAtMs: number | null,
  windowMinutes: number | null,
): OAuthQuotaWindow {
  return { key, usedPercent: 0, resetsAtMs, windowMinutes };
}

describe("computeUsagePeriods", () => {
  // A 5h Anthropic window (windowMinutes null → inferred 300). resetsAtMs on an hour
  // floor, in the FUTURE (a fresh snapshot), so the current period is genuinely
  // in-progress. 17 buckets cover the current + prior periods.
  it("slices one window into current + historical periods, summing buckets", () => {
    const now = 107 * HOUR; // mid-window (hour-aligned)
    const reset = 110 * HOUR; // next reset ahead of now → current [105h,110h) capped to now
    const bs = buckets(90 * HOUR, 17, 1000); // covers [90h, 107h)
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: bs,
      nowMs: now,
      dataStartMs: 0,
      limit: 5,
    });
    // current period = [reset-5h, min(reset,now)) = [105h,107h): 2 buckets * 1000, exact
    const cur = currentFor(out, "5h");
    expect(cur).toBeDefined();
    expect(cur?.approximate).toBe(false);
    expect(cur?.tokens).toBe(2000);
    expect(cur?.periodStartMs).toBe(105 * HOUR);
    expect(cur?.periodEndMs).toBe(107 * HOUR);
    // history: [100h,105h)=5000, [95h,100h)=5000, [90h,95h)=5000
    expect(out.periods.length).toBeGreaterThanOrEqual(3);
    expect(out.periods[0]).toMatchObject({ tokens: 5000, approximate: true, partial: false });
    expect(out.periods[0]?.periodEndMs).toBe(105 * HOUR);
    expect(out.periods[1]?.tokens).toBe(5000);
  });

  it("advances a STALE (past) resetsAtMs to the next window and marks current approximate", () => {
    // Snapshot is stale: resetsAtMs is 2.5 windows in the PAST. The real in-progress
    // window is [now-…], and post-reset traffic must not be dropped or mislabeled.
    const now = 100 * HOUR;
    const reset = 87 * HOUR; // 13h before now = 2.6 * 5h windows in the past
    const bs = buckets(90 * HOUR, 12, 500); // traffic AFTER the stale reset, up to [102h)
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: bs,
      nowMs: now,
      dataStartMs: 0,
      limit: 5,
    });
    const cur = currentFor(out, "5h");
    expect(cur).toBeDefined();
    // advanced: 87h + ceil((100-87)/5)*5h = 87h + 15h = 102h → current [97h,102h) capped to now=100h
    expect(cur?.periodEndMs).toBe(100 * HOUR);
    expect(cur?.periodStartMs).toBe(97 * HOUR);
    // boundary was advanced → not exact
    expect(cur?.approximate).toBe(true);
    // post-"stale-reset" traffic in [97h,100h) is captured, NOT dropped
    expect(cur?.tokens ?? 0).toBeGreaterThan(0);
  });

  it("marks current approximate when the reset boundary is not hour-aligned", () => {
    const now = 100 * HOUR;
    const reset = 101 * HOUR + 1_800_000; // 101:30 — mid-hour, in the future
    const bs = buckets(90 * HOUR, 11, 100);
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: bs,
      nowMs: now,
      dataStartMs: 0,
      limit: 3,
    });
    // current [reset-5h, now) = [96:30, 100:00): boundary not hour-aligned → approximate
    expect(currentFor(out, "5h")?.approximate).toBe(true);
  });

  it("uses half-open bucket binning: bucket at period end belongs to the next period", () => {
    const now = 12 * HOUR; // inside the [10h,15h) window
    const reset = 15 * HOUR; // ahead of now
    // one bucket exactly at 10h (the boundary between the [5h,10h) and [10h,15h) periods)
    const bs: OAuthUsageBucket[] = [
      { bucketMs: 10 * HOUR, requests: 1, tokens: 777, costUsd: null },
    ];
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: bs,
      nowMs: now,
      dataStartMs: 0,
      limit: 3,
    });
    // current [10h,12h) must include the bucket at exactly 10h (start inclusive)
    expect(currentFor(out, "5h")?.tokens).toBe(777);
    // period [5h,10h) must NOT include the bucket at 10h (end exclusive)
    const prior = out.periods.find((p) => p.periodStartMs === 5 * HOUR);
    expect(prior?.tokens ?? 0).toBe(0);
  });

  it("returns no current and no history for a window whose resetsAtMs is null", () => {
    const out = computeUsagePeriods({
      windows: [win("7d-fable", null, null)],
      buckets: buckets(0, 200, 10),
      nowMs: 200 * HOUR,
      dataStartMs: 0,
      limit: 5,
    });
    expect(out.current).toHaveLength(0);
    expect(out.periods).toHaveLength(0);
  });

  it("skips a window whose length cannot be inferred (unknown key, no windowMinutes)", () => {
    const out = computeUsagePeriods({
      windows: [win("secondary", 100 * HOUR, null)],
      buckets: buckets(0, 100, 10),
      nowMs: 100 * HOUR,
      dataStartMs: 0,
      limit: 5,
    });
    expect(out.current).toHaveLength(0);
    expect(out.periods).toHaveLength(0);
  });

  it("prefers the reported windowMinutes (Codex primary = 10080)", () => {
    const weekHours = 168; // 10080 min
    // reset ahead of now; now sits exactly at the window start so the current period
    // is [reset-week, now)=empty and the full prior week is the first history period.
    const reset = (400 + weekHours) * HOUR;
    const now = 400 * HOUR;
    const bs = buckets((400 - weekHours) * HOUR, weekHours, 100); // the prior full week
    const out = computeUsagePeriods({
      windows: [win("primary", reset, 10080)],
      buckets: bs,
      nowMs: now,
      dataStartMs: 0,
      limit: 3,
    });
    // first history period is the completed prior week [400-week, 400): full tokens.
    expect(out.periods[0]?.tokens).toBe(weekHours * 100);
    expect(out.periods[0]?.periodStartMs).toBe((400 - weekHours) * HOUR);
  });

  it("marks periods that start before dataStartMs as partial and stops rolling past it", () => {
    const now = 100 * HOUR;
    const reset = 105 * HOUR; // ahead of now → current [100h,105h) capped to now=100h (empty)
    const dataStartMs = 92 * HOUR; // only data from 92h onward
    const bs = buckets(92 * HOUR, 8, 1000);
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: bs,
      nowMs: now,
      dataStartMs,
      limit: 10,
    });
    // first history [95h,100h): full, not partial
    expect(out.periods[0]?.periodStartMs).toBe(95 * HOUR);
    expect(out.periods[0]?.partial).toBe(false);
    // [90h,95h) starts (90h) before dataStartMs (92h) → partial, undercounts
    const p = out.periods[1];
    expect(p?.periodStartMs).toBe(90 * HOUR);
    expect(p?.partial).toBe(true);
    // nothing older than the partial period (its end 90h <= dataStartMs stops rollback)
    expect(out.periods.every((x) => x.periodEndMs > dataStartMs)).toBe(true);
  });

  it("null-aware cost: all-null → null, any priced → numeric sum", () => {
    const now = 3 * HOUR; // inside the [0,5h) window
    const reset = 5 * HOUR; // ahead of now
    const mixed: OAuthUsageBucket[] = [
      { bucketMs: 0, requests: 1, tokens: 10, costUsd: null },
      { bucketMs: HOUR, requests: 1, tokens: 10, costUsd: 1.5 },
      { bucketMs: 2 * HOUR, requests: 1, tokens: 10, costUsd: 2.5 },
    ];
    const out = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: mixed,
      nowMs: now,
      dataStartMs: 0,
      limit: 1,
    });
    // current [0,3h): the three buckets, cost 1.5+2.5 = 4 (null treated as absent)
    expect(currentFor(out, "5h")?.costUsd).toBe(4);

    const allNull = computeUsagePeriods({
      windows: [win("5h", reset, null)],
      buckets: buckets(0, 3, 10),
      nowMs: now,
      dataStartMs: 0,
      limit: 1,
    });
    expect(currentFor(allNull, "5h")?.costUsd).toBeNull();
  });

  it("computes multiple windows independently (Anthropic 5h + 7d)", () => {
    const now = 200 * HOUR;
    // Both resets ahead of now (mid-window) so each yields a current + history.
    const out = computeUsagePeriods({
      windows: [win("5h", 202 * HOUR, null), win("7d", 340 * HOUR, null)],
      buckets: buckets(0, 200, 100),
      nowMs: now,
      dataStartMs: 0,
      limit: 2,
    });
    // both windows produce a current period and their own history.
    expect(currentFor(out, "5h")).toBeDefined();
    expect(currentFor(out, "7d")).toBeDefined();
    const historyKeys = new Set(out.periods.map((p) => p.windowKey));
    expect(historyKeys.has("5h")).toBe(true);
    expect(historyKeys.has("7d")).toBe(true);
  });
});
