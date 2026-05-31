import type { ClassifierRulesConfig } from "@helm/shared";

// Layer-1 tier gate — maps the continuous `rawScore` produced by `dimensions`
// onto four discrete complexity tiers and computes a confidence in that tier
// (distance from the nearest boundary, run through a sigmoid). A low confidence
// marks the request `uncertain`, which the engine task uses to cascade into the
// Layer-2 eval. Per CLAUDE.md principle 4 this is a PURE function: same input =>
// same output, zero I/O. Boundaries, slope (k) and threshold are all DATA from
// classifier.yaml — never hard-coded. See docs/03-classification.md §Layer 1 and
// docs/research-notes.md (Manifest).

export type Complexity = "simple" | "standard" | "complex" | "reasoning";

export interface TierResult {
  /** The tier `rawScore` falls into (half-open [lower, upper) intervals). */
  complexity: Complexity;
  /** Normalized boundary confidence ∈ [0, 1): 1 - e^(-k · distance-to-boundary). */
  confidence: number;
  /** confidence < confidence_threshold → cascade into Layer-2 eval. */
  uncertain: boolean;
  /** Distance to the nearest adjacent boundary — for explanation/debugging. */
  nearestBoundaryDistance: number;
}

// confidence = 2·sigmoid(k·distance) - 1  ( = tanh(k·distance/2) ). distance ≥ 0,
// so the result lives in [0, 1): exactly at a boundary (distance 0) confidence is
// 0 (maximally uncertain — boundary-hugging), far from any boundary it approaches
// 1 (certain). This is the rescaled half of the logistic curve: it takes the old
// [0.5, 1) sigmoid output and stretches it back onto the full [0, 1) range.
//
// This normalization is what lets the DEFAULT confidence_threshold (0.45) actually
// cascade: a score inside the boundary band now dips below 0.45 → uncertain →
// Layer-2 eval (the old [0.5, 1) sigmoid never could). See implementation-notes
// (classifier.confidence-fix) and docs/03 §Layer 1.
export function boundaryConfidence(distance: number, k: number): number {
  return 2 / (1 + Math.exp(-k * distance)) - 1;
}

// Pure tier classifier. Half-open intervals, left-closed:
//   rawScore <  standard            → simple
//   standard ≤ rawScore <  complex  → standard
//   complex  ≤ rawScore <  reasoning→ complex
//   rawScore ≥  reasoning           → reasoning
export function classifyTier(rawScore: number, cfg: ClassifierRulesConfig): TierResult {
  const { standard, complex, reasoning } = cfg.tier_boundaries;
  const boundaries = [standard, complex, reasoning];

  // Defensive degradation (principle 3, fail-open spirit): a non-finite upstream
  // score must not crash the gate. Fall back to the safe, observable `standard`
  // tier with zero confidence so the cascade treats it as uncertain.
  if (!Number.isFinite(rawScore)) {
    return {
      complexity: "standard",
      confidence: 0,
      uncertain: true,
      nearestBoundaryDistance: 0,
    };
  }

  const complexity = tierFor(rawScore, standard, complex, reasoning);
  const nearestBoundaryDistance = nearestDistance(rawScore, boundaries);
  const confidence = boundaryConfidence(nearestBoundaryDistance, cfg.sigmoid_k);
  const uncertain = confidence < cfg.confidence_threshold;

  return { complexity, confidence, uncertain, nearestBoundaryDistance };
}

function tierFor(score: number, standard: number, complex: number, reasoning: number): Complexity {
  if (score < standard) return "simple";
  if (score < complex) return "standard";
  if (score < reasoning) return "complex";
  return "reasoning";
}

// Distance to the nearest boundary. For the lowest/highest tiers this is simply
// the single adjacent boundary (one-sided); for the middle tiers it is the
// closer of the two enclosing boundaries.
function nearestDistance(score: number, boundaries: number[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const b of boundaries) {
    const d = Math.abs(score - b);
    if (d < min) min = d;
  }
  return min;
}
