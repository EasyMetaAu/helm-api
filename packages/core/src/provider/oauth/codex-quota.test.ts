import { describe, expect, it } from "vitest";
import {
  codexActiveLimitIdFromProviderRaw,
  parseCodexQuotaDetails,
  parseCodexQuotaHeaderDetails,
  parseCodexQuotaHeaders,
  parseCodexResetCredits,
  parseCodexResetResult,
  parseCodexUsageBody,
  selectCodexActiveLimitWindows,
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

  it("prefers reset-at epoch seconds over reset-after-seconds", () => {
    const out = parseCodexQuotaHeaders(
      headers({
        "x-codex-primary-used-percent": "6",
        "x-codex-primary-reset-at": "1704069000",
        "x-codex-primary-reset-after-seconds": "120",
      }),
      NOW,
    );

    expect(out).toEqual([
      { key: "primary", usedPercent: 6, resetsAtMs: 1_704_069_000_000, windowMinutes: null },
    ]);
  });

  it("discovers named primary and secondary header families with stable keys", () => {
    const out = parseCodexQuotaHeaders(
      headers({
        "x-codex-sol-secondary-used-percent": "75",
        "x-codex-sol-secondary-reset-after-seconds": "30",
        "x-codex-luna-primary-used-percent": "25",
        "x-codex-luna-primary-window-minutes": "60",
        "x-codex-luna-primary-reset-at": "1704069000",
        "x-codex-luna-limit-name": "GPT-5.6-Codex-Spark",
      }),
      NOW,
    );

    expect(out).toEqual([
      {
        key: "codex_luna-primary",
        usedPercent: 25,
        resetsAtMs: 1_704_069_000_000,
        windowMinutes: 60,
        limitId: "codex_luna",
        limitName: "GPT-5.6-Codex-Spark",
      },
      {
        key: "codex_sol-secondary",
        usedPercent: 75,
        resetsAtMs: NOW + 30_000,
        windowMinutes: null,
        limitId: "codex_sol",
        limitName: null,
      },
    ]);
  });

  it("emits a window only when its used-percent is present; nulls a missing reset", () => {
    const out = parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "42" }), NOW);
    expect(out).toEqual([
      { key: "primary", usedPercent: 42, resetsAtMs: null, windowMinutes: null },
    ]);
  });

  it("preserves used-percent above 100 and fails open on garbage / no headers", () => {
    expect(
      parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "150" }), NOW)[0]
        ?.usedPercent,
    ).toBe(150);
    expect(
      parseCodexQuotaHeaders(headers({ "x-codex-primary-used-percent": "nope" }), NOW),
    ).toEqual([]);
    expect(parseCodexQuotaHeaders(headers({}), NOW)).toEqual([]);
  });

  it("does not mistake unrelated or malformed headers for quota families", () => {
    expect(
      parseCodexQuotaHeaders(
        headers({
          "x-codex-primary-over-secondary-limit-percent": "95",
          "x-codex-primary-used-percent-extra": "20",
          "x-codex--primary-used-percent": "30",
          "x-primary-used-percent": "40",
          "x-codex-primary-window-minutes": "300",
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("parses Codex CLI credits and rate-limit reached type from headers", () => {
    expect(
      parseCodexQuotaHeaderDetails(
        headers({
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": "1704069000",
          "x-codex-credits-has-credits": "1",
          "x-codex-credits-unlimited": "false",
          "x-codex-credits-balance": "12.50",
          "x-codex-plan-type": "pro",
          "x-codex-rate-limit-reached-type": "workspace_owner_credits_depleted",
        }),
        NOW,
      ),
    ).toMatchObject({
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      planType: "pro",
      rateLimitReachedType: "workspace_owner_credits_depleted",
    });
  });

  it("selects the exact x-codex-active-limit family for a 429", () => {
    const h = headers({
      "x-codex-active-limit": "codex_luna",
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": "1704069000",
      "x-codex-luna-primary-used-percent": "100",
      "x-codex-luna-primary-reset-at": "1704068000",
    });
    const windows = parseCodexQuotaHeaders(h, NOW);
    expect(selectCodexActiveLimitWindows(h, windows)).toEqual([
      expect.objectContaining({ limitId: "codex_luna", key: "codex_luna-primary" }),
    ]);
  });

  it("reads x-codex-active-limit from structured providerRaw headers", () => {
    expect(
      codexActiveLimitIdFromProviderRaw({
        body: { error: { type: "usage_limit_reached" } },
        headers: { "x-codex-active-limit": "codex-luna" },
      }),
    ).toBe("codex_luna");
    expect(codexActiveLimitIdFromProviderRaw({ headers: {} })).toBeNull();
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

  it("maps additional_rate_limits into model-scoped windows with stable identities", () => {
    const windows = parseCodexUsageBody(
      {
        additional_rate_limits: [
          {
            limit_name: "GPT-5.6-Codex-Spark",
            metered_feature: "codex_spark",
            rate_limit: {
              primary_window: {
                used_percent: 88,
                limit_window_seconds: 1800,
                reset_at: 1_735_693_200,
              },
            },
          },
        ],
      },
      NOW,
    );

    expect(windows).toEqual([
      {
        key: "codex_spark-primary",
        usedPercent: 88,
        resetsAtMs: 1_735_693_200_000,
        windowMinutes: 30,
        limitId: "codex_spark",
        limitName: "GPT-5.6-Codex-Spark",
      },
    ]);
  });

  it("preserves additional-limit identities even when they have no rate-limit windows", () => {
    expect(
      parseCodexQuotaDetails(
        {
          additional_rate_limits: [
            {
              limit_name: "GPT-5.6-Codex-Spark",
              metered_feature: "codex_spark",
              rate_limit: null,
            },
          ],
        },
        NOW,
      ),
    ).toMatchObject({
      windows: [],
      additionalLimits: [
        {
          limitId: "codex_spark",
          limitName: "GPT-5.6-Codex-Spark",
        },
      ],
    });
  });

  it("returns the complete Codex CLI quota metadata", () => {
    expect(
      parseCodexQuotaDetails(
        {
          plan_type: "pro",
          rate_limit: { primary_window: { used_percent: 42 } },
          credits: { has_credits: true, unlimited: false, balance: "9.99" },
          spend_control: {
            reached: false,
            individual_limit: {
              source: "workspace_spend_controls",
              limit: "25000",
              used: "8000",
              remaining: "17000",
              used_percent: 32,
              remaining_percent: 68,
              reset_after_seconds: 3600,
              reset_at: 789,
            },
          },
          rate_limit_reached_type: {
            type: "workspace_member_usage_limit_reached",
          },
        },
        NOW,
      ),
    ).toMatchObject({
      planType: "pro",
      credits: { hasCredits: true, unlimited: false, balance: "9.99" },
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAtMs: 789_000,
      },
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });
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

  it("rounds a partial limit-window minute up like Codex CLI", () => {
    expect(
      parseCodexUsageBody(
        {
          rate_limit: {
            primary_window: {
              used_percent: 1,
              limit_window_seconds: 61,
            },
          },
        },
        NOW,
      )[0]?.windowMinutes,
    ).toBe(2);
  });

  it("emits a window only when used_percent is present and preserves values above 100", () => {
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
    expect(out[0]?.usedPercent).toBe(150);
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
  it.each([
    ["reset", "reset"],
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("maps backend code %s to outcome %s", (code, outcome) => {
    expect(parseCodexResetResult({ code, windows_reset: code === "reset" ? 2 : 0 })).toEqual({
      code,
      outcome,
      windowsReset: code === "reset" ? 2 : 0,
    });
  });

  it("defaults windows_reset to zero for a recognized outcome", () => {
    expect(parseCodexResetResult({ code: "nothing_to_reset" })).toEqual({
      code: "nothing_to_reset",
      outcome: "nothingToReset",
      windowsReset: 0,
    });
  });

  it("fails open to nulls on a drifted / malformed body", () => {
    expect(parseCodexResetResult({ unexpected: true })).toEqual({
      code: null,
      outcome: null,
      windowsReset: null,
    });
    expect(parseCodexResetResult(null)).toEqual({
      code: null,
      outcome: null,
      windowsReset: null,
    });
    expect(parseCodexResetResult({ windows_reset: "two" })).toEqual({
      code: null,
      outcome: null,
      windowsReset: null,
    });
  });
});
