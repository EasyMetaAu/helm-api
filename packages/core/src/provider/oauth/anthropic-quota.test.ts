import { describe, expect, it } from "vitest";
import { parseAnthropicUsageBody } from "./anthropic-quota.js";

const NOW = 1_000_000;
const RESET = "2026-06-03T12:00:00.000Z";
const RESET_MS = Date.parse(RESET);

describe("parseAnthropicUsageBody", () => {
  it("maps the four windows to 5h / 7d / 7d-opus / 7d-sonnet (utilization is 0–100 percent)", () => {
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 3, resets_at: RESET },
        seven_day: { utilization: 17, resets_at: RESET },
        seven_day_opus: { utilization: 42, resets_at: RESET },
        seven_day_sonnet: { utilization: 0, resets_at: RESET },
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "5h", usedPercent: 3, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 17, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-opus", usedPercent: 42, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-sonnet", usedPercent: 0, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

  it("clamps an out-of-range utilization into 0–100 without re-scaling", () => {
    const out = parseAnthropicUsageBody({ five_hour: { utilization: 130, resets_at: RESET } }, NOW);
    expect(out).toEqual([
      { key: "5h", usedPercent: 100, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

  it("skips an absent window and nulls an unparseable reset timestamp", () => {
    const out = parseAnthropicUsageBody(
      { five_hour: { utilization: 50, resets_at: "not-a-date" } },
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
