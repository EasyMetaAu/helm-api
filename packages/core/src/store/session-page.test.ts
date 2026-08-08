import { describe, expect, it } from "vitest";
import { __sessionPageSelfCheck, selectStreamingSessionRevisions } from "./session-page.js";

describe("selectStreamingSessionRevisions", () => {
  it("passes its inline self-check", () => {
    expect(() => __sessionPageSelfCheck()).not.toThrow();
  });

  it("always returns the first row even when it alone exceeds maxBytes", () => {
    expect(selectStreamingSessionRevisions([{ sequence: 7, bytes: 10_000 }], 10, 1)).toEqual([7]);
  });

  it("treats maxBytes as a soft ceiling once a row is selected", () => {
    expect(
      selectStreamingSessionRevisions(
        [
          { sequence: 1, bytes: 20 },
          { sequence: 2, bytes: 20 },
          { sequence: 3, bytes: 20 },
        ],
        10,
        30,
      ),
    ).toEqual([1]);
  });

  it("packs multiple rows while they fit under maxBytes", () => {
    expect(
      selectStreamingSessionRevisions(
        [
          { sequence: 1, bytes: 10 },
          { sequence: 2, bytes: 10 },
          { sequence: 3, bytes: 10 },
        ],
        10,
        25,
      ),
    ).toEqual([1, 2]);
  });

  it("never exceeds limit", () => {
    expect(
      selectStreamingSessionRevisions(
        [
          { sequence: 1, bytes: 1 },
          { sequence: 2, bytes: 1 },
          { sequence: 3, bytes: 1 },
        ],
        2,
        1_000,
      ),
    ).toEqual([1, 2]);
  });

  it("counts legacy unmeasurable bytes as zero so the row is still returned", () => {
    expect(
      selectStreamingSessionRevisions(
        [
          { sequence: 1, bytes: Number.NaN },
          { sequence: 2, bytes: -5 },
        ],
        10,
        0,
      ),
    ).toEqual([1, 2]);
  });
});
