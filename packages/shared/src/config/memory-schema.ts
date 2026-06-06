import { z } from "zod";

// memory.yaml schema — the NEW `config.memory` subtree (docs/12 "Config surface").
// docs/08 left `config.memory` deferred; docs/12 P1 CREATES it, starting with the
// forgetting/tiering strategy. Per CLAUDE.md principle 2 (config-as-code, Zod-
// validated, invalid => fail-closed at load) and principle 4 (the whole forgetting
// curve is a deterministic, unit-testable function tuned from config, not code).
//
// This schema lives in @helm/shared so it can be composed into HelmConfigSchema
// (config validates against the SAME shape the forgetting pipeline consumes —
// schema-first, no duplicate definitions). @helm/core re-exports it.
//
// Two invariants are LOAD-BEARING for fail-closed config-as-code (docs/12):
//   1. Keys are snake_case to match the YAML verbatim. With camelCase keys an
//      operator's `half_life_s` / `drop_order` would be silently stripped and the
//      default would win — a config that lies. snake_case makes the YAML key the
//      schema key, so a real `half_life_s: 3600` actually takes effect.
//   2. Every object is `.strict()`. An unknown / misspelled key then THROWS at
//      startup (refuses to boot) instead of being dropped. A typo can never run
//      degraded — exactly the repo convention (packages/shared/src/config/*).
//
// OFF by default: with `forgetting.enabled: false` (the default) runtime behaviour
// is byte-identical to today. Forgetting is fail-OPEN at runtime (any decay/score
// step that errors degrades to "keep the memory"), but its CONFIG is fail-CLOSED.

// The deterministic forgetting score's tunables (docs/12 "The forgetting score"):
//   score(now) = recency(now) × importance_weight + access_bonus
//   recency    = 0.5 ^ (age_seconds / half_life_s)
//   importance_weight = clamp(importance, importance_floor, importance_ceil)
//   access_bonus      = access_weight × log1p(reference_count)
// `half_life_s`, the importance clamp band, and `access_weight` are CONFIG, not
// columns — retuning the curve is a config edit, not a migration, and the score
// stays reproducible from the row + config alone. importance_floor > 0 is the
// "decay brake": a vital memory decays slower and is forgotten last; the refine
// enforces a coherent floor ≤ ceil band (an inverted band is a config lie).
const ScoreSchema = z
  .object({
    half_life_s: z.number().positive().default(86400), // 1 day; recency = 0.5 ^ (age / half_life)
    importance_floor: z.number().min(0).max(1).default(0.1), // decay brake: vital memories never hit 0
    importance_ceil: z.number().min(0).max(1).default(1.0),
    access_weight: z.number().min(0).default(0.15), // access_bonus = access_weight × log1p(reference_count)
  })
  .strict()
  .refine((s) => s.importance_floor <= s.importance_ceil, "importance_floor ≤ importance_ceil");

const FixedObserverCompactionSchema = z
  .object({
    mode: z.literal("fixed").default("fixed"),
    recent_keep: z.number().int().min(0).default(2),
  })
  .strict();

const EconomyObserverCompactionSchema = z
  .object({
    mode: z.literal("economy"),
    min_recent_messages: z.number().int().positive().default(2),
    min_keep_ratio: z.number().min(0).max(1).default(0.12),
    max_context_tokens: z.number().int().positive().default(200000),
    force_at_context_ratio: z.number().min(0).max(1).default(0.9),
    expected_remaining_calls: z.number().min(0).default(8),
    fixed_prefix_tokens: z.number().int().min(0).default(5000),
    summary_output_tokens: z.number().int().min(0).default(500),
    summary_instruction_tokens: z.number().int().min(0).default(70),
    average_input_tokens: z.number().int().positive().default(4000),
    price_input_per_mtok: z.number().min(0).default(3),
    price_cache_per_mtok: z.number().min(0).default(0.3),
    price_output_per_mtok: z.number().min(0).default(15),
    retention_rate: z.number().min(0).max(1).default(0.8),
    prior_compaction_count: z.number().int().min(0).default(0),
    distortion_penalty: z.number().min(0).default(0.03),
    quality_penalty: z.number().min(0).default(0.2),
    min_net_benefit_usd: z.number().min(0).default(0),
  })
  .strict();

export const ObserverCompactionSchema = z.discriminatedUnion("mode", [
  FixedObserverCompactionSchema,
  EconomyObserverCompactionSchema,
]);

export const ObserverSchema = z
  .object({
    // Legacy default: keep the latest two raw messages verbatim. `economy` opts in
    // to the cache-aware DP gate inspired by bash-agent; config is fail-closed.
    compaction: ObserverCompactionSchema.prefault({ mode: "fixed" }),
  })
  .strict();

export const ForgettingSchema = z
  .object({
    // Master switch — off = today's behaviour exactly (the gating lever for the
    // whole phased rollout in docs/12). No `.default(true)`; explicit false.
    enabled: z.boolean().default(false),
    // `.prefault({})` (not `.default({})`): prefault PARSES the default value
    // through the schema so the nested field defaults actually fire when the block
    // is omitted — exactly the repo convention (RuntimeConfigSchema.store uses
    // StoreConfigSchema.prefault). A bare `.default({})` would hand back a literal
    // `{}` with no inner defaults applied (half_life_s would be undefined).
    score: ScoreSchema.prefault({}),
    // The one hot-path knob: inject-time budget trim drop order. `score` drops the
    // lowest-scored observation first; `oldest` is the legacy oldest-first fallback
    // (docs/12 "Eviction": only the observation comparator changes, invariants hold).
    inject: z
      .object({ drop_order: z.enum(["score", "oldest"]).default("score") })
      .strict()
      .prefault({}),
    // Background sweep (memory_jobs.type='decay') gating — buffer-flush pattern,
    // never per request: archive sub-threshold rows; run after N new observations
    // OR an interval, whichever first (docs/12 "Demote mid → archived").
    decay: z
      .object({
        archive_threshold: z.number().min(0).max(1).default(0.05), // score below this → soft-archive (mid tier)
        trigger_observations: z.number().int().positive().default(50), // run sweep after N new observations
        trigger_interval_s: z.number().int().positive().default(3600), // …or this long elapsed, whichever first
      })
      .strict()
      .prefault({}),
    // mid→long consolidation into deduplicated facts (docs/12 "Promote mid → long").
    // enable_llm_supersede currently accepts ONLY false (Codex review fix): the LLM
    // contradiction-finding path is deferred and not wired, so accepting `true` would
    // be a lying knob — an operator would flip it and nothing would change, violating
    // config-as-code. `z.literal(false)` makes `true` REFUSE STARTUP (fail-closed)
    // until the behaviour actually ships; widen back to z.boolean() then.
    consolidate: z
      .object({
        trigger_tokens: z.number().int().positive().default(1024), // extract facts when active-obs tokens exceed this
        max_facts_per_subject: z.number().int().positive().default(8), // hard cap regardless of LLM output
        enable_llm_supersede: z.literal(false).default(false), // deferred — `true` is rejected until the LLM path exists
      })
      .strict()
      .prefault({}),
    // Retention hard-delete bounds (docs/12 "Hard-delete (rare)"): decay archives,
    // retention deletes — and only archived/expired rows past these ages.
    retention: z
      .object({
        archived_days: z.number().int().positive().default(30), // hard-delete archived rows older than this
        facts_expired_days: z.number().int().positive().default(90),
      })
      .strict()
      .prefault({}),
    // Background-worker bounds: never loop forever (docs/12 "bounded loop").
    sweep: z
      .object({
        max_iterations: z.number().int().positive().default(200),
        max_wallclock_s: z.number().int().positive().default(900),
        max_consecutive_errors: z.number().int().positive().default(5), // back off, do not loop forever
      })
      .strict()
      .prefault({}),
  })
  .strict();

// The `config.memory` subtree root. NEW per docs/12 — currently carries only
// `forgetting`, and is deliberately extensible (`.strict()` so unknown future keys
// fail-closed until they are added here, exactly like the rest of the config tree).
export const MemoryConfigSchema = z
  .object({
    observer: ObserverSchema.prefault({}),
    forgetting: ForgettingSchema.prefault({}),
  })
  .strict();

export type ObserverCompactionConfig = z.infer<typeof ObserverCompactionSchema>;
export type ObserverConfig = z.infer<typeof ObserverSchema>;
export type ScoreConfig = z.infer<typeof ScoreSchema>;
export type ForgettingConfig = z.infer<typeof ForgettingSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
