import { describe, expect, it, vi } from "vitest";
import { readWeeklyBudget, WEEK_MS, weeklyPeriodStart } from "./weekly.js";

describe("fixed weekly cycle", () => {
  const anchor = Date.parse("2026-11-10T13:45:00+08:00");
  it("supports arbitrary anchors, exact boundaries, and instants before the anchor", () => {
    expect(weeklyPeriodStart(anchor + WEEK_MS - 1, anchor)).toBe(anchor);
    expect(weeklyPeriodStart(anchor + WEEK_MS, anchor)).toBe(anchor + WEEK_MS);
    expect(weeklyPeriodStart(anchor - 1, anchor)).toBe(anchor - WEEK_MS);
  });
  it("reads usage and next reset without making a reservation or using telemetry retention", async () => {
    const peek = vi.fn(async () => ({ remaining: -2, ok: false }));
    expect(
      await readWeeklyBudget(
        { peek },
        "k",
        {
          requests: 10,
          tokens: null,
          spendUsd: null,
          weeklyAnchor: new Date(anchor).toISOString(),
          windowSeconds: null,
          behavior: "degrade",
          degradeLane: null,
        },
        anchor + 1,
      ),
    ).toEqual({
      period_start: new Date(anchor).toISOString(),
      resets_at: new Date(anchor + WEEK_MS).toISOString(),
      requests: { limit: 10, used: 12, remaining: -2 },
      tokens: null,
      spend_usd: null,
    });
    expect(peek).toHaveBeenCalledOnce();
  });
});
