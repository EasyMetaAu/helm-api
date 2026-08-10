import { describe, expect, it, vi } from "vitest";
import { recordObservedQuotaResetPeriods } from "./quota-reset-period.js";

describe("recordObservedQuotaResetPeriods", () => {
  it("ignores an observation older than the stored quota snapshot", async () => {
    const record = vi.fn(async () => {});
    await recordObservedQuotaResetPeriods({
      quotaStore: {
        get: vi.fn(async () => ({
          providerId: "openai-codex",
          account: "a",
          windows: [{ key: "7d", usedPercent: 90, resetsAtMs: 700, windowMinutes: 10_080 }],
          capturedAt: 200,
          source: "codex",
          usageLimitedUntilMs: null,
        })),
      } as never,
      periodStore: { record } as never,
      providerId: "openai-codex",
      account: "a",
      windows: [{ key: "7d", usedPercent: 0, resetsAtMs: 800, windowMinutes: 10_080 }],
      observedAtMs: 100,
    });
    expect(record).not.toHaveBeenCalled();
  });
});
