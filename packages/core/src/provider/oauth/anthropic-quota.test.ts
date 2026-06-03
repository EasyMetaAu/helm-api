import { describe, expect, it } from "vitest";
import { parseAnthropicUsageBody } from "./anthropic-quota.js";

const NOW = 1_000_000;
const RESET = "2026-06-03T12:00:00.000Z";
const RESET_MS = Date.parse(RESET);

describe("parseAnthropicUsageBody", () => {
  it("maps five_hour / seven_day / seven_day_sonnet to 5h / 7d / 7d-opus (fraction→percent)", () => {
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 0.06, resets_at: RESET },
        seven_day: { utilization: 0.14, resets_at: RESET },
        seven_day_sonnet: { utilization: 0, resets_at: RESET },
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "5h", usedPercent: 6, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 14.000000000000002, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-opus", usedPercent: 0, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

  it("skips an absent window and nulls an unparseable reset timestamp", () => {
    const out = parseAnthropicUsageBody(
      { five_hour: { utilization: 0.5, resets_at: "not-a-date" } },
      NOW,
    );
    expect(out).toEqual([{ key: "5h", usedPercent: 50, resetsAtMs: null, windowMinutes: null }]);
  });

  it("fails open to [] on a malformed body", () => {
    expect(parseAnthropicUsageBody(null, NOW)).toEqual([]);
    expect(parseAnthropicUsageBody("garbage", NOW)).toEqual([]);
    expect(parseAnthropicUsageBody({ five_hour: { utilization: "x" } }, NOW)).toEqual([]);
  });
});
