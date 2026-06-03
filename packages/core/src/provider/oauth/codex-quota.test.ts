import { describe, expect, it } from "vitest";
import { parseCodexQuotaHeaders } from "./codex-quota.js";

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
