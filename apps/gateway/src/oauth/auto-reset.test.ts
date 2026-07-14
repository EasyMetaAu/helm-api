import { describe, expect, it, vi } from "vitest";
import {
  AUTO_RESET_COOLDOWN_MS,
  CODEX_RESET_MIN_WEEKLY_USED_PERCENT,
  canConsumeResetCredit,
  codexWeeklyUsedPercent,
  cooldownPassed,
  runResetCreditAttempt,
  weeklySaturated,
} from "./auto-reset.js";

describe("codex reset-credit eligibility", () => {
  it("requires the weekly (secondary) window to be at least 90%", () => {
    expect(CODEX_RESET_MIN_WEEKLY_USED_PERCENT).toBe(90);
    expect(canConsumeResetCredit([{ key: "secondary", usedPercent: 90 }])).toBe(true);
    expect(canConsumeResetCredit([{ key: "secondary", usedPercent: 100 }])).toBe(true);
  });

  it("blocks reset-credit consumption below 90% or without a weekly window", () => {
    expect(canConsumeResetCredit([{ key: "secondary", usedPercent: 89.99 }])).toBe(false);
    expect(canConsumeResetCredit([{ key: "primary", usedPercent: 100 }])).toBe(false);
    expect(canConsumeResetCredit([])).toBe(false);
  });

  it("recognizes a primary account window as weekly when its duration is seven days", () => {
    expect(
      canConsumeResetCredit([{ key: "primary", usedPercent: 95, windowMinutes: 10_080 }]),
    ).toBe(true);
    expect(canConsumeResetCredit([{ key: "primary", usedPercent: 100, windowMinutes: 300 }])).toBe(
      false,
    );
  });

  it("does not spend a reset credit for an additional model-specific secondary window", () => {
    expect(
      canConsumeResetCredit([
        {
          key: "secondary",
          limitId: "codex_luna",
          usedPercent: 100,
        },
      ]),
    ).toBe(false);
  });

  it.each([
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
  ] as const)("does not spend a reset credit for %s", (rateLimitReachedType) => {
    expect(
      canConsumeResetCredit([{ key: "secondary", usedPercent: 100 }], rateLimitReachedType),
    ).toBe(false);
  });

  it("reports the weekly percentage from secondary only", () => {
    expect(
      codexWeeklyUsedPercent([
        { key: "primary", usedPercent: 100 },
        { key: "secondary", usedPercent: 42 },
      ]),
    ).toBe(42);
    expect(codexWeeklyUsedPercent([{ key: "primary", usedPercent: 100 }])).toBeNull();
  });

  it("prefers an explicit weekly duration and ignores empty positional placeholders", () => {
    expect(
      codexWeeklyUsedPercent([
        { key: "secondary", usedPercent: 95 },
        { key: "primary", usedPercent: 37, windowMinutes: 10_080 },
      ]),
    ).toBe(37);
    expect(codexWeeklyUsedPercent([{ key: "secondary", usedPercent: 0 }])).toBeNull();
  });
});

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

describe("runResetCreditAttempt", () => {
  it.each([
    "reset",
    "alreadyRedeemed",
  ] as const)("commits %s and runs consumed side effects", async (outcome) => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    const onConsumed = vi.fn(async () => {});

    await expect(
      runResetCreditAttempt({
        reservation: { commit, rollback },
        consume: vi.fn(async () => ({ outcome })),
        onConsumed,
      }),
    ).resolves.toMatchObject({ consumed: true, result: { outcome } });

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(onConsumed).toHaveBeenCalledWith({ outcome });
  });

  it.each([
    "nothingToReset",
    "noCredit",
  ] as const)("rolls back %s without running consumed side effects", async (outcome) => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    const onConsumed = vi.fn(async () => {});

    await expect(
      runResetCreditAttempt({
        reservation: { commit, rollback },
        consume: vi.fn(async () => ({ outcome })),
        onConsumed,
      }),
    ).resolves.toMatchObject({ consumed: false, result: { outcome } });

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it("rolls back when the upstream consume throws", async () => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});

    await expect(
      runResetCreditAttempt({
        reservation: { commit, rollback },
        consume: vi.fn(async () => {
          throw new Error("upstream unavailable");
        }),
      }),
    ).rejects.toThrow("upstream unavailable");

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });
});
