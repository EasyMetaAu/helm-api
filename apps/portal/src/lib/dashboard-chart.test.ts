import { describe, expect, it } from "vitest";
import { tokenSharePct } from "./dashboard-chart";

describe("tokenSharePct", () => {
  it("computes a model's share of the total tokens, rounded to a whole percent", () => {
    expect(tokenSharePct(250, 1000)).toBe(25);
    expect(tokenSharePct(1, 3)).toBe(33);
  });

  it("returns 0 when the total is zero or negative (never NaN/Infinity)", () => {
    expect(tokenSharePct(0, 0)).toBe(0);
    expect(tokenSharePct(100, 0)).toBe(0);
    expect(tokenSharePct(100, -5)).toBe(0);
  });
});
