import type { RawMessage } from "@helm/shared";

export interface FixedCompactionPolicy {
  mode: "fixed";
  recentKeep: number;
}

export interface EconomyCompactionPolicy {
  mode: "economy";
  minRecentMessages: number;
  minKeepRatio: number;
  maxContextTokens: number;
  forceAtContextRatio: number;
  expectedRemainingCalls: number;
  fixedPrefixTokens: number;
  summaryOutputTokens: number;
  summaryInstructionTokens: number;
  averageInputTokens: number;
  priceInputPerMtok: number;
  priceCachePerMtok: number;
  priceOutputPerMtok: number;
  retentionRate: number;
  priorCompactionCount: number;
  distortionPenalty: number;
  qualityPenalty: number;
  minNetBenefitUsd: number;
}

export type ObserverCompactionPolicy = FixedCompactionPolicy | EconomyCompactionPolicy;

export interface CompactionDecision {
  shouldCompact: boolean;
  keepRecent: number;
  compressedCount: number;
  compressedTokens: number;
  keptTokens: number;
  netBenefitUsd: number;
  reason:
    | "fixed"
    | "economy_positive"
    | "forced_context_limit"
    | "not_worth_it"
    | "nothing_to_compact";
}

const DEFAULT_RECENT_KEEP = 2;

function tokenSum(messages: RawMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(0, message.tokenEstimate), 0);
}

function clampPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampRatio(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function fixedDecision(messages: RawMessage[], recentKeep: number): CompactionDecision {
  const keepRecent = Math.min(messages.length, Math.max(0, Math.floor(recentKeep)));
  const compressedCount = Math.max(0, messages.length - keepRecent);
  const compressed = messages.slice(0, compressedCount);
  const kept = messages.slice(compressedCount);
  if (compressedCount === 0) {
    return {
      shouldCompact: false,
      keepRecent,
      compressedCount: 0,
      compressedTokens: 0,
      keptTokens: tokenSum(kept),
      netBenefitUsd: 0,
      reason: "nothing_to_compact",
    };
  }
  return {
    shouldCompact: true,
    keepRecent,
    compressedCount,
    compressedTokens: tokenSum(compressed),
    keptTokens: tokenSum(kept),
    netBenefitUsd: 0,
    reason: "fixed",
  };
}

function netBenefitUsd(
  totalTokens: number,
  compressedTokens: number,
  keptTokens: number,
  cfg: EconomyCompactionPolicy,
): number {
  const r = Math.max(0, cfg.expectedRemainingCalls);
  const cacheSavings = ((r - 1) * cfg.priceCachePerMtok * compressedTokens) / 1_000_000;
  const cacheInvalidation =
    ((cfg.summaryOutputTokens + keptTokens) * (cfg.priceInputPerMtok - cfg.priceCachePerMtok)) /
    1_000_000;
  const summaryCallCost =
    (cfg.priceCachePerMtok * (cfg.fixedPrefixTokens + compressedTokens) +
      cfg.priceInputPerMtok * cfg.summaryInstructionTokens +
      cfg.priceOutputPerMtok * cfg.summaryOutputTokens) /
    1_000_000;
  const retained = Math.max(cfg.retentionRate ** (cfg.priorCompactionCount + 1), 0.37);
  const distortionCost =
    (cfg.distortionPenalty * (1 - retained) * r * cfg.averageInputTokens * cfg.priceInputPerMtok) /
    1_000_000;
  const before = cfg.fixedPrefixTokens + totalTokens;
  const after = cfg.fixedPrefixTokens + keptTokens;
  const qualityBenefit =
    (cfg.qualityPenalty * cfg.priceInputPerMtok * (before * before - after * after)) /
    (Math.max(1, cfg.maxContextTokens) * 1_000_000);
  return cacheSavings - cacheInvalidation - summaryCallCost - distortionCost + qualityBenefit;
}

// Choose the suffix to keep before the Observer summarizes old raw messages.
// Economy mode mirrors bash-agent's useful bit: evaluate the value of compacting
// and keep a turn-aligned recent suffix, instead of blindly summarizing on every job.
export function chooseObserverCompaction(
  messages: RawMessage[],
  policy: ObserverCompactionPolicy = { mode: "fixed", recentKeep: DEFAULT_RECENT_KEEP },
): CompactionDecision {
  if (policy.mode === "fixed") {
    return fixedDecision(messages, policy.recentKeep);
  }

  if (messages.length === 0) {
    return fixedDecision(messages, 0);
  }

  const totalTokens = tokenSum(messages);
  const minRecent = Math.max(
    1,
    clampPositiveInt(policy.minRecentMessages, DEFAULT_RECENT_KEEP),
    Math.ceil(messages.length * clampRatio(policy.minKeepRatio, 0.12)),
  );
  const forced =
    totalTokens >=
    Math.max(1, policy.maxContextTokens) * clampRatio(policy.forceAtContextRatio, 0.9);

  let best: CompactionDecision | null = null;
  for (
    let keepRecent = Math.min(messages.length, minRecent);
    keepRecent <= messages.length;
    keepRecent += 1
  ) {
    const compressedCount = messages.length - keepRecent;
    if (compressedCount <= 0) continue;
    const compressed = messages.slice(0, compressedCount);
    const kept = messages.slice(compressedCount);
    const compressedTokens = tokenSum(compressed);
    const keptTokens = tokenSum(kept);
    const benefit = netBenefitUsd(totalTokens, compressedTokens, keptTokens, policy);
    if (best === null || benefit > best.netBenefitUsd) {
      best = {
        shouldCompact: true,
        keepRecent,
        compressedCount,
        compressedTokens,
        keptTokens,
        netBenefitUsd: benefit,
        reason: forced ? "forced_context_limit" : "economy_positive",
      };
    }
  }

  if (best === null) return fixedDecision(messages, messages.length);
  if (forced) return best;
  if (best.netBenefitUsd > Math.max(0, policy.minNetBenefitUsd)) return best;
  return {
    ...best,
    shouldCompact: false,
    compressedCount: 0,
    compressedTokens: 0,
    keptTokens: totalTokens,
    netBenefitUsd: best.netBenefitUsd,
    reason: "not_worth_it",
  };
}
