import { describe, expect, it } from "vitest";
import { RRF_K, reciprocalRankFusion } from "./rrf.js";

// docs/14 / docs/12 P8 — Reciprocal Rank Fusion. Rank-based, scale-free, no tuned
// weights, deterministic. These cases pin the contract the hybrid recall depends on:
// consensus wins, contributions sum, k is the documented constant, ties are stable.
describe("reciprocalRankFusion", () => {
  it("a single ranked list preserves its order", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]]);
    expect(fused.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("a consensus item (present in multiple lists) outranks a single-list leader", () => {
    // 'x' is 2nd in BOTH lists; 'a'/'c' lead only one list each. Consensus wins.
    const fused = reciprocalRankFusion([
      ["a", "x", "b"],
      ["c", "x", "d"],
    ]);
    expect(fused[0]?.id).toBe("x");
  });

  it("uses k=60 by default and the documented 1/(k+rank) score", () => {
    expect(RRF_K).toBe(60);
    const fused = reciprocalRankFusion([["a"]]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  it("sums contributions across lists for the same id", () => {
    const fused = reciprocalRankFusion([["a"], ["a"]]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 10);
  });

  it("skips empty lists and dedups ids", () => {
    const fused = reciprocalRankFusion([[], ["a", "b"], []]);
    expect(fused.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("breaks score ties deterministically by id ascending (stable across runs)", () => {
    // 'a' and 'b' each appear once at rank 1 in separate lists → equal score.
    const fused = reciprocalRankFusion([["b"], ["a"]]);
    expect(fused.map((r) => r.id)).toEqual(["a", "b"]);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? Number.NaN, 10);
  });

  it("respects a custom k", () => {
    const fused = reciprocalRankFusion([["a"]], 9);
    expect(fused[0]?.score).toBeCloseTo(1 / 10, 10);
  });
});
