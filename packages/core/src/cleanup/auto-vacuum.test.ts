import { describe, expect, it } from "vitest";
import {
  AUTO_VACUUM_CHECK_INTERVAL_MS,
  createAutoVacuumRunner,
  shouldAutoVacuum,
} from "./auto-vacuum.js";

const base = {
  enabled: true,
  vacuumHour: 4,
  currentHour: 4,
  lastRunDayKey: null as string | null,
  todayKey: "Mon Jun 22 2026",
};

describe("shouldAutoVacuum", () => {
  it("checks more than once during the configured hour so a failed attempt can retry", () => {
    expect(AUTO_VACUUM_CHECK_INTERVAL_MS).toBeLessThan(60 * 60 * 1_000);
  });

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

describe("createAutoVacuumRunner", () => {
  const tick = {
    enabled: true,
    vacuumHour: 4,
    currentHour: 4,
    todayKey: "Mon Jun 22 2026",
  };

  it("marks the day only after maintenance succeeds", async () => {
    const runner = createAutoVacuumRunner();
    let attempts = 0;
    const run = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk preflight failed");
    };

    await expect(runner.run(tick, run)).rejects.toThrow("disk preflight failed");
    await expect(runner.run(tick, run)).resolves.toBe(true);
    await expect(runner.run(tick, run)).resolves.toBe(false);
    expect(attempts).toBe(2);
  });

  it("does not invoke maintenance when the live gate is closed", async () => {
    const runner = createAutoVacuumRunner();
    let called = false;

    await expect(
      runner.run({ ...tick, enabled: false }, async () => {
        called = true;
      }),
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });
});
