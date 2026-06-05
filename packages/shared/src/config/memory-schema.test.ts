import { describe, expect, it } from "vitest";
import { ForgettingSchema, MemoryConfigSchema } from "./memory-schema.js";

// P1 (docs/12 "Config surface"): the forgetting config is config-as-code, Zod-
// validated, fail-closed on bad input (CLAUDE.md principle 2). snake_case keys +
// .strict() are load-bearing: with camelCase an operator's `half_life_s` would be
// silently stripped and the default would win; with snake_case an unknown/
// misspelled key THROWS at startup, and a real value actually takes effect.

describe("ForgettingSchema", () => {
  it("a valid config infers with all spec defaults (enabled:false)", () => {
    const f = ForgettingSchema.parse({});
    expect(f.enabled).toBe(false);
    expect(f.score.half_life_s).toBe(86400);
    expect(f.score.importance_floor).toBe(0.1);
    expect(f.score.importance_ceil).toBe(1.0);
    expect(f.score.access_weight).toBe(0.15);
    expect(f.inject.drop_order).toBe("score");
    expect(f.decay.archive_threshold).toBe(0.05);
    expect(f.decay.trigger_observations).toBe(50);
    expect(f.decay.trigger_interval_s).toBe(3600);
    expect(f.consolidate.trigger_tokens).toBe(1024);
    expect(f.consolidate.max_facts_per_subject).toBe(8);
    expect(f.consolidate.enable_llm_supersede).toBe(false);
    expect(f.retention.archived_days).toBe(30);
    expect(f.retention.facts_expired_days).toBe(90);
    expect(f.sweep.max_iterations).toBe(200);
    expect(f.sweep.max_wallclock_s).toBe(900);
    expect(f.sweep.max_consecutive_errors).toBe(5);
  });

  it("a non-default half_life_s round-trips and takes effect", () => {
    const f = ForgettingSchema.parse({ enabled: true, score: { half_life_s: 3600 } });
    expect(f.enabled).toBe(true);
    expect(f.score.half_life_s).toBe(3600);
    // untouched siblings keep their defaults
    expect(f.score.importance_floor).toBe(0.1);
    expect(f.inject.drop_order).toBe("score");
  });

  it("drop_order accepts the legacy `oldest` fallback", () => {
    const f = ForgettingSchema.parse({ inject: { drop_order: "oldest" } });
    expect(f.inject.drop_order).toBe("oldest");
  });

  it("fails closed on an unknown/misspelled top-level key (.strict())", () => {
    expect(() => ForgettingSchema.parse({ half_life_s: 3600 })).toThrow();
  });

  it("fails closed on a misspelled nested key (.strict())", () => {
    expect(() => ForgettingSchema.parse({ score: { halflife_s: 3600 } })).toThrow();
  });

  it("fails closed on an unknown drop_order enum value", () => {
    expect(() => ForgettingSchema.parse({ inject: { drop_order: "random" } })).toThrow();
  });

  it("fails closed when importance_floor > importance_ceil", () => {
    expect(() =>
      ForgettingSchema.parse({ score: { importance_floor: 0.9, importance_ceil: 0.1 } }),
    ).toThrow();
  });

  it("accepts importance_floor == importance_ceil (boundary is inclusive)", () => {
    const f = ForgettingSchema.parse({ score: { importance_floor: 0.5, importance_ceil: 0.5 } });
    expect(f.score.importance_floor).toBe(0.5);
  });

  it("fails closed on a non-positive half_life_s", () => {
    expect(() => ForgettingSchema.parse({ score: { half_life_s: 0 } })).toThrow();
  });
});

describe("MemoryConfigSchema", () => {
  it("absent block → all defaults with forgetting.enabled:false", () => {
    const m = MemoryConfigSchema.parse({});
    expect(m.forgetting.enabled).toBe(false);
    expect(m.forgetting.score.half_life_s).toBe(86400);
  });

  it("nests forgetting under memory and fails closed on an unknown memory key", () => {
    const m = MemoryConfigSchema.parse({ forgetting: { enabled: true } });
    expect(m.forgetting.enabled).toBe(true);
    expect(() => MemoryConfigSchema.parse({ forgettign: {} })).toThrow();
  });
});
