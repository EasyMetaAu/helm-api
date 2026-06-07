import type { RawMessage } from "@helm/shared";
import { describe, expect, it } from "vitest";
import type { ResolvedCompactionPricing } from "../catalog/cost.js";
import {
  AUTO_PRIORS,
  type AutoCompactionInputs,
  chooseAutoCompaction,
  effectiveCompactionPrices,
} from "./compaction-policy.js";

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

const UNPRICED: ResolvedCompactionPricing = {
  modelKey: null,
  inputPerMtok: null,
  outputPerMtok: null,
  cacheReadPerMtok: null,
  cacheWritePerMtok: null,
  maxContextTokens: null,
};

const CLAUDE_PRICED: ResolvedCompactionPricing = {
  modelKey: "anthropic/claude-3-5-sonnet",
  inputPerMtok: 3,
  outputPerMtok: 15,
  cacheReadPerMtok: 0.3,
  cacheWritePerMtok: 3.75,
  maxContextTokens: 200_000,
};

function inputs(overrides: Partial<AutoCompactionInputs> = {}): AutoCompactionInputs {
  return {
    idle: false,
    pricing: UNPRICED,
    priorCompactionCount: 0,
    measuredRetention: null,
    threadTotalTokens: 0,
    ...overrides,
  };
}

describe("effectiveCompactionPrices — per-field heuristics for unpublished prices", () => {
  it("passes through fully-published prices untouched", () => {
    const p = effectiveCompactionPrices(CLAUDE_PRICED);
    expect(p).toEqual({
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.3,
      cacheWritePerMtok: 3.75,
      maxContextTokens: 200_000,
    });
  });

  it("derives missing cache/output prices from input (read=0.1×, write=free, output=5×)", () => {
    const p = effectiveCompactionPrices({
      ...UNPRICED,
      inputPerMtok: 2,
      maxContextTokens: 128_000,
    });
    expect(p.cacheReadPerMtok).toBeCloseTo(0.2, 9);
    expect(p.cacheWritePerMtok).toBe(0);
    expect(p.outputPerMtok).toBeCloseTo(10, 9);
  });

  it("an unpriced model stays unpriced (input null), context falls back to 200k", () => {
    const p = effectiveCompactionPrices(UNPRICED);
    expect(p.inputPerMtok).toBeNull();
    expect(p.maxContextTokens).toBe(200_000);
  });
});

describe("chooseAutoCompaction — empty / tiny segments", () => {
  it("an empty segment never compacts", () => {
    const decision = chooseAutoCompaction([], inputs());
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("nothing_to_compact");
  });

  it("a segment with no compactable prefix (n ≤ keep floor) never compacts", () => {
    // 3 messages < minRecentMessages=4 floor; even a big-token segment cannot
    // produce a non-empty compressed prefix.
    const decision = chooseAutoCompaction(messages([1000, 1000, 1000]), inputs());
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("nothing_to_compact");
  });
});

describe("chooseAutoCompaction — idle flush", () => {
  it("compacts the WHOLE segment (keepRecent=0) so the sweep terminates", () => {
    const segment = messages([100, 100, 100]); // tiny — size threshold irrelevant
    const decision = chooseAutoCompaction(segment, inputs({ idle: true }));
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("idle_flush");
    expect(decision.keepRecent).toBe(0);
    expect(decision.compressedCount).toBe(3);
    expect(decision.compressedTokens).toBe(300);
    expect(decision.keptTokens).toBe(0);
  });

  it("works for unpriced models (memory formation is not an economic decision)", () => {
    const decision = chooseAutoCompaction(messages([50]), inputs({ idle: true }));
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("idle_flush");
  });

  it("an empty idle segment is still a noop", () => {
    const decision = chooseAutoCompaction([], inputs({ idle: true }));
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("nothing_to_compact");
  });
});

describe("chooseAutoCompaction — memory-formation size trigger", () => {
  it("stays put below the size threshold with no context pressure", () => {
    const segment = messages([500, 500, 500, 100, 100, 100]); // 1800 < 2048
    const decision = chooseAutoCompaction(segment, inputs({ threadTotalTokens: 1800 }));
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("below_thresholds");
  });

  it("compacts once the uncovered segment crosses the size threshold — even unpriced", () => {
    const segment = messages([800, 800, 800, 100, 100, 100, 100, 100]); // 2900 ≥ 2048
    const decision = chooseAutoCompaction(segment, inputs({ threadTotalTokens: 2900 }));
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("memory_formation");
    expect(decision.compressedCount).toBeGreaterThan(0);
  });

  it("keeps at least max(minRecentMessages, ceil(minKeepRatio×n)) recent messages", () => {
    const segment = messages(Array.from({ length: 20 }, () => 200)); // 4000 tokens
    const decision = chooseAutoCompaction(segment, inputs({ threadTotalTokens: 4000 }));
    expect(decision.shouldCompact).toBe(true);
    const floor = Math.max(
      AUTO_PRIORS.minRecentMessages,
      Math.ceil(segment.length * AUTO_PRIORS.minKeepRatio),
    );
    expect(decision.keepRecent).toBeGreaterThanOrEqual(floor);
    expect(decision.keepRecent).toBeLessThan(segment.length);
  });

  it("reports economy_positive instead when the priced ledger is net-positive", () => {
    const segment = messages(Array.from({ length: 40 }, () => 500)); // 20k tokens
    const decision = chooseAutoCompaction(
      segment,
      inputs({ pricing: CLAUDE_PRICED, threadTotalTokens: 20_000 }),
    );
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("economy_positive");
    expect(decision.netBenefitUsd).toBeGreaterThan(0);
  });
});

describe("chooseAutoCompaction — context-pressure triggers", () => {
  it("forces compaction at ≥ forceContextRatio even for a small segment", () => {
    const segment = messages([200, 200, 200, 200, 200]); // 1000 < 2048
    const decision = chooseAutoCompaction(
      segment,
      inputs({
        pricing: { ...CLAUDE_PRICED, maxContextTokens: 10_000 },
        threadTotalTokens: 9_000, // 0.9 ≥ 0.8
      }),
    );
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("forced_context_limit");
  });

  it("forced mode relaxes the keep floor so SOMETHING can always be freed", () => {
    // 3 huge messages: writeback floor (4) would forbid any compaction, but at
    // 90% context utilization we must free space — floor drops to 1.
    const segment = messages([3000, 3000, 3000]);
    const decision = chooseAutoCompaction(
      segment,
      inputs({
        pricing: { ...CLAUDE_PRICED, maxContextTokens: 10_000 },
        threadTotalTokens: 9_000,
      }),
    );
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("forced_context_limit");
    expect(decision.keepRecent).toBeGreaterThanOrEqual(1);
    expect(decision.compressedCount).toBeGreaterThanOrEqual(1);
  });

  it("high utilization below the force line does NOT compact a sub-threshold segment", () => {
    // 75% utilization but only a 2000-token uncovered segment: at any realistic
    // price the summary-output cost dominates a sub-2048 slice, so there is no
    // "soft zone" — below forceContextRatio the size trigger is the only mandate.
    const bigWin = messages(Array.from({ length: 8 }, () => 250)); // 2000 < 2048
    for (const pricing of [CLAUDE_PRICED, UNPRICED]) {
      const decision = chooseAutoCompaction(
        bigWin,
        inputs({ pricing: { ...pricing, maxContextTokens: 100_000 }, threadTotalTokens: 75_000 }),
      );
      expect(decision.shouldCompact).toBe(false);
      expect(decision.reason).toBe("below_thresholds");
    }
  });

  it("a null context window falls back to 200k for the pressure ratio", () => {
    const segment = messages([100, 100, 100, 100, 100]);
    // 170k / 200k fallback = 0.85 ≥ 0.8 → forced, proving the fallback window applies.
    const forced = chooseAutoCompaction(segment, inputs({ threadTotalTokens: 170_000 }));
    expect(forced.shouldCompact).toBe(true);
    expect(forced.reason).toBe("forced_context_limit");
    // 150k / 200k = 0.75 < 0.8 → no mandate (a smaller fallback would have forced).
    const calm = chooseAutoCompaction(segment, inputs({ threadTotalTokens: 150_000 }));
    expect(calm.shouldCompact).toBe(false);
    expect(calm.reason).toBe("below_thresholds");
  });
});

describe("chooseAutoCompaction — distortion compounding (anti-thrash)", () => {
  it("net benefit shrinks monotonically as priorCompactionCount grows", () => {
    const segment = messages(Array.from({ length: 40 }, () => 500));
    const benefitAt = (count: number) =>
      chooseAutoCompaction(
        segment,
        inputs({
          pricing: CLAUDE_PRICED,
          threadTotalTokens: 20_000,
          priorCompactionCount: count,
        }),
      ).netBenefitUsd;
    const b0 = benefitAt(0);
    const b3 = benefitAt(3);
    const b10 = benefitAt(10);
    expect(b3).toBeLessThan(b0);
    expect(b10).toBeLessThanOrEqual(b3);
  });

  it("a worse measured retention lowers the benefit vs the prior", () => {
    const segment = messages(Array.from({ length: 40 }, () => 500));
    const benefitWith = (measuredRetention: number | null) =>
      chooseAutoCompaction(
        segment,
        inputs({ pricing: CLAUDE_PRICED, threadTotalTokens: 20_000, measuredRetention }),
      ).netBenefitUsd;
    // Truncation-stub reality (~5%) must look strictly worse than a hypothetical
    // high-fidelity summarizer (95%).
    expect(benefitWith(0.05)).toBeLessThan(benefitWith(0.95));
    // measuredRetention is clamped — an absurd >1 value behaves like the ceiling.
    expect(benefitWith(5)).toBeCloseTo(benefitWith(0.95), 12);
  });
});
