import type { RawMessage } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { chooseObserverCompaction, type EconomyCompactionPolicy } from "./compaction-policy.js";

function messages(tokens: number[]): RawMessage[] {
  return tokens.map((tokenEstimate, index) => ({
    id: `m${index + 1}`,
    threadId: "t1",
    role: "user" as const,
    content: `message ${index + 1}`,
    tokenEstimate,
    createdAt: new Date(1700000000000 + index),
  }));
}

const ECONOMY: EconomyCompactionPolicy = {
  mode: "economy",
  minRecentMessages: 2,
  minKeepRatio: 0.12,
  maxContextTokens: 200_000,
  forceAtContextRatio: 0.9,
  expectedRemainingCalls: 12,
  fixedPrefixTokens: 5_000,
  summaryOutputTokens: 500,
  summaryInstructionTokens: 70,
  averageInputTokens: 4_000,
  priceInputPerMtok: 3,
  priceCachePerMtok: 0.3,
  priceOutputPerMtok: 15,
  retentionRate: 0.8,
  priorCompactionCount: 0,
  distortionPenalty: 0.03,
  qualityPenalty: 0.2,
  minNetBenefitUsd: 0,
};

describe("chooseObserverCompaction", () => {
  it("preserves the fixed RECENT_KEEP=2 behaviour by default", () => {
    const decision = chooseObserverCompaction(messages([10, 10, 10, 10, 10, 10]));

    expect(decision.shouldCompact).toBe(true);
    expect(decision.keepRecent).toBe(2);
    expect(decision.compressedCount).toBe(4);
    expect(decision.reason).toBe("fixed");
  });

  it("skips economy compaction when the summary/cache churn is not worth it", () => {
    const decision = chooseObserverCompaction(messages([20, 20, 20, 20]), {
      ...ECONOMY,
      expectedRemainingCalls: 1,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("not_worth_it");
    expect(decision.compressedCount).toBe(0);
  });

  it("compacts a large old prefix when future savings beat the summary cost", () => {
    const decision = chooseObserverCompaction(
      messages([20_000, 20_000, 20_000, 500, 500]),
      ECONOMY,
    );

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("economy_positive");
    expect(decision.keepRecent).toBeLessThan(5);
    expect(decision.compressedTokens).toBeGreaterThan(decision.keptTokens);
  });

  it("forces compaction near the context ceiling even if the net benefit is negative", () => {
    const decision = chooseObserverCompaction(messages([100, 100, 100, 100]), {
      ...ECONOMY,
      maxContextTokens: 300,
      forceAtContextRatio: 0.9,
      expectedRemainingCalls: 1,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("forced_context_limit");
  });

  it("counts fixed prefix tokens when deciding forced context-limit compaction", () => {
    const decision = chooseObserverCompaction(messages([125, 125, 125, 125]), {
      ...ECONOMY,
      maxContextTokens: 6000,
      forceAtContextRatio: 0.9,
      fixedPrefixTokens: 5000,
      expectedRemainingCalls: 1,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("forced_context_limit");
  });
});
