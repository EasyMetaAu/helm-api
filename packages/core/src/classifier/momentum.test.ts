import type { ClassifierRulesConfig } from "@helm/shared";
import { ClassifierRulesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  applyMomentum,
  type MomentumDeps,
  type MomentumEntry,
  recordMomentum,
} from "./momentum.js";
import { createMemoryMomentumStore } from "./momentum-store.js";

// Parse through the real schema for honest defaults and override only the
// momentum block. Momentum consumes only `cfg.momentum`, so the rest of the
// scoring surface is irrelevant here.
function makeConfig(
  momentumBlock: Partial<{
    enabled: boolean;
    ttl_sec: number;
    history_size: number;
    short_message_max_chars: number;
    disable_above_chars: number;
    max_history_weight: number;
  }> = {},
): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {},
    task_keywords: {},
    tool_prefixes: {},
    tier_boundaries: {},
    overrides: {},
    momentum: momentumBlock,
  });
}

// Fixed clock helper — momentum's `now()` is injected so TTL / record timestamps
// are deterministic (CLAUDE.md principle 4).
function deps(
  opts: {
    cfg?: ClassifierRulesConfig;
    now?: number;
    seed?: { sessionKey: string; entries: MomentumEntry[] };
  } = {},
): MomentumDeps {
  const store = createMemoryMomentumStore();
  if (opts.seed) {
    for (const e of opts.seed.entries) store.push(opts.seed.sessionKey, e);
  }
  return {
    store,
    now: () => opts.now ?? 1_000_000_000,
    cfg: opts.cfg ?? makeConfig(),
  };
}

const REASONING_SCORE = 0.5; // well into reasoning tier (boundary 0.35)
const NOW = 1_000_000_000;

describe("applyMomentum", () => {
  it("pulls a short follow-up back toward reasoning history (normal)", () => {
    // History: three reasoning turns with high rawScore.
    const entries: MomentumEntry[] = [
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 1000 },
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 800 },
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 500 },
    ];
    const d = deps({ now: NOW, seed: { sessionKey: "s1", entries } });

    // "yes" — 3 chars, well under short_message_max_chars(30).
    const out = applyMomentum({ sessionKey: "s1", rawScore: -0.4, messageChars: 3 }, d);

    expect(out.momentumApplied).toBe(true);
    expect(out.historyWeight).toBeCloseTo(0.6, 5);
    // adjusted = (1-0.6)*(-0.4) + 0.6*0.5 = -0.16 + 0.3 = 0.14 — pulled way up.
    expect(out.adjustedRawScore).toBeCloseTo(0.14, 5);
    expect(out.adjustedRawScore).toBeGreaterThan(-0.4);
  });

  it("disables momentum for a long message (edge)", () => {
    const entries: MomentumEntry[] = [
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 100 },
    ];
    const d = deps({ now: NOW, seed: { sessionKey: "s1", entries } });
    const longText = "x".repeat(120); // > disable_above_chars(100)

    const out = applyMomentum(
      { sessionKey: "s1", rawScore: -0.4, messageChars: longText.length },
      d,
    );

    expect(out.historyWeight).toBe(0);
    expect(out.momentumApplied).toBe(false);
    expect(out.adjustedRawScore).toBe(-0.4); // verbatim
  });

  it("interpolates weight monotonically by length (edge)", () => {
    const entries: MomentumEntry[] = [
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 100 },
    ];
    const seed = { sessionKey: "s1", entries };

    const at30 = applyMomentum(
      { sessionKey: "s1", rawScore: -0.4, messageChars: 30 },
      deps({ now: NOW, seed }),
    );
    const at65 = applyMomentum(
      { sessionKey: "s1", rawScore: -0.4, messageChars: 65 },
      deps({ now: NOW, seed }),
    );
    const at100 = applyMomentum(
      { sessionKey: "s1", rawScore: -0.4, messageChars: 100 },
      deps({ now: NOW, seed }),
    );

    expect(at30.historyWeight).toBeCloseTo(0.6, 5); // full at the short cutoff
    expect(at100.historyWeight).toBe(0); // off at the disable cutoff
    // 65 is the midpoint of [30,100] → ~half of max weight (0.3), strictly between.
    expect(at65.historyWeight).toBeLessThan(0.6);
    expect(at65.historyWeight).toBeGreaterThan(0);
    expect(at65.historyWeight).toBeCloseTo(0.3, 5);
    // Monotonic non-increasing with length.
    expect(at30.historyWeight).toBeGreaterThan(at65.historyWeight);
    expect(at65.historyWeight).toBeGreaterThan(at100.historyWeight);
  });

  it("excludes expired history beyond ttl_sec (edge)", () => {
    // ttl = 1800s → expiry boundary at NOW - 1_800_000 ms.
    const fresh: MomentumEntry = {
      complexity: "reasoning",
      rawScore: REASONING_SCORE,
      at: NOW - 1000,
    };
    const expired: MomentumEntry = {
      complexity: "reasoning",
      rawScore: REASONING_SCORE,
      at: NOW - 1_800_001, // just over the TTL
    };
    const d = deps({ now: NOW, seed: { sessionKey: "s1", entries: [expired, fresh] } });

    const out = applyMomentum({ sessionKey: "s1", rawScore: -0.4, messageChars: 3 }, d);
    // Only the fresh entry averages in → same as the single-entry case.
    expect(out.momentumApplied).toBe(true);
    expect(out.adjustedRawScore).toBeCloseTo(0.14, 5);
  });

  it("treats fully-expired history as no history (edge)", () => {
    const expired: MomentumEntry = {
      complexity: "reasoning",
      rawScore: REASONING_SCORE,
      at: NOW - 5_000_000,
    };
    const d = deps({ now: NOW, seed: { sessionKey: "s1", entries: [expired] } });

    const out = applyMomentum({ sessionKey: "s1", rawScore: -0.4, messageChars: 3 }, d);
    expect(out.momentumApplied).toBe(false);
    expect(out.adjustedRawScore).toBe(-0.4);
  });

  it("keeps only the most recent history_size entries (edge)", () => {
    // history_size(5): push 7, the two oldest (low score) must not skew the avg.
    const store = createMemoryMomentumStore();
    for (let i = 0; i < 2; i++) {
      store.push("s1", { complexity: "simple", rawScore: -1, at: NOW - 9000 + i });
    }
    for (let i = 0; i < 5; i++) {
      store.push("s1", {
        complexity: "reasoning",
        rawScore: REASONING_SCORE,
        at: NOW - 1000 + i,
      });
    }
    const cfg = makeConfig();
    const d: MomentumDeps = { store, now: () => NOW, cfg };

    const out = applyMomentum({ sessionKey: "s1", rawScore: -0.4, messageChars: 3 }, d);
    // Average is over the 5 reasoning entries only (=0.5), the -1 entries dropped.
    expect(out.adjustedRawScore).toBeCloseTo(0.14, 5);
  });

  it("bypasses momentum when there is no session key (failure)", () => {
    let getCalls = 0;
    const store = createMemoryMomentumStore();
    const wrapped: MomentumDeps["store"] = {
      get: (k) => {
        getCalls++;
        return store.get(k);
      },
      push: (k, e) => store.push(k, e),
    };
    const d: MomentumDeps = { store: wrapped, now: () => NOW, cfg: makeConfig() };

    const out = applyMomentum({ sessionKey: null, rawScore: -0.4, messageChars: 3 }, d);
    expect(out.momentumApplied).toBe(false);
    expect(out.adjustedRawScore).toBe(-0.4);
    expect(out.historyWeight).toBe(0);
    expect(getCalls).toBe(0); // store not read
  });

  it("bypasses entirely when momentum is disabled (normal)", () => {
    const entries: MomentumEntry[] = [
      { complexity: "reasoning", rawScore: REASONING_SCORE, at: NOW - 100 },
    ];
    const d = deps({
      now: NOW,
      cfg: makeConfig({ enabled: false }),
      seed: { sessionKey: "s1", entries },
    });
    const out = applyMomentum({ sessionKey: "s1", rawScore: -0.4, messageChars: 3 }, d);
    expect(out.momentumApplied).toBe(false);
    expect(out.adjustedRawScore).toBe(-0.4);
    expect(out.historyWeight).toBe(0);
  });
});

describe("recordMomentum", () => {
  it("appends the final classification stamped with injected now (normal)", () => {
    const d = deps({ now: NOW });
    expect(d.store.get("s1")).toHaveLength(0);

    recordMomentum(
      "s1",
      { complexity: "reasoning", rawScore: 0.5, at: 0 /* ignored, restamped */ },
      d,
    );

    const hist = d.store.get("s1");
    expect(hist).toHaveLength(1);
    const [entry] = hist;
    expect(entry?.at).toBe(NOW); // restamped with injected clock
    expect(entry?.complexity).toBe("reasoning");
    expect(entry?.rawScore).toBe(0.5);
    // No plaintext message content is stored — only the three allowed fields.
    expect(Object.keys(entry ?? {}).sort()).toEqual(["at", "complexity", "rawScore"]);
  });

  it("is a no-op when there is no session key (failure)", () => {
    const d = deps({ now: NOW });
    recordMomentum(null, { complexity: "reasoning", rawScore: 0.5, at: NOW }, d);
    // Nothing recorded; no throw.
    expect(d.store.get("any")).toHaveLength(0);
  });
});
