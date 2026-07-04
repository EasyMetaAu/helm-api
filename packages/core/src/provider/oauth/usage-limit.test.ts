import type { OAuthQuotaWindow } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_LIMIT_RECOVERY_THRESHOLD,
  DEFAULT_429_COOLDOWN_MS,
  isAccountWideQuotaWindow,
  LIMIT_THRESHOLD,
  windowsToActiveUsageRecovery,
  windowsToUsageLimit,
} from "./usage-limit.js";

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

  it("ignores saturated scoped weekly model windows", () => {
    expect(
      windowsToUsageLimit(
        [
          win({ key: "5h", usedPercent: 0, resetsAtMs: 8_000 }),
          win({ key: "7d", usedPercent: 75, resetsAtMs: 90_000 }),
          win({ key: "7d-fable", usedPercent: 100, resetsAtMs: 90_000 }),
          win({ key: "7d-sonnet", usedPercent: 100, resetsAtMs: 90_000 }),
        ],
        1_000,
      ),
    ).toBeNull();
  });

  it("keeps the account-wide reset even when a scoped model window resets later", () => {
    expect(
      windowsToUsageLimit(
        [
          win({ key: "7d", usedPercent: 100, resetsAtMs: 9_000 }),
          win({ key: "7d-fable", usedPercent: 100, resetsAtMs: 90_000 }),
        ],
        1_000,
      ),
    ).toBe(9_000);
  });

  it("exposes sane constants", () => {
    expect(LIMIT_THRESHOLD).toBe(100);
    expect(ACTIVE_LIMIT_RECOVERY_THRESHOLD).toBeLessThan(LIMIT_THRESHOLD);
    expect(DEFAULT_429_COOLDOWN_MS).toBeGreaterThan(0);
  });

  it("classifies only non-scoped quota windows as account-wide", () => {
    expect(isAccountWideQuotaWindow(win({ key: "5h" }))).toBe(true);
    expect(isAccountWideQuotaWindow(win({ key: "7d" }))).toBe(true);
    expect(isAccountWideQuotaWindow(win({ key: "primary" }))).toBe(true);
    expect(isAccountWideQuotaWindow(win({ key: "7d-fable" }))).toBe(false);
    expect(isAccountWideQuotaWindow(win({ key: "7d-sonnet" }))).toBe(false);
    expect(isAccountWideQuotaWindow(win({ key: "7d-opus" }))).toBe(false);
  });
});

describe("windowsToActiveUsageRecovery", () => {
  it("uses a near-full 5h window once the account is already rate-limited", () => {
    expect(
      windowsToActiveUsageRecovery(
        [
          win({ key: "5h", usedPercent: 98, resetsAtMs: 8_000 }),
          win({ key: "7d", usedPercent: 61, resetsAtMs: 90_000 }),
          win({ key: "7d-sonnet", usedPercent: 37, resetsAtMs: 90_000 }),
        ],
        1_000,
      ),
    ).toBe(8_000);
  });

  it("chooses the nearest plausible recovery window", () => {
    expect(
      windowsToActiveUsageRecovery(
        [
          win({ key: "7d", usedPercent: 100, resetsAtMs: 90_000 }),
          win({ key: "5h", usedPercent: 98, resetsAtMs: 8_000 }),
        ],
        1_000,
      ),
    ).toBe(8_000);
  });

  it("ignores windows that are not close to the limit", () => {
    expect(windowsToActiveUsageRecovery([win({ usedPercent: 94, resetsAtMs: 8_000 })], 1_000)).toBe(
      null,
    );
  });

  it("does not treat a saturated scoped weekly model window as account recovery", () => {
    expect(
      windowsToActiveUsageRecovery(
        [
          win({ key: "5h", usedPercent: 0, resetsAtMs: 8_000 }),
          win({ key: "7d", usedPercent: 75, resetsAtMs: 90_000 }),
          win({ key: "7d-fable", usedPercent: 100, resetsAtMs: 90_000 }),
        ],
        1_000,
      ),
    ).toBeNull();
  });
});
