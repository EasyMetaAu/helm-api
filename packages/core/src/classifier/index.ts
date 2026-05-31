// Classifier Layer-1 barrel — `scoreRequest` (the single entry point) plus the
// public types of the composed sub-modules. The engine is pure (aside from the
// injected momentum soft-state), zero-network, deterministic (CLAUDE.md
// principle 4). See engine.ts for the orchestration contract.

export {
  type CascadeDeps,
  type ClassificationResult as CascadeResult,
  classify,
  type DecidedBy,
  type EvalDecisionResult,
  type LaneId,
  type RulesResult,
} from "./cascade.js";
export { type DimensionHit, type DimensionScore, scoreDimensions } from "./dimensions.js";
export {
  type ClassificationResult,
  type Constraints,
  type ExplanationEntry,
  type ExplanationSource,
  type ScoreRequestDeps,
  scoreRequest,
} from "./engine.js";
export {
  applyMomentum,
  type MomentumDeps,
  type MomentumEntry,
  type MomentumResult,
  type MomentumStore,
  recordMomentum,
} from "./momentum.js";
export { createMemoryMomentumStore } from "./momentum-store.js";
export {
  applyOverrides,
  evaluateOverrides,
  type OverrideHit,
  type OverrideKind,
} from "./overrides.js";
export {
  detectCodeBlock,
  detectFilePath,
  detectMathNotation,
  detectStackTrace,
  detectTable,
  detectUrl,
} from "./signals.js";
export {
  detectTask,
  type TaskDetectResult,
  type TaskScore,
  type TaskType,
} from "./taskdetect.js";
export {
  boundaryConfidence,
  type Complexity,
  classifyTier,
  type TierResult,
} from "./tiers.js";
