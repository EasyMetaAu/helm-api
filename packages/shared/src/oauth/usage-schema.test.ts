import { describe, expect, it } from "vitest";
import {
  CodexOAuthUsageSchema,
  CodexResetResultSchema,
  OAuthQuotaSnapshotSchema,
} from "./usage-schema.js";

// The auto-park cooldown (`usageLimitedUntilMs`) rides on the quota snapshot. It must
// be OPTIONAL on the wire: legacy rows + unit fixtures written before the column existed
// omit it, and the parse must still succeed (defaulting to null), exactly like the
// `windowMinutes` field. A present value round-trips unchanged.
describe("OAuthQuotaSnapshotSchema — usageLimitedUntilMs", () => {
  const base = {
    providerId: "openai-codex",
    account: "default",
    windows: [],
    capturedAt: 123,
    source: "codex-headers" as const,
  };

  it("defaults usageLimitedUntilMs to null when absent (legacy rows parse)", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse(base);
    expect(parsed.usageLimitedUntilMs).toBeNull();
  });

  it("accepts an explicit null", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: null });
    expect(parsed.usageLimitedUntilMs).toBeNull();
  });

  it("round-trips an integer cooldown timestamp", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: 1_700_000 });
    expect(parsed.usageLimitedUntilMs).toBe(1_700_000);
  });

  it("round-trips an optional Codex reset-credit count", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, resetCredits: 2 });
    expect(parsed.resetCredits).toBe(2);
  });

  it("rejects a non-integer cooldown", () => {
    expect(() => OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: 1.5 })).toThrow();
  });

  it("preserves an upstream usage percentage above 100", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({
      ...base,
      windows: [
        {
          key: "primary",
          usedPercent: 125.5,
          resetsAtMs: null,
          windowMinutes: 300,
        },
      ],
    });
    expect(parsed.windows[0]?.usedPercent).toBe(125.5);
  });

  it("parses the complete Codex quota endpoint metadata", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({
      ...base,
      source: "codex",
      identity: {
        email: "codex@example.com",
        chatgptPlanType: "pro",
        chatgptAccountId: "account-1",
        isFedramp: false,
      },
      planType: "pro",
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "9.99",
      },
      resetCredits: 2,
      resetCreditDetails: [
        {
          id: "credit-1",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_752_796_800,
          expiresAt: 1_755_388_800,
          title: "Full reset",
          description: "Ready to redeem",
        },
      ],
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAtMs: 1_755_388_800_000,
      },
      additionalLimits: [
        {
          limitId: "codex_spark",
          limitName: "GPT-5.6-Codex-Spark",
        },
      ],
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });

    expect(parsed.identity).toEqual({
      email: "codex@example.com",
      chatgptPlanType: "pro",
      chatgptAccountId: "account-1",
      isFedramp: false,
    });
    expect(parsed.planType).toBe("pro");
    expect(parsed.credits?.balance).toBe("9.99");
    expect(parsed.resetCreditDetails?.[0]?.resetType).toBe("codexRateLimits");
    expect(parsed.individualLimit?.remainingPercent).toBe(68);
    expect(parsed.additionalLimits?.[0]?.limitId).toBe("codex_spark");
    expect(parsed.rateLimitReachedType).toBe("workspace_member_usage_limit_reached");
  });

  it("rejects malformed normalized Codex metadata", () => {
    expect(() =>
      OAuthQuotaSnapshotSchema.parse({
        ...base,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 9.99,
        },
      }),
    ).toThrow();
  });
});

describe("CodexOAuthUsageSchema.rate_limit_reset_credits", () => {
  it("parses available_count when present", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      rate_limit: { primary_window: { used_percent: 1 } },
      rate_limit_reset_credits: { available_count: 2 },
    });
    expect(parsed.rate_limit_reset_credits?.available_count).toBe(2);
  });

  it("accepts an absent or null reset-credits block (fail-open)", () => {
    expect(CodexOAuthUsageSchema.parse({}).rate_limit_reset_credits).toBeUndefined();
    expect(
      CodexOAuthUsageSchema.parse({ rate_limit_reset_credits: null }).rate_limit_reset_credits,
    ).toBeNull();
  });

  it("tolerates extra fields on the reset-credits block", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      rate_limit_reset_credits: { available_count: 0, next_grant_at: 123, foo: "bar" },
    });
    expect(parsed.rate_limit_reset_credits?.available_count).toBe(0);
  });

  it("parses Codex CLI reset-credit details", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      rate_limit_reset_credits: {
        available_count: 2,
        credits: [
          {
            id: "credit-1",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: "2026-06-17T00:00:00Z",
            expires_at: "2026-07-17T00:00:00Z",
            title: "Full reset",
            description: "Ready to redeem",
          },
        ],
      },
    });

    expect(parsed.rate_limit_reset_credits?.credits?.[0]).toMatchObject({
      id: "credit-1",
      reset_type: "codex_rate_limits",
      status: "available",
    });
  });
});

describe("CodexOAuthUsageSchema — Codex CLI quota fields", () => {
  it("parses credits, spend control, reached type, and additional rate-limit buckets", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      plan_type: "pro",
      credits: {
        has_credits: true,
        unlimited: false,
        balance: "9.99",
      },
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
          reset_at: 1_735_693_200,
        },
      },
      rate_limit_reached_type: {
        type: "workspace_member_usage_limit_reached",
      },
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
    });

    expect(parsed.plan_type).toBe("pro");
    expect(parsed.credits).toEqual({
      has_credits: true,
      unlimited: false,
      balance: "9.99",
    });
    expect(parsed.spend_control?.individual_limit).toMatchObject({
      limit: "25000",
      used: "8000",
      remaining_percent: 68,
      reset_at: 1_735_693_200,
    });
    expect(parsed.rate_limit_reached_type?.type).toBe("workspace_member_usage_limit_reached");
    expect(parsed.additional_rate_limits?.[0]).toMatchObject({
      limit_name: "GPT-5.6-Codex-Spark",
      metered_feature: "codex_spark",
    });
  });
});

describe("CodexResetResultSchema", () => {
  it.each([
    "reset",
    "nothing_to_reset",
    "no_credit",
    "already_redeemed",
  ] as const)("parses the %s consume outcome", (code) => {
    const parsed = CodexResetResultSchema.parse({
      code,
      credit: { id: "c_1", status: "redeemed" },
      windows_reset: code === "reset" ? 2 : 0,
    });
    expect(parsed.code).toBe(code);
  });

  it("rejects an unknown consume outcome", () => {
    expect(() => CodexResetResultSchema.parse({ code: "future_code" })).toThrow();
  });

  it("parses the Gateway-normalized Admin consume result", () => {
    const parsed = CodexResetResultSchema.parse({
      code: "already_redeemed",
      outcome: "alreadyRedeemed",
      windowsReset: 0,
      redeemRequestId: "redeem-1",
    });

    expect(parsed).toMatchObject({
      code: "already_redeemed",
      outcome: "alreadyRedeemed",
      windowsReset: 0,
      redeemRequestId: "redeem-1",
    });
  });

  it("fails open on a body missing the fields we read", () => {
    const parsed = CodexResetResultSchema.parse({ unexpected: true });
    expect(parsed.code).toBeUndefined();
    expect(parsed.windows_reset).toBe(0);
  });
});
