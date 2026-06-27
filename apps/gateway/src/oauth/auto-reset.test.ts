import { describe, expect, it } from "vitest";
import { AUTO_RESET_COOLDOWN_MS, cooldownPassed, weeklySaturated } from "./auto-reset.js";

describe("weeklySaturated", () => {
  it("is true only when the weekly (secondary) window is ≥100%", () => {
    expect(weeklySaturated([{ key: "secondary", usedPercent: 100 }])).toBe(true);
    expect(weeklySaturated([{ key: "secondary", usedPercent: 101 }])).toBe(true);
  });

  it("is false when the weekly window is under 100%", () => {
    expect(weeklySaturated([{ key: "secondary", usedPercent: 99 }])).toBe(false);
  });

  it("ignores a saturated 5h (primary) window — only the weekly window counts", () => {
    expect(
      weeklySaturated([
        { key: "primary", usedPercent: 100 },
        { key: "secondary", usedPercent: 40 },
      ]),
    ).toBe(false);
  });

  it("is false with no windows", () => {
    expect(weeklySaturated([])).toBe(false);
  });
});

describe("cooldownPassed", () => {
  const now = 10 * AUTO_RESET_COOLDOWN_MS;

  it("passes when never reset before", () => {
    expect(cooldownPassed(undefined, now)).toBe(true);
  });

  it("blocks within the cooldown window", () => {
    expect(cooldownPassed(now - 1, now)).toBe(false);
    expect(cooldownPassed(now - (AUTO_RESET_COOLDOWN_MS - 1), now)).toBe(false);
  });

  it("passes once a full hour has elapsed", () => {
    expect(cooldownPassed(now - AUTO_RESET_COOLDOWN_MS, now)).toBe(true);
  });
});
