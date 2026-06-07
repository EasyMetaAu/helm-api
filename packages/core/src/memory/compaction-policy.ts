import type { RawMessage } from "@helm/shared";
import type { ResolvedCompactionPricing } from "../catalog/cost.js";

// Auto-adaptive Observer compaction — the gateway's INTERNAL policy, not config.
// The fixed/economy modes (and their 17 hand-tuned knobs) are gone: prices and
// the context window resolve from the model catalog, workload stats are derived
// from data the observer job already loads, and the constants below are expert
// priors, not a tuning surface. Pure functions throughout (principle 4): the
// estimator glue in observer.ts feeds them, they never do I/O.
//
// THREE triggers, any one mandates compaction (memory formation and context
// management are both compaction's job — the old fixed mode bundled them):
//   1. size      — the uncovered segment reached segmentMinTokens. Always
//                  compact: observations are the raw material of the whole
//                  memory pipeline (reflections, facts), not an economic luxury.
//   2. idle      — the thread went quiet with uncovered messages (enqueued by
//                  the idle-flush sweep). Compact EVERYTHING (keepRecent=0) so
//                  the sweep's candidate query stops matching and terminates.
//   3. pressure  — thread tokens ≥ forceContextRatio × context window. Compact
//                  even a tiny segment, with the keep floor relaxed to 1.
// Below all three → no compaction. There is deliberately NO "soft" economic
// zone: a sub-threshold segment is never worth compacting at any realistic
// price (the summary-output cost dominates small slices), so an extra gate
// would be dead code.
//
// The net-benefit ledger (v2) picks the keep boundary and labels the decision:
//   - cache prices split read/write (Anthropic writes carry a premium;
//     OpenAI/DeepSeek writes are free) — the v1 single cache price was wrong
//     for both at once;
//   - the quality term is LINEAR in trimmed tokens (context-rot research —
//     Chroma, NoLiMa — shows concave degradation; v1's quadratic had the
//     curvature backwards) and shares ONE coefficient with distortion so the
//     two quality terms trade off in the same synthetic-USD axis;
//   - retention is the MEASURED compression ratio of this thread's prior
//     observations (v1 declared 0.8 by config while the truncation-stub
//     summarizer really keeps ~5% of a long slice — a config that lies);
//   - distortion compounds via retention^(priorCompactions+1), with the prior
//     count derived from the thread's actual observation rows (v1 pinned it to
//     a static 0, so the thrash brake never engaged).

export const AUTO_PRIORS = {
  // Memory-formation size trigger: enough raw material for one good summary.
  segmentMinTokens: 2048,
  // Idle-flush threshold (consumed by the idle sweep, colocated so the policy's
  // constants live in one place).
  idleFlushS: 3600,
  // Force line: production consensus band (MemGPT flushes at 100% and warns at
  // 70; Claude Code auto-compacts ~83.5–95%). 0.80 leaves headroom for a weak
  // summarizer.
  forceContextRatio: 0.8,
  // Keep floor for writeback compaction: ≥4 messages (~2 full user/assistant
  // turns) and ≥25% of the segment stay raw — cheap insurance while the
  // summarizer is a truncation stub.
  minRecentMessages: 4,
  minKeepRatio: 0.25,
  // ONE coefficient converts "quality" into synthetic USD for BOTH the linear
  // context-relief benefit and the distortion cost (v1 had two unrelated
  // knobs, which made the trade-off incoherent).
  qualityCoeff: 0.1,
  // Geometric-prior expectation of how many future calls amortize the cache
  // savings; matches the v1 default so zero-data behaviour is unchanged.
  expectedRemainingCalls: 8,
  // First-compaction retention prior (no measurement yet). The truncation stub
  // is lossy; 0.5 is deliberately mid, not the flattering v1 0.8.
  retentionPrior: 0.5,
  // Clamp band for measured retention: never below the truncation-stub floor,
  // never claim a lossless pass (0.95 keeps the distortion brake alive).
  retentionFloor: 0.05,
  retentionCeil: 0.95,
  // The truncation-stub summarizer caps output at 2000 chars ≈ 500 tokens; an
  // LLM summarizer should land in the same ballpark.
  summaryOutputCapTokens: 500,
  summaryInstructionTokens: 70,
  // Per-field price heuristics when the catalog has no published number:
  // read = 0.1 × input (Anthropic's discount — the most aggressive, biasing
  // toward valuing cache retention), write = free (the OpenAI/DeepSeek common
  // case), output = 5 × input (industry-typical ratio).
  cacheReadRatio: 0.1,
  outputRatio: 5,
  // Context window when the catalog doesn't know the model.
  fallbackMaxContextTokens: 200_000,
} as const;

export interface AutoCompactionInputs {
  // The thread went quiet (newest message older than the idle threshold) — the
  // observer derives this at RUN TIME from message ages, NOT from a job flag, so
  // it is race-free: a thread that got new activity between enqueue and run is
  // correctly seen as active. When idle, fold the WHOLE uncovered history (the
  // memory-formation backstop for short threads); raw rows survive regardless.
  idle: boolean;
  // Catalog lookup for the thread's last served model (all-null when unknown).
  pricing: ResolvedCompactionPricing;
  // = the thread's existing observation count (derived, not configured).
  priorCompactionCount: number;
  // Measured output/source token ratio of this thread's prior observations;
  // null on first compaction → retentionPrior.
  measuredRetention: number | null;
  // Token sum of the WHOLE thread (pressure-trigger numerator).
  threadTotalTokens: number;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  keepRecent: number;
  compressedCount: number;
  compressedTokens: number;
  keptTokens: number;
  netBenefitUsd: number;
  reason:
    | "memory_formation"
    | "economy_positive"
    | "forced_context_limit"
    | "idle_flush"
    | "below_thresholds"
    | "nothing_to_compact";
}

// Effective per-MTok prices after the per-field heuristics. input === null means
// the model is genuinely unpriced (local model, unknown alias): every monetary
// term collapses to 0 and compaction becomes a pure context/memory decision.
export interface EffectiveCompactionPrices {
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cacheReadPerMtok: number | null;
  cacheWritePerMtok: number | null;
  maxContextTokens: number;
}

export function effectiveCompactionPrices(
  pricing: ResolvedCompactionPricing,
): EffectiveCompactionPrices {
  const input = pricing.inputPerMtok;
  return {
    inputPerMtok: input,
    outputPerMtok:
      pricing.outputPerMtok ?? (input !== null ? input * AUTO_PRIORS.outputRatio : null),
    cacheReadPerMtok:
      pricing.cacheReadPerMtok ?? (input !== null ? input * AUTO_PRIORS.cacheReadRatio : null),
    cacheWritePerMtok: pricing.cacheWritePerMtok ?? (input !== null ? 0 : null),
    maxContextTokens: pricing.maxContextTokens ?? AUTO_PRIORS.fallbackMaxContextTokens,
  };
}

function tokenSum(messages: RawMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(0, message.tokenEstimate), 0);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Net USD benefit of compacting `compressedTokens` into one observation while
// keeping `keptTokens` raw, over the expected remaining calls. 0 for unpriced
// models — no money to save means the triggers alone decide.
function netBenefitUsd(
  compressedTokens: number,
  keptTokens: number,
  prices: EffectiveCompactionPrices,
  retained: number,
): number {
  const input = prices.inputPerMtok;
  if (input === null) return 0;
  // Heuristics guarantee these are non-null once input is known.
  const read = prices.cacheReadPerMtok ?? input * AUTO_PRIORS.cacheReadRatio;
  const write = prices.cacheWritePerMtok ?? 0;
  const output = prices.outputPerMtok ?? input * AUTO_PRIORS.outputRatio;

  const r = AUTO_PRIORS.expectedRemainingCalls;
  const summaryOut = Math.min(compressedTokens, AUTO_PRIORS.summaryOutputCapTokens);
  const trimmed = Math.max(0, compressedTokens - summaryOut);

  // Tokens removed from the cached prefix stop being re-read on every future call.
  const cacheSavings = ((r - 1) * read * trimmed) / 1_000_000;
  // Editing the prefix invalidates the cache once: the next call re-ingests the
  // new summary + the kept suffix at the WRITE rate (Anthropic charges a premium
  // for cache creation; free-write providers just pay plain input) instead of
  // the read rate it would have paid untouched.
  const writeRate = write > 0 ? write : input;
  const cacheInvalidation = ((summaryOut + keptTokens) * (writeRate - read)) / 1_000_000;
  // The summarizer call itself: it re-reads the compressed slice from cache
  // (it was just served), pays full input for its instruction, and output for
  // the summary. With the truncation stub this is booked but not billed; it
  // models the LLM summarizer this slot is reserved for.
  const summaryCallCost =
    (read * compressedTokens + input * AUTO_PRIORS.summaryInstructionTokens + output * summaryOut) /
    1_000_000;
  // Quality terms share ONE coefficient (synthetic USD): linear relief for
  // trimming context on every future call, against the compounding information
  // loss of reading a lossy summary instead of the raw turns.
  const qualityDollars = AUTO_PRIORS.qualityCoeff * input;
  const qualityBenefit = (qualityDollars * r * trimmed) / 1_000_000;
  const distortionCost =
    (qualityDollars * (1 - retained) * r * (keptTokens + summaryOut)) / 1_000_000;

  return cacheSavings + qualityBenefit - cacheInvalidation - summaryCallCost - distortionCost;
}

function noop(reason: CompactionDecision["reason"], keptTokens: number): CompactionDecision {
  return {
    shouldCompact: false,
    keepRecent: 0,
    compressedCount: 0,
    compressedTokens: 0,
    keptTokens,
    netBenefitUsd: 0,
    reason,
  };
}

// Decide whether/where to compact one contiguous uncovered segment. Pure: all
// estimator-derived inputs arrive via AutoCompactionInputs, every fallback is
// deterministic, and a given (segment, inputs) always yields the same decision.
export function chooseAutoCompaction(
  segment: RawMessage[],
  inputs: AutoCompactionInputs,
): CompactionDecision {
  const n = segment.length;
  if (n === 0) return noop("nothing_to_compact", 0);

  const prices = effectiveCompactionPrices(inputs.pricing);
  const retention = clamp(
    inputs.measuredRetention ?? AUTO_PRIORS.retentionPrior,
    AUTO_PRIORS.retentionFloor,
    AUTO_PRIORS.retentionCeil,
  );
  const retained = Math.max(
    retention ** (Math.max(0, inputs.priorCompactionCount) + 1),
    AUTO_PRIORS.retentionFloor,
  );

  // Idle flush: the thread went quiet — fold EVERYTHING into the observation so
  // the sweep's "has uncovered messages" candidate query stops matching. This is
  // the memory-formation backstop for short threads that never reach the size
  // trigger; raw rows stay in the store regardless (compaction never deletes).
  if (inputs.idle) {
    const compressedTokens = tokenSum(segment);
    return {
      shouldCompact: true,
      keepRecent: 0,
      compressedCount: n,
      compressedTokens,
      keptTokens: 0,
      netBenefitUsd: netBenefitUsd(compressedTokens, 0, prices, retained),
      reason: "idle_flush",
    };
  }

  const segmentTokens = tokenSum(segment);
  const forced =
    inputs.threadTotalTokens >= prices.maxContextTokens * AUTO_PRIORS.forceContextRatio;
  const sizeTriggered = segmentTokens >= AUTO_PRIORS.segmentMinTokens;

  if (!forced && !sizeTriggered) return noop("below_thresholds", segmentTokens);

  // Keep floor: writeback preserves a recent suffix raw; forced pressure relaxes
  // it to 1 so something can ALWAYS be freed near the context limit.
  const floor = forced
    ? 1
    : Math.max(AUTO_PRIORS.minRecentMessages, Math.ceil(n * AUTO_PRIORS.minKeepRatio));
  if (floor > n - 1) return noop("nothing_to_compact", segmentTokens);

  // O(n) boundary sweep: maximize the ledger; ties keep the floor (deepest
  // compression — for unpriced models every candidate is 0 and memory
  // formation wants the most material folded).
  let best: { keepRecent: number; benefit: number } | null = null;
  for (let keepRecent = floor; keepRecent <= n - 1; keepRecent += 1) {
    const compressed = segment.slice(0, n - keepRecent);
    const kept = segment.slice(n - keepRecent);
    const benefit = netBenefitUsd(tokenSum(compressed), tokenSum(kept), prices, retained);
    if (best === null || benefit > best.benefit) {
      best = { keepRecent, benefit };
    }
  }
  if (best === null) return noop("nothing_to_compact", segmentTokens);

  const compressed = segment.slice(0, n - best.keepRecent);
  const kept = segment.slice(n - best.keepRecent);
  return {
    shouldCompact: true,
    keepRecent: best.keepRecent,
    compressedCount: compressed.length,
    compressedTokens: tokenSum(compressed),
    keptTokens: tokenSum(kept),
    netBenefitUsd: best.benefit,
    reason: forced
      ? "forced_context_limit"
      : best.benefit > 0
        ? "economy_positive"
        : "memory_formation",
  };
}
