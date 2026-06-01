import { describe, expect, it } from "vitest";
import { formatUsd } from "./format.js";

describe("formatUsd — adaptive USD precision", () => {
  it("renders not-measured (null/undefined/NaN) as an em dash", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  it("renders a measured zero as $0.00 (distinct from not-measured)", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("keeps 2 decimals for whole-dollar magnitudes", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(329.4321)).toBe("$329.43");
  });

  it("shows tiny sub-cent costs at ~3 significant figures instead of $0.0000", () => {
    // The bug: these all rendered $0.0000 under toFixed(4).
    expect(formatUsd(0.00002436)).toBe("$0.0000244");
    expect(formatUsd(0.0000034)).toBe("$0.0000034");
    expect(formatUsd(0.0347)).toBe("$0.0347");
  });

  it("trims trailing zeros but always keeps at least 2 decimals", () => {
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.87)).toBe("$0.87");
    expect(formatUsd(0.001)).toBe("$0.001");
  });

  it("never collapses a visible small non-zero cost to $0.00", () => {
    expect(formatUsd(0.0000244)).not.toBe("$0.00");
    expect(formatUsd(0.0000244)).not.toBe("$0.0000");
  });
});
