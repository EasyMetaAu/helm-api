import { describe, expect, it } from "vitest";
import { ForgettingSchema, MemoryConfigSchema, MemoryLlmSchema } from "./memory-schema.js";

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
    // Salient-fact fast path (salient-fact-memory-spec): off by default; the
    // inject cap is an optional override with NO default (internal prior applies).
    expect(f.consolidate.eager_facts).toBe(false);
    expect(f.consolidate.max_facts_injected).toBeUndefined();
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

  // docs/12 (Codex review fix) — the LLM supersede path is DEFERRED and not wired, so
  // accepting `true` would be a lying knob (config-as-code violation). It refuses
  // startup until the behaviour ships.
  it("enable_llm_supersede: true is REJECTED (fail-closed) while the LLM path is deferred", () => {
    expect(() => ForgettingSchema.parse({ consolidate: { enable_llm_supersede: true } })).toThrow();
    // false (the only honest value) still parses.
    const f = ForgettingSchema.parse({ consolidate: { enable_llm_supersede: false } });
    expect(f.consolidate.enable_llm_supersede).toBe(false);
  });

  it("drop_order accepts the legacy `oldest` fallback", () => {
    const f = ForgettingSchema.parse({ inject: { drop_order: "oldest" } });
    expect(f.inject.drop_order).toBe("oldest");
  });

  // Salient-fact fast path: eager_facts opts the Observer into raw-message fact
  // extraction + the inject `## Known facts` section; max_facts_injected caps the
  // injected set (optional, no default → internal prior, like CompactionOverrides).
  it("eager_facts round-trips and max_facts_injected is an optional override (no default)", () => {
    const f = ForgettingSchema.parse({ consolidate: { eager_facts: true, max_facts_injected: 12 } });
    expect(f.consolidate.eager_facts).toBe(true);
    expect(f.consolidate.max_facts_injected).toBe(12);
    // omitted → NOT materialized (no lying knob)
    const g = ForgettingSchema.parse({ consolidate: { eager_facts: true } });
    expect("max_facts_injected" in g.consolidate).toBe(false);
  });

  it("fails closed on a non-positive max_facts_injected", () => {
    expect(() => ForgettingSchema.parse({ consolidate: { max_facts_injected: 0 } })).toThrow();
    expect(() => ForgettingSchema.parse({ consolidate: { max_facts_injected: -3 } })).toThrow();
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

describe("CompactionOverridesSchema (via MemoryConfigSchema.compaction)", () => {
  it("absent block → empty object: every override stays undefined (internal priors apply)", () => {
    const m = MemoryConfigSchema.parse({});
    expect(m.compaction).toEqual({});
    expect(m.compaction.segment_min_tokens).toBeUndefined();
    expect(m.compaction.idle_flush_s).toBeUndefined();
    expect(m.compaction.force_context_ratio).toBeUndefined();
  });

  it("a written override round-trips; omitted siblings are NOT materialized", () => {
    const m = MemoryConfigSchema.parse({ compaction: { idle_flush_s: 7200 } });
    expect(m.compaction.idle_flush_s).toBe(7200);
    // No .default() materialization — the merge/no-lying-knob contract.
    expect("segment_min_tokens" in m.compaction).toBe(false);
    expect("force_context_ratio" in m.compaction).toBe(false);
  });

  it("fails closed on unknown/misspelled keys and on out-of-range values", () => {
    expect(() => MemoryConfigSchema.parse({ compaction: { idleFlushS: 7200 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { quality_coeff: 0.2 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { force_context_ratio: 0 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { force_context_ratio: 1.2 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { segment_min_tokens: -1 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { idle_flush_s: 0 } })).toThrow();
    expect(() => MemoryConfigSchema.parse({ compaction: { min_keep_ratio: 1.5 } })).toThrow();
  });
});

describe("MemoryLlmSchema", () => {
  it("defaults to disabled with no model selected", () => {
    const llm = MemoryLlmSchema.parse({});
    expect(llm.enabled).toBe(false);
    expect(llm.model).toBeUndefined();
    expect(llm.timeout_ms).toBe(30_000);
    expect(llm.temperature).toBe(0);
    expect(llm.max_tokens.observation).toBe(800);
    expect(llm.max_tokens.reflection).toBe(1200);
    expect(llm.max_tokens.facts).toBe(1000);
  });

  it("accepts a base model with task-specific extraction/compaction overrides", () => {
    const llm = MemoryLlmSchema.parse({
      enabled: true,
      model: "deepseek/deepseek-v4-flash",
      observation_model: "openai/gpt-4.1-mini",
      reflection_model: "anthropic/claude-sonnet-4",
      facts_model: "openai/gpt-4.1-nano",
      timeout_ms: 10_000,
      temperature: 0.1,
      max_tokens: { observation: 256, reflection: 512, facts: 384 },
    });
    expect(llm.enabled).toBe(true);
    expect(llm.model).toBe("deepseek/deepseek-v4-flash");
    expect(llm.observation_model).toBe("openai/gpt-4.1-mini");
    expect(llm.reflection_model).toBe("anthropic/claude-sonnet-4");
    expect(llm.facts_model).toBe("openai/gpt-4.1-nano");
    expect(llm.timeout_ms).toBe(10_000);
    expect(llm.temperature).toBe(0.1);
    expect(llm.max_tokens.facts).toBe(384);
  });

  it("fails closed when enabled without a base model or with misspelled/invalid knobs", () => {
    expect(() => MemoryLlmSchema.parse({ enabled: true })).toThrow();
    expect(() => MemoryLlmSchema.parse({ enabled: true, modle: "x" })).toThrow();
    expect(() => MemoryLlmSchema.parse({ enabled: true, model: "x", timeout_ms: 0 })).toThrow();
    expect(() => MemoryLlmSchema.parse({ enabled: true, model: "x", temperature: 2 })).toThrow();
    expect(() =>
      MemoryLlmSchema.parse({ enabled: true, model: "x", max_tokens: { observation: 0 } }),
    ).toThrow();
  });
});

describe("MemoryConfigSchema", () => {
  it("absent block → all defaults with forgetting.enabled:false", () => {
    const m = MemoryConfigSchema.parse({});
    expect(m.llm.enabled).toBe(false);
    expect(m.forgetting.enabled).toBe(false);
    expect(m.forgetting.score.half_life_s).toBe(86400);
  });

  it("nests forgetting under memory and fails closed on an unknown memory key", () => {
    const m = MemoryConfigSchema.parse({ forgetting: { enabled: true } });
    expect(m.forgetting.enabled).toBe(true);
    expect(() => MemoryConfigSchema.parse({ forgettign: {} })).toThrow();
  });

  // Salient-fact fast path: eager fact extraction REQUIRES the LLM (the
  // deterministic raw-message extractor is too weak to be the real path), so
  // `eager_facts:true` with `llm.enabled:false` must REFUSE STARTUP rather than
  // silently no-op (config-as-code, no lying knobs).
  it("eager_facts:true requires llm.enabled:true (cross-block gate, fail-closed)", () => {
    expect(() =>
      MemoryConfigSchema.parse({
        forgetting: { enabled: true, consolidate: { eager_facts: true } },
      }),
    ).toThrow();
    // with the LLM enabled (+ a model) it parses
    const m = MemoryConfigSchema.parse({
      llm: { enabled: true, model: "deepseek/deepseek-v4-flash" },
      forgetting: { enabled: true, consolidate: { eager_facts: true } },
    });
    expect(m.forgetting.consolidate.eager_facts).toBe(true);
    // eager_facts:false with the LLM off is fine (the default posture)
    const off = MemoryConfigSchema.parse({ forgetting: { enabled: true } });
    expect(off.forgetting.consolidate.eager_facts).toBe(false);
  });

  // Compaction is no longer configurable — it is internal auto-adaptive
  // behaviour. A leftover fixed/economy-era `observer:` block must REFUSE
  // startup (fail-closed) so the operator notices the knobs are gone instead
  // of carrying dead config that silently does nothing (no lying knobs).
  it("a leftover `observer:` block from the deleted fixed/economy era refuses startup", () => {
    expect(() =>
      MemoryConfigSchema.parse({ observer: { compaction: { mode: "fixed", recent_keep: 2 } } }),
    ).toThrow();
    expect(() =>
      MemoryConfigSchema.parse({ observer: { compaction: { mode: "economy" } } }),
    ).toThrow();
  });
});
