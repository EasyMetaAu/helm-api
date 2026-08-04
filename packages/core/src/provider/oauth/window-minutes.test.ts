import { describe, expect, it } from "vitest";
import { ANTHROPIC_WINDOW_MINUTES, windowMinutesForKey } from "./window-minutes.js";

// Anthropic reports windowMinutes:null for every window, so its 5h/7d lengths must
// be inferred from the key. Codex/xai report a real windowMinutes we prefer verbatim.
describe("windowMinutesForKey", () => {
  it("prefers a reported positive windowMinutes over the key inference", () => {
    // Codex primary / xai 7d report 10080 directly — use it, don't re-derive.
    expect(windowMinutesForKey("primary", 10080)).toBe(10080);
    expect(windowMinutesForKey("7d", 10080)).toBe(10080);
    // A reported value that disagrees with the key still wins (source of truth).
    expect(windowMinutesForKey("5h", 999)).toBe(999);
  });

  it("infers Anthropic 5h -> 300 when windowMinutes is null", () => {
    expect(windowMinutesForKey("5h", null)).toBe(300);
    expect(ANTHROPIC_WINDOW_MINUTES["5h"]).toBe(300);
  });

  it("infers Anthropic 7d and all 7d-* scoped keys -> 10080 when null", () => {
    expect(windowMinutesForKey("7d", null)).toBe(10080);
    expect(windowMinutesForKey("7d-opus", null)).toBe(10080);
    expect(windowMinutesForKey("7d-sonnet", null)).toBe(10080);
    expect(windowMinutesForKey("7d-fable", null)).toBe(10080);
    expect(ANTHROPIC_WINDOW_MINUTES["7d"]).toBe(10080);
  });

  it("returns null for an unknown key with no reported length (cannot anchor)", () => {
    expect(windowMinutesForKey("secondary", null)).toBeNull();
    expect(windowMinutesForKey("weird", null)).toBeNull();
    expect(windowMinutesForKey("", null)).toBeNull();
  });

  it("ignores a non-positive reported value and falls back to key inference", () => {
    // 0 / negative are not a usable length; fall through to the key.
    expect(windowMinutesForKey("5h", 0)).toBe(300);
    expect(windowMinutesForKey("5h", -1)).toBe(300);
    expect(windowMinutesForKey("secondary", 0)).toBeNull();
  });
});
