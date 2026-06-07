import { UpstreamError } from "@helm/core";
import { describe, expect, it } from "vitest";
import { isUpstreamTimeout } from "./stream-error.js";

describe("isUpstreamTimeout", () => {
  it("is true for an UpstreamError with errorClass === 'timeout'", () => {
    expect(isUpstreamTimeout(new UpstreamError("timeout", "stalled"))).toBe(true);
  });

  it("is false for an UpstreamError with a different class", () => {
    expect(isUpstreamTimeout(new UpstreamError("upstream_error", "boom", null, 500))).toBe(false);
  });

  it("is false for a plain Error, a string, or null", () => {
    expect(isUpstreamTimeout(new Error("nope"))).toBe(false);
    expect(isUpstreamTimeout("timeout")).toBe(false);
    expect(isUpstreamTimeout(null)).toBe(false);
    expect(isUpstreamTimeout(undefined)).toBe(false);
  });
});
