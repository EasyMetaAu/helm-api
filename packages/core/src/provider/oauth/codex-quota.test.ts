import { describe, expect, it } from "vitest";
import {
  parseCodexQuotaHeaders,
  parseCodexResetCredits,
  parseCodexResetResult,
  parseCodexUsageBody,
} from "./codex-quota.js";

const NOW = 1_000_000;

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

describe("parseCodexQuotaHeaders", () => {
  it("maps the x-codex-* primary + secondary windows (percent + absolute reset)", () => {
    const out = parseCodexQuotaHeaders(
      headers({
        "x-codex-primary-used-percent": "6",
        "x-codex-primary-reset-after-seconds": "120",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "14",
        "x-codex-secondary-reset-after-seconds": "600",
        "x-codex-secondary-window-minutes": "10080",
      }),
      NOW,
    );
    expect(out).toEqual([
      { key: "primary", usedPercent: 6, resetsAtMs: NOW + 120_000, windowMinutes: 300 },
      { key: "secondary", usedPercent: 14, resetsAtMs: NOW + 600_000, windowMinutes: 10_080 },
    ]);
  });

  it("emits a window only when its used-percent is present; nulls a missing reset", () => {
    const out = parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "42" }), NOW);
    expect(out).toEqual([
      { key: "primary", usedPercent: 42, resetsAtMs: null, windowMinutes: null },
    ]);
  });

  it("clamps used-percent to 0–100 and fails open on garbage / no headers", () => {
    expect(
      parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "150" }), NOW)[0]
        ?.usedPercent,
    ).toBe(100);
    expect(
      parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "nope" }), NOW),
    ).toEqual([]);
    expect(parseCodexQuotaHeaders(headers({}), NOW)).toEqual([]);
  });
});

describe("parseCodexUsageBody", () => {
  // Live shape captured 2026-06-04 from GET chatgpt.com/backend-api/wham/usage
  // (the same payload the Codex CLI /status reads). reset_at is epoch SECONDS.
  const LIVE_BODY = {
    user_id: "user-x",
    email: "a@b.c",
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 1,
        limit_window_seconds: 18000,
        reset_after_seconds: 5057,
        reset_at: 1780568997,
      },
      secondary_window: {
        used_percent: 14,
        limit_window_seconds: 604800,
        reset_after_seconds: 573663,
        reset_at: 1781137603,
      },
    },
    code_review_rate_limit: null,
    additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark" }],
    credits: { has_credits: true },
  };

  it("maps the primary + secondary windows (same keys as the header PUSH path)", () => {
    expect(parseCodexUsageBody(LIVE_BODY, NOW)).toEqual([
      { key: "primary", usedPercent: 1, resetsAtMs: 1_780_568_997_000, windowMinutes: 300 },
      { key: "secondary", usedPercent: 14, resetsAtMs: 1_781_137_603_000, windowMinutes: 10_080 },
    ]);
  });

  it("falls back to now + reset_after_seconds when reset_at is absent; nulls when both are", () => {
    const out = parseCodexUsageBody(
      {
        rate_limit: {
          primary_window: { used_percent: 7, reset_after_seconds: 120 },
          secondary_window: { used_percent: 9 },
        },
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "primary", usedPercent: 7, resetsAtMs: NOW + 120_000, windowMinutes: null },
      { key: "secondary", usedPercent: 9, resetsAtMs: null, windowMinutes: null },
    ]);
  });

  it("emits a window only when used_percent is present, and clamps to 0–100", () => {
    const out = parseCodexUsageBody(
      {
        rate_limit: {
          primary_window: { used_percent: 150, reset_after_seconds: 1 },
          secondary_window: { limit_window_seconds: 604800 }, // no usage signal → skipped
        },
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.usedPercent).toBe(100);
  });

  it("fails open on malformed / empty / null bodies", () => {
    expect(parseCodexUsageBody(null, NOW)).toEqual([]);
    expect(parseCodexUsageBody("garbage", NOW)).toEqual([]);
    expect(parseCodexUsageBody({}, NOW)).toEqual([]);
    expect(parseCodexUsageBody({ rate_limit: null }, NOW)).toEqual([]);
    expect(parseCodexUsageBody({ rate_limit: { primary_window: null } }, NOW)).toEqual([]);
  });
});

describe("parseCodexResetCredits", () => {
  it("reads available_count from the same /wham/usage body", () => {
    expect(
      parseCodexResetCredits({
        rate_limit: { primary_window: { used_percent: 1 } },
        rate_limit_reset_credits: { available_count: 3 },
      }),
    ).toBe(3);
  });

  it("returns 0 when the grant exists but is exhausted", () => {
    expect(parseCodexResetCredits({ rate_limit_reset_credits: { available_count: 0 } })).toBe(0);
  });

  it("returns null when the grant is absent, null, or not a finite ≥0 number", () => {
    expect(parseCodexResetCredits({})).toBeNull();
    expect(parseCodexResetCredits({ rate_limit_reset_credits: null })).toBeNull();
    expect(
      parseCodexResetCredits({ rate_limit_reset_credits: { available_count: -1 } }),
    ).toBeNull();
    expect(parseCodexResetCredits(null)).toBeNull();
    expect(parseCodexResetCredits("garbage")).toBeNull();
  });

  it("floors a fractional count", () => {
    expect(parseCodexResetCredits({ rate_limit_reset_credits: { available_count: 2.9 } })).toBe(2);
  });
});

describe("parseCodexResetResult", () => {
  it("extracts code + windows_reset from the consume envelope", () => {
    expect(parseCodexResetResult({ code: "ok", credit: { id: "c_1" }, windows_reset: 2 })).toEqual({
      code: "ok",
      windowsReset: 2,
    });
  });

  it("fails open to nulls on a drifted / malformed body", () => {
    expect(parseCodexResetResult({ unexpected: true })).toEqual({ code: null, windowsReset: null });
    expect(parseCodexResetResult(null)).toEqual({ code: null, windowsReset: null });
    expect(parseCodexResetResult({ windows_reset: "two" })).toEqual({
      code: null,
      windowsReset: null,
    });
  });
});
