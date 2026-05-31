import type { ClassifierRulesConfig } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { boundaryConfidence, classifyTier } from "./tiers.js";

// A minimal classifier rules config focused on the tier surface: boundaries,
// sigmoid slope, confidence threshold. Dimensions are irrelevant here (tiers
// consumes only rawScore), so we parse through the real schema for honest
// defaults and override only the tier-relevant fields.
function makeConfig(
  overrides: Partial<{
    confidence_threshold: number;
    sigmoid_k: number;
    tier_boundaries: { standard?: number; complex?: number; reasoning?: number };
  }> = {},
): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {},
    task_keywords: {},
    tool_prefixes: {},
    tier_boundaries: overrides.tier_boundaries ?? {},
    overrides: {},
    momentum: {},
    ...(overrides.confidence_threshold !== undefined
      ? { confidence_threshold: overrides.confidence_threshold }
      : {}),
    ...(overrides.sigmoid_k !== undefined ? { sigmoid_k: overrides.sigmoid_k } : {}),
  });
}

describe("classifyTier — four-tier mapping", () => {
  it("maps representative scores to each tier (normal)", () => {
    const cfg = makeConfig();
    expect(classifyTier(-0.5, cfg).complexity).toBe("simple");
    expect(classifyTier(-0.05, cfg).complexity).toBe("standard");
    expect(classifyTier(0.2, cfg).complexity).toBe("complex");
    expect(classifyTier(0.5, cfg).complexity).toBe("reasoning");
  });

  it("uses half-open [lower, upper) intervals at exact boundaries (edge)", () => {
    const cfg = makeConfig();
    // boundary value belongs to the upper tier (left-closed)
    expect(classifyTier(-0.1, cfg).complexity).toBe("standard");
    expect(classifyTier(0.08, cfg).complexity).toBe("complex");
    expect(classifyTier(0.35, cfg).complexity).toBe("reasoning");
    // just below a boundary stays in the lower tier
    expect(classifyTier(-0.1000001, cfg).complexity).toBe("simple");
  });
});

describe("classifyTier — confidence gate", () => {
  it("yields high confidence far from any boundary (normal)", () => {
    const cfg = makeConfig();
    const res = classifyTier(0.9, cfg); // distance to reasoning(0.35) = 0.55
    expect(res.confidence).toBeGreaterThan(0.95); // 2·sigmoid(8·0.55)-1 ≈ 0.976
    expect(res.uncertain).toBe(false);
    expect(res.nearestBoundaryDistance).toBeCloseTo(0.55, 6);
  });

  it("collapses confidence toward 0 (the minimum) when hugging a boundary (edge)", () => {
    const cfg = makeConfig();
    const res = classifyTier(0.081, cfg); // distance to complex(0.08) = 0.001
    expect(res.complexity).toBe("complex");
    // confidence = 1 - e^(-k·d) bottoms out at 0 as d→0 — maximally uncertain,
    // BELOW the default 0.45 gate so the cascade reaches Layer-2 eval. Far below
    // the high-confidence (~1) of a score far from any boundary.
    expect(res.confidence).toBeGreaterThanOrEqual(0);
    expect(res.confidence).toBeLessThan(0.45);
    expect(res.uncertain).toBe(true); // hugging the boundary at the default 0.45 gate
    expect(res.confidence).toBeLessThan(classifyTier(0.9, cfg).confidence);
  });

  it("treats confidence_threshold as data — same score flips uncertain (normal)", () => {
    const score = -0.3; // distance to standard(-0.10) = 0.20 -> confidence ≈ 0.664
    const lenient = classifyTier(score, makeConfig({ confidence_threshold: 0.45 }));
    const strict = classifyTier(score, makeConfig({ confidence_threshold: 0.7 }));
    // confidence is identical; only the gate moves
    expect(lenient.confidence).toBeCloseTo(strict.confidence, 12);
    expect(lenient.uncertain).toBe(false); // ≈0.664 ≥ 0.45
    expect(strict.uncertain).toBe(true); // ≈0.664 < 0.7
  });

  it("a boundary-band score is uncertain under the DEFAULT 0.45 gate (normal)", () => {
    // The whole point of the fix: with the default threshold, a score sitting
    // inside the boundary band yields confidence < 0.45 -> uncertain -> cascade.
    const cfg = makeConfig(); // default confidence_threshold 0.45, k=8
    const hugging = classifyTier(0.085, cfg); // distance to complex(0.08) = 0.005
    expect(hugging.confidence).toBeLessThan(0.45);
    expect(hugging.uncertain).toBe(true);
    // …while a clearly-typed score (far from any boundary) stays certain.
    const clear = classifyTier(0.9, cfg);
    expect(clear.confidence).toBeGreaterThan(0.45);
    expect(clear.uncertain).toBe(false);
  });
});

describe("classifyTier — boundaries are data", () => {
  it("retunes tiers when tier_boundaries change (normal)", () => {
    const score = 0.1;
    const base = classifyTier(score, makeConfig()); // complex(0.08) => complex
    expect(base.complexity).toBe("complex");
    const retuned = classifyTier(score, makeConfig({ tier_boundaries: { complex: 0.2 } }));
    expect(retuned.complexity).toBe("standard");
  });
});

describe("boundaryConfidence", () => {
  it("returns 0 at distance 0 and is monotonically increasing toward 1 (edge)", () => {
    const k = 8;
    // boundary-hugging (d→0) => 0 (max uncertain); far-from-boundary => ~1.
    expect(boundaryConfidence(0, k)).toBeCloseTo(0, 12);
    expect(boundaryConfidence(0.1, k)).toBeGreaterThan(boundaryConfidence(0.05, k));
    expect(boundaryConfidence(1, k)).toBeGreaterThan(boundaryConfidence(0.1, k));
    expect(boundaryConfidence(0.5, k)).toBeLessThan(1); // approaches but never reaches 1
  });

  it("matches the closed-form 2·sigmoid(k·d) - 1 (edge)", () => {
    // k=8, d=0.1 -> 2/(1+e^-0.8) - 1 ≈ 0.3799490 (= tanh(0.4))
    const sigmoid = 1 / (1 + Math.exp(-8 * 0.1));
    expect(boundaryConfidence(0.1, 8)).toBeCloseTo(2 * sigmoid - 1, 12);
    expect(boundaryConfidence(0.1, 8)).toBeCloseTo(Math.tanh(0.4), 12);
  });
});

describe("classifyTier — defensive degradation", () => {
  it("does not throw on NaN / Infinity and falls back to standard (failure)", () => {
    const cfg = makeConfig();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const res = classifyTier(bad, cfg);
      expect(res.complexity).toBe("standard");
      expect(Number.isFinite(res.confidence)).toBe(true);
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
      // a degraded, uncertain signal — pushes the cascade to Layer-2 / balanced
      expect(res.uncertain).toBe(true);
    }
  });
});
