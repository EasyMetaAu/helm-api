import { describe, expect, it } from "vitest";
import { parseAnthropicUsageBody } from "./anthropic-quota.js";

const NOW = 1_000_000;
const RESET = "2026-06-03T12:00:00.000Z";
const RESET_MS = Date.parse(RESET);

describe("parseAnthropicUsageBody", () => {
  it("uses the current limits[] shape so scoped Fable usage is not dropped", () => {
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 11, resets_at: RESET },
        seven_day: { utilization: 7, resets_at: RESET },
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 11,
            resets_at: RESET,
            scope: null,
            is_active: true,
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 7,
            resets_at: RESET,
            scope: null,
            is_active: false,
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 5,
            resets_at: RESET,
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
            is_active: false,
          },
        ],
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "5h", usedPercent: 11, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 7, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-fable", usedPercent: 5, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

  it("fills missing session/all windows from legacy fields when limits[] is partial", () => {
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 11, resets_at: RESET },
        seven_day: { utilization: 7, resets_at: RESET },
        limits: [
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 5,
            resets_at: RESET,
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
          },
        ],
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "7d-fable", usedPercent: 5, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "5h", usedPercent: 11, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 7, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

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

  it("parses the real-world body where seven_day_opus is null + unknown windows exist", () => {
    // Mirrors a live response: opus is `null` (no Opus cap on this plan) and the API
    // ships extra forward-compat keys. A strict `.optional()` schema would REJECT the
    // null and drop EVERYTHING — this guards that regression (page went blank).
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 6, resets_at: RESET },
        seven_day: { utilization: 18, resets_at: RESET },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 0, resets_at: RESET },
        seven_day_oauth_apps: null,
        tangelo: null,
        extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 0, currency: "AUD" },
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "5h", usedPercent: 6, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 18, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-sonnet", usedPercent: 0, resetsAtMs: RESET_MS, windowMinutes: null },
    ]);
  });

  it("keeps the other windows when a PRESENT window has resets_at:null (real account body)", () => {
    // Verbatim shape from a live account whose weekly Sonnet cap has not yet been
    // touched: `seven_day_sonnet` is a PRESENT object but its `resets_at` is null
    // (no countdown yet). A `z.string().optional()` inner field REJECTS that null and
    // fails the WHOLE parse → parseAnthropicUsageBody returned [] → the providers page
    // kept a stale snapshot forever (the 9%/44% bug). 5h/7d must still come through;
    // the null-reset window maps with resetsAtMs:null rather than nuking everything.
    const out = parseAnthropicUsageBody(
      {
        five_hour: { utilization: 5, resets_at: RESET },
        seven_day: { utilization: 5, resets_at: RESET },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 0, resets_at: null },
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, currency: null },
      },
      NOW,
    );
    expect(out).toEqual([
      { key: "5h", usedPercent: 5, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d", usedPercent: 5, resetsAtMs: RESET_MS, windowMinutes: null },
      { key: "7d-sonnet", usedPercent: 0, resetsAtMs: null, windowMinutes: null },
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
