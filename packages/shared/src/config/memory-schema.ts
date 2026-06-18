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
        // Salient-fact fast path (salient-fact-memory-spec). When true, the
        // Observer ALSO extracts atomic facts from raw turns — decoupled from the
        // compaction threshold so a short "remember X" turn forms a fact even when
        // it never compacts — AND inject surfaces a `## Known facts` section.
        // Default false (byte-identical to today). HARD-gated by llm.enabled at the
        // MemoryConfigSchema level (the deterministic raw-message extractor is too
        // weak to be the real path, so eager_facts:true with the LLM off REFUSES
        // startup rather than silently no-op'ing).
        eager_facts: z.boolean().default(false),
        // Top-K cap on facts injected into the `## Known facts` block. Plain
        // `.optional()` with NO `.default()` (the CompactionOverrides pattern): an
        // omitted key stays undefined and the runtime applies its internal prior, so
        // a written value is the only thing that ever takes effect (no lying knob).
        max_facts_injected: z.number().int().positive().optional(),
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

// Optional overrides for the auto-compaction TRIGGER/keep parameters — the only
// compaction surface an operator can touch. Every field is plain `.optional()`
// with NO `.default()`: an omitted key stays `undefined` and the runtime uses
// its internal prior (AUTO_PRIORS), so a value written here is the only thing
// that ever takes effect — no lying knobs, and no `.partial()`-over-default
// materialization trap (see PricingOverrideEntrySchema). The ECONOMICS priors
// (quality coefficient, price heuristics, retention clamps, summary caps) stay
// internal on purpose: they are expert constants with no operational meaning,
// and the auto-resolved inputs (catalog prices, measured stats) leave nothing
// honest to configure there. Prices pin via config/pricing.yaml.
export const CompactionOverridesSchema = z
  .object({
    // Memory-formation size trigger: compact once the uncovered segment reaches
    // this many tokens (internal default 2048).
    segment_min_tokens: z.number().int().positive().optional(),
    // Idle flush: fold a quiet thread's whole uncovered history after this many
    // seconds without a new message (internal default 3600).
    idle_flush_s: z.number().int().positive().optional(),
    // Context-pressure safety valve: force compaction once the active footprint
    // reaches this fraction of the served model's context window (default 0.8).
    force_context_ratio: z.number().gt(0).max(1).optional(),
    // Keep floor for writeback compaction: at least this many recent messages
    // (default 4) and this fraction of the segment (default 0.25) stay raw.
    min_recent_messages: z.number().int().min(0).optional(),
    min_keep_ratio: z.number().min(0).max(1).optional(),
  })
  .strict();

// Optional LLM-backed memory formation. This controls ONLY the background memory
// worker's summarize/merge/fact-extraction calls; request-path observe/inject
// stays synchronous and deterministic. OFF by default keeps the existing
// deterministic stubs byte-for-byte available as both the default and fail-open
// fallback. When enabled, `model` is required and can be overridden per task:
//   - observation_model: raw messages -> observation (Observer compaction)
//   - reflection_model: observations -> stable reflection (Reflector compaction)
//   - facts_model: observations -> atomic facts (memory extraction)
// Unknown/misspelled keys are rejected at config load, but runtime model/provider
// failures fall back to the deterministic path and log safe metadata only.
export const MemoryLlmMaxTokensSchema = z
  .object({
    observation: z.number().int().positive().default(800),
    reflection: z.number().int().positive().default(1200),
    facts: z.number().int().positive().default(1000),
  })
  .strict();

export const MemoryLlmSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().min(1).optional(),
    observation_model: z.string().min(1).optional(),
    reflection_model: z.string().min(1).optional(),
    facts_model: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().default(30_000),
    temperature: z.number().min(0).max(1).default(0),
    max_tokens: MemoryLlmMaxTokensSchema.prefault({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.enabled === true && cfg.model === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "memory.llm.model is required when memory.llm.enabled is true",
      });
    }
  });

// The `config.memory` subtree root. `compaction` carries OPTIONAL trigger
// overrides (above); everything else about compaction is the gateway's internal
// auto-adaptive behaviour (prices/context from the model catalog, workload
// stats derived per job; see packages/core/src/memory/compaction-policy.ts).
// `.strict()` means a leftover `observer:` block from the deleted fixed/economy
// era REFUSES STARTUP — deliberately fail-closed, so an operator notices the
// old knobs are gone instead of carrying dead config (the no-lying-knobs rule).
export const MemoryConfigSchema = z
  .object({
    compaction: CompactionOverridesSchema.prefault({}),
    llm: MemoryLlmSchema.prefault({}),
    forgetting: ForgettingSchema.prefault({}),
  })
  .strict()
  // Cross-block gate (salient-fact-memory-spec §6). `eager_facts:true` requires BOTH:
  //   - `llm.enabled:true` — the deterministic raw extractor is a stub, so without a
  //     model eager extraction would silently do nothing (a lying knob); and
  //   - `forgetting.enabled:true` — forgetting is the documented MASTER switch for the
  //     whole facts tier (decay / retention / score / Reflector fact extraction all
  //     gate on it). eager_facts under a disabled master would form + inject facts
  //     that never decay or get retention-pruned — not byte-identical-to-off.
  // Either unmet REFUSES STARTUP (fail-closed). This lives here, not on
  // ForgettingSchema, because the llm check spans the sibling `llm` block.
  .superRefine((cfg, ctx) => {
    if (cfg.forgetting.consolidate.eager_facts !== true) return;
    if (cfg.llm.enabled !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["forgetting", "consolidate", "eager_facts"],
        message: "forgetting.consolidate.eager_facts:true requires memory.llm.enabled:true",
      });
    }
    if (cfg.forgetting.enabled !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["forgetting", "consolidate", "eager_facts"],
        message: "forgetting.consolidate.eager_facts:true requires memory.forgetting.enabled:true",
      });
    }
  });

export type ScoreConfig = z.infer<typeof ScoreSchema>;
export type CompactionOverrides = z.infer<typeof CompactionOverridesSchema>;
export type ForgettingConfig = z.infer<typeof ForgettingSchema>;
export type MemoryLlmConfig = z.infer<typeof MemoryLlmSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
