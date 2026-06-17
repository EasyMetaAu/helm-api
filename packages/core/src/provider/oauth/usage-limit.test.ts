import type { OAuthQuotaWindow } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_429_COOLDOWN_MS, LIMIT_THRESHOLD, windowsToUsageLimit } from "./usage-limit.js";

const win = (over: Partial<OAuthQuotaWindow> = {}): OAuthQuotaWindow => ({
  key: "primary",
  usedPercent: 100,
  resetsAtMs: 5_000,
  windowMinutes: null,
  ...over,
});

describe("windowsToUsageLimit", () => {
  it("returns null for no windows", () => {
    expect(windowsToUsageLimit([], 0)).toBeNull();
  });

  it("returns null when every window is under the threshold", () => {
    expect(windowsToUsageLimit([win({ usedPercent: 99 })], 0)).toBeNull();
  });

  it("returns the reset ms when a saturated window has a future reset", () => {
    expect(windowsToUsageLimit([win({ usedPercent: 100, resetsAtMs: 5_000 })], 1_000)).toBe(5_000);
  });

  it("ignores a saturated window whose reset is already in the past", () => {
    expect(windowsToUsageLimit([win({ usedPercent: 100, resetsAtMs: 500 })], 1_000)).toBeNull();
  });

  it("ignores a saturated window with no reset time", () => {
    expect(windowsToUsageLimit([win({ usedPercent: 100, resetsAtMs: null })], 0)).toBeNull();
  });

  it("returns the LATEST future reset across multiple saturated windows", () => {
    expect(
      windowsToUsageLimit(
        [win({ resetsAtMs: 5_000 }), win({ key: "secondary", resetsAtMs: 9_000 })],
        1_000,
      ),
    ).toBe(9_000);
  });

  it("exposes sane constants", () => {
    expect(LIMIT_THRESHOLD).toBe(100);
    expect(DEFAULT_429_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
