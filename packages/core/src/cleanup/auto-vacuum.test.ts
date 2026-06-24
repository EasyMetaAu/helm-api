import { describe, expect, it } from "vitest";
import { shouldAutoVacuum } from "./auto-vacuum.js";

const base = {
  enabled: true,
  vacuumHour: 4,
  currentHour: 4,
  lastRunDayKey: null as string | null,
  todayKey: "Mon Jun 22 2026",
};

describe("shouldAutoVacuum", () => {
  it("runs at the configured hour when enabled and not yet run today", () => {
    expect(shouldAutoVacuum(base)).toBe(true);
  });

  it("never runs when disabled (opt-in)", () => {
    expect(shouldAutoVacuum({ ...base, enabled: false })).toBe(false);
  });

  it("waits outside the configured hour", () => {
    expect(shouldAutoVacuum({ ...base, currentHour: 3 })).toBe(false);
    expect(shouldAutoVacuum({ ...base, currentHour: 5 })).toBe(false);
  });

  it("runs at most once per day (already ran today → skip)", () => {
    const today = "Mon Jun 22 2026";
    expect(shouldAutoVacuum({ ...base, lastRunDayKey: today, todayKey: today })).toBe(false);
  });

  it("runs again on a new day", () => {
    expect(
      shouldAutoVacuum({ ...base, lastRunDayKey: "Sun Jun 21 2026", todayKey: "Mon Jun 22 2026" }),
    ).toBe(true);
  });
});
