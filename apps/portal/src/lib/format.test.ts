import { describe, expect, it } from "vitest";
import { formatDurationMs } from "./format";

describe("formatDurationMs", () => {
  it("shows sub-second durations as whole milliseconds", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("shows durations under a minute as seconds with one decimal, trimming .0", () => {
    expect(formatDurationMs(1000)).toBe("1s");
    expect(formatDurationMs(4642)).toBe("4.6s");
    expect(formatDurationMs(59_900)).toBe("59.9s");
  });

  it("shows durations at/above a minute as minutes", () => {
    expect(formatDurationMs(60_000)).toBe("1min");
    expect(formatDurationMs(65_000)).toBe("1.1min");
  });

  it("clamps negative input to zero", () => {
    expect(formatDurationMs(-50)).toBe("0ms");
  });
});
