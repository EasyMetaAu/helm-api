import { describe, expect, it } from "vitest";
import {
  effectiveReferencedAt,
  forgettingScore,
  recency,
  type ScoreConfig,
  type ScoreInput,
} from "./score.js";

// docs/12 "The forgetting score": this is the pure, deterministic, temperature-free,
// network-free core of the whole forgetting loop. Every assertion here pins a row from
// the P0 spec table — it is the regression contract later phases (inject trim, decay
// sweep) build on. The function NEVER reads the real clock: `now` is always supplied by
// the caller, so these tests are wall-clock-independent and reproducible forever.

// Default curve params mirroring config/memory.yaml's `memory.forgetting.score` block.
// Half-life of one day keeps the age==half_life case arithmetic-obvious.
const CFG: ScoreConfig = {
  half_life_s: 86_400, // 1 day
  importance_floor: 0.1,
  importance_ceil: 1.0,
  access_weight: 0.15,
};

// A reference "now". All ages below are expressed relative to this instant.
const NOW = new Date("2026-06-05T00:00:00.000Z");

// Helper: build a `fallbackTs` exactly `ageSeconds` before NOW.
function ago(ageSeconds: number): Date {
  return new Date(NOW.getTime() - ageSeconds * 1000);
}

describe("recency", () => {
  it("age == 0 → recency == 1 exactly (a brand-new memory has not decayed at all)", () => {
    expect(recency(0, CFG.half_life_s)).toBe(1);
  });

  it("age == half_life → recency == 0.5 exactly (the defining property of a half-life)", () => {
    expect(recency(CFG.half_life_s, CFG.half_life_s)).toBe(0.5);
  });

  it("age == 2 × half_life → recency == 0.25 (two half-lives halve twice)", () => {
    expect(recency(2 * CFG.half_life_s, CFG.half_life_s)).toBeCloseTo(0.25, 12);
  });

  it("negative age clamps to 0 → recency == 1 (a future referenced_at never boosts above fresh)", () => {
    expect(recency(-9999, CFG.half_life_s)).toBe(1);
  });
});

describe("effectiveReferencedAt (coalesce(referenced_at, fallback_ts) — never null)", () => {
  it("uses referencedAt when present", () => {
    const ref = ago(10);
    const fallback = ago(99_999);
    expect(effectiveReferencedAt(ref, fallback)).toEqual(ref);
  });

  it("falls back to fallbackTs when referencedAt is null (a legacy / never-reinforced row)", () => {
    const fallback = ago(42);
    expect(effectiveReferencedAt(null, fallback)).toEqual(fallback);
  });
});

describe("forgettingScore", () => {
  function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
    return {
      referencedAt: null,
      fallbackTs: NOW, // age 0 by default
      referenceCount: 0,
      importance: 0.5,
      ...overrides,
    };
  }

  it("age == 0, no accesses → score == importance_weight (recency 1 × importance, +0 bonus)", () => {
    const s = forgettingScore(input({ importance: 0.5 }), CFG, NOW);
    // recency(1) × clamp(0.5) + 0.15 × log1p(0) = 0.5
    expect(s).toBe(0.5);
  });

  it("null referencedAt ages from fallbackTs and is never NaN (the legacy-row regression guard)", () => {
    const s = forgettingScore(
      input({ referencedAt: null, fallbackTs: ago(CFG.half_life_s), importance: 0.8 }),
      CFG,
      NOW,
    );
    expect(Number.isNaN(s)).toBe(false);
    // recency at one half-life == 0.5, times clamp(0.8) == 0.4, +0 bonus.
    expect(s).toBeCloseTo(0.4, 12);
  });

  it("referencedAt resets age (spaced repetition): a row touched now outranks its old fallbackTs", () => {
    const old = ago(10 * CFG.half_life_s); // very stale creation
    const touchedNow = forgettingScore(
      input({ referencedAt: NOW, fallbackTs: old, importance: 0.5 }),
      CFG,
      NOW,
    );
    const neverTouched = forgettingScore(input({ fallbackTs: old, importance: 0.5 }), CFG, NOW);
    expect(touchedNow).toBeGreaterThan(neverTouched);
    expect(touchedNow).toBe(0.5); // age 0 again
  });

  it("importance floor keeps a stale-but-vital memory strictly > 0 (the decay brake)", () => {
    // 30 half-lives old → recency is astronomically small but nonzero; importance is
    // clamped UP to the floor so the product can never collapse to exactly 0.
    const s = forgettingScore(
      input({ fallbackTs: ago(30 * CFG.half_life_s), importance: 0 }),
      CFG,
      NOW,
    );
    expect(s).toBeGreaterThan(0);
  });

  it("clamps importance to [floor, ceil] before multiplying", () => {
    // importance below floor is raised to floor; at age 0 score == clamped importance.
    expect(forgettingScore(input({ importance: 0 }), CFG, NOW)).toBe(CFG.importance_floor);
    // importance above ceil is lowered to ceil.
    expect(forgettingScore(input({ importance: 5 }), CFG, NOW)).toBe(CFG.importance_ceil);
  });

  it("access_bonus is monotonic increasing in reference_count (reinforcement helps)", () => {
    const base = input({ fallbackTs: ago(CFG.half_life_s) });
    const s0 = forgettingScore({ ...base, referenceCount: 0 }, CFG, NOW);
    const s1 = forgettingScore({ ...base, referenceCount: 1 }, CFG, NOW);
    const s5 = forgettingScore({ ...base, referenceCount: 5 }, CFG, NOW);
    const s50 = forgettingScore({ ...base, referenceCount: 50 }, CFG, NOW);
    expect(s1).toBeGreaterThan(s0);
    expect(s5).toBeGreaterThan(s1);
    expect(s50).toBeGreaterThan(s5);
  });

  it("access_bonus has diminishing returns (log1p): the 50th recall adds less than the 1st", () => {
    const base = input({ fallbackTs: ago(CFG.half_life_s) });
    const s = (n: number) => forgettingScore({ ...base, referenceCount: n }, CFG, NOW);
    const firstStep = s(1) - s(0);
    const fiftiethStep = s(50) - s(49);
    expect(firstStep).toBeGreaterThan(fiftiethStep);
    expect(fiftiethStep).toBeGreaterThan(0);
  });

  it("a RECENTLY-reinforced popular memory outranks a fresh never-used one (reinforcement pays at full strength)", () => {
    // The bonus lives inside the recency product, so "popular" only helps while the
    // memory keeps being touched — here referenced_at is recent, recency ~1.
    const recentlyReinforced = forgettingScore(
      input({
        fallbackTs: ago(10 * CFG.half_life_s), // created long ago…
        referencedAt: ago(0.1 * CFG.half_life_s), // …but touched moments ago
        referenceCount: 40,
        importance: 0.5,
      }),
      CFG,
      NOW,
    );
    const freshButCold = forgettingScore(
      input({ fallbackTs: NOW, referenceCount: 0, importance: 0.2 }),
      CFG,
      NOW,
    );
    expect(recentlyReinforced).toBeGreaterThan(freshButCold);
  });

  // docs/12 (Codex review fix) — reinforcement is NOT permanent immunity. With the
  // earlier additive bonus, reference_count=1 alone scored 0.15×log1p(1) ≈ 0.104 — above
  // the default archive_threshold (0.05) FOREVER. The bonus now decays with recency:
  // a once-used row whose last touch is ancient must fall below the threshold.
  it("a once-used but very stale memory decays below the default archive threshold", () => {
    const s = forgettingScore(
      input({
        fallbackTs: ago(30 * CFG.half_life_s),
        referencedAt: ago(20 * CFG.half_life_s), // last touched 20 half-lives ago
        referenceCount: 1,
        importance: 0.5,
      }),
      CFG,
      NOW,
    );
    // recency = 0.5^20 ≈ 9.5e-7 → score ≈ 9.5e-7 × (0.5 + 0.104) ≈ 5.8e-7 ≪ 0.05.
    expect(s).toBeLessThan(0.05);
    expect(s).toBeGreaterThan(0); // still > 0 for any finite age (rank order intact)
  });

  it("is deterministic to 6 decimal places for a fixed input (float-stability pin)", () => {
    const s = forgettingScore(
      input({
        fallbackTs: ago(1234),
        referencedAt: ago(567),
        referenceCount: 7,
        importance: 0.73,
      }),
      CFG,
      NOW,
    );
    // recency = 0.5^(567/86400); × (clamp(0.73) + 0.15×log1p(7)).
    const expected = 0.5 ** (567 / 86_400) * (0.73 + 0.15 * Math.log1p(7));
    expect(s).toBeCloseTo(expected, 6);
    // Pinned literal so an accidental formula change is caught even if Math drifts.
    expect(Number(s.toFixed(6))).toBe(Number(expected.toFixed(6)));
  });
});
