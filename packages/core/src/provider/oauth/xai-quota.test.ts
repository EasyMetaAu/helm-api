import { describe, expect, it } from "vitest";
import * as xaiQuota from "./xai-quota.js";
import {
  isXaiGrokMediaEntitled,
  parseXaiGrokCreditsResponse,
  xaiGrokMediaEntitlementValidUntil,
} from "./xai-quota.js";

const OFFICIAL_NOW_MS = Date.parse("2026-06-04T12:00:00Z");

it("does not export the retired private gRPC-Web request builder", () => {
  expect(xaiQuota).not.toHaveProperty("buildXaiGrokCreditsRequest");
});

function officialBillingResponse(
  overrides: { percent?: unknown; periodType?: unknown; start?: unknown; end?: unknown } = {},
): unknown {
  return {
    config: {
      creditUsagePercent: "percent" in overrides ? overrides.percent : 42.5,
      currentPeriod: {
        type: "periodType" in overrides ? overrides.periodType : "USAGE_PERIOD_TYPE_WEEKLY",
        start: "start" in overrides ? overrides.start : "2026-06-01T00:00:00Z",
        end: "end" in overrides ? overrides.end : "2026-06-08T00:00:00Z",
      },
      // The official endpoint carries other billing fields. Helm must ignore them
      // rather than deriving quota from prepaid/on-demand/monthly balances.
      prepaidBalance: { val: 1_250 },
      onDemandCap: { val: 5_000 },
      monthlyLimit: { val: 20_000 },
    },
  };
}

describe("parseXaiGrokCreditsResponse > official Grok Build JSON", () => {
  it("maps the current weekly credits period to Helm's quota window", () => {
    expect(parseXaiGrokCreditsResponse(officialBillingResponse(), OFFICIAL_NOW_MS)).toEqual([
      {
        key: "7d",
        usedPercent: 42.5,
        resetsAtMs: Date.parse("2026-06-08T00:00:00Z"),
        windowMinutes: 10_080,
      },
    ]);
  });

  it("accepts an RFC 3339 offset while preserving percentages above 100", () => {
    expect(
      parseXaiGrokCreditsResponse(
        officialBillingResponse({
          percent: 123.5,
          start: "2026-06-01T08:00:00+08:00",
          end: "2026-06-08T08:00:00+08:00",
        }),
        OFFICIAL_NOW_MS,
      ),
    ).toEqual([
      expect.objectContaining({
        usedPercent: 123.5,
        resetsAtMs: Date.parse("2026-06-08T00:00:00Z"),
      }),
    ]);
  });

  it("treats an omitted proto3 JSON percentage as zero", () => {
    expect(
      parseXaiGrokCreditsResponse(officialBillingResponse({ percent: undefined }), OFFICIAL_NOW_MS),
    ).toEqual([
      expect.objectContaining({
        usedPercent: 0,
        resetsAtMs: Date.parse("2026-06-08T00:00:00Z"),
      }),
    ]);
  });

  it.each([
    ["a null body", null],
    ["a missing config", {}],
    ["a null config", { config: null }],
    ["a null percentage", officialBillingResponse({ percent: null })],
    ["a string percentage", officialBillingResponse({ percent: "42.5" })],
    ["a negative percentage", officialBillingResponse({ percent: -1 })],
    ["a monthly period", officialBillingResponse({ periodType: "USAGE_PERIOD_TYPE_MONTHLY" })],
    ["an invalid calendar date", officialBillingResponse({ start: "2026-02-30T00:00:00Z" })],
    ["a non-RFC3339 date", officialBillingResponse({ start: "2026-06-01" })],
    [
      "a reversed period",
      officialBillingResponse({
        start: "2026-06-08T00:00:00Z",
        end: "2026-06-01T00:00:00Z",
      }),
    ],
    [
      "a stale weekly period",
      officialBillingResponse({
        start: "2026-05-18T00:00:00Z",
        end: "2026-05-25T00:00:00Z",
      }),
    ],
    [
      "an oversized weekly period",
      officialBillingResponse({
        start: "2026-05-30T00:00:00Z",
        end: "2026-06-08T00:00:00Z",
      }),
    ],
  ])("rejects %s", (_label, body) => {
    expect(parseXaiGrokCreditsResponse(body, OFFICIAL_NOW_MS)).toEqual([]);
  });
});

describe("isXaiGrokMediaEntitled", () => {
  const eligible = {
    windows: [
      {
        key: "7d",
        usedPercent: 42.5,
        resetsAtMs: Date.parse("2026-06-08T00:00:00Z"),
        windowMinutes: 10_080,
      },
    ],
    capturedAt: OFFICIAL_NOW_MS,
  };

  it("accepts only a current authoritative weekly billing window", () => {
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "supergrok")).toBe(true);
    expect(isXaiGrokMediaEntitled(undefined, OFFICIAL_NOW_MS)).toBe(false);
    expect(isXaiGrokMediaEntitled({ ...eligible, windows: [] }, OFFICIAL_NOW_MS)).toBe(false);
    expect(isXaiGrokMediaEntitled(eligible, Date.parse("2026-06-08T00:00:00Z"))).toBe(false);
  });

  it("rejects stale evidence and known free tiers", () => {
    const nowMs = OFFICIAL_NOW_MS + 23 * 60 * 60_000;
    expect(isXaiGrokMediaEntitled(eligible, nowMs, "supergrok")).toBe(true);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS + 24 * 60 * 60_000)).toBe(false);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "free")).toBe(false);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "x_basic")).toBe(false);
  });

  it("requires an explicit known paid tier in addition to fresh weekly billing", () => {
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS)).toBe(false);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "opaque-paid-label")).toBe(false);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "supergrok")).toBe(true);
    expect(isXaiGrokMediaEntitled(eligible, OFFICIAL_NOW_MS, "x_premium_plus")).toBe(true);
  });

  it("expires at the earlier of the evidence TTL and weekly reset", () => {
    expect(xaiGrokMediaEntitlementValidUntil(eligible, OFFICIAL_NOW_MS, "supergrok")).toBe(
      OFFICIAL_NOW_MS + 24 * 60 * 60_000,
    );
    const nearReset = {
      ...eligible,
      windows: [
        {
          key: "7d",
          usedPercent: 42.5,
          resetsAtMs: OFFICIAL_NOW_MS + 60_000,
          windowMinutes: 10_080,
        },
      ],
    };
    expect(xaiGrokMediaEntitlementValidUntil(nearReset, OFFICIAL_NOW_MS, "supergrok")).toBe(
      OFFICIAL_NOW_MS + 60_000,
    );
  });

  it("does not confuse exhaustion with missing subscription entitlement", () => {
    expect(
      isXaiGrokMediaEntitled(
        {
          ...eligible,
          windows: [
            {
              key: "7d",
              usedPercent: 100,
              resetsAtMs: Date.parse("2026-06-08T00:00:00Z"),
              windowMinutes: 10_080,
            },
          ],
        },
        OFFICIAL_NOW_MS,
        "supergrok",
      ),
    ).toBe(true);
  });
});
