import { describe, expect, it } from "vitest";
import * as xaiQuota from "./xai-quota.js";
import { parseXaiGrokCreditsResponse } from "./xai-quota.js";

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
