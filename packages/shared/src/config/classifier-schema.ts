import { z } from "zod";
import { EvalConfigSchema } from "./eval-config.schema.js";

// Classifier config — the Layer-1 classifier's full tunable surface as DATA, not
// code: dimension names/weights, keyword lists, four-tier boundaries, sigmoid
// slope, confidence threshold, and the eval block all live in config/classifier
// .yaml. Per CLAUDE.md principle 2 (config-as-code, Zod-validated, invalid =>
// fail-closed) and principle 4 (Layer-1 is a pure, network-free function fed by
// already-parsed data). Single source of truth via z.infer — no hand-written
// interfaces. See docs/03-classification.md and docs/research-notes.md (Manifest).

// Tier labels used by floors / eval fallback. Reused across override fields.
export const TierSchema = z.enum(["simple", "standard", "complex", "reasoning"]);

// A scoring dimension. The weight's sign IS its direction: + pushes complexity
// up, - pulls it down. `keywords` is used by keyword dimensions; structural
// dimensions leave it empty (their signal comes from code, not data).
export const DimensionConfigSchema = z.object({
  weight: z.number(),
  keywords: z.array(z.string()).default([]),
});

export const ClassifierRulesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(1).default(0.45),
  sigmoid_k: z.number().positive().default(8),
  // rawScore -> four tiers: simple < standard <= standard < complex <= complex <
  // reasoning <= reasoning. Boundaries are data so tiers can be retuned without
  // code changes.
  tier_boundaries: z.object({
    standard: z.number().default(-0.1),
    complex: z.number().default(0.08),
    reasoning: z.number().default(0.35),
  }),
  // 14 keyword + 9 structural dimension names (research-notes Manifest).
  dimensions: z.record(z.string(), DimensionConfigSchema),
  // task_type -> keyword set.
  task_keywords: z.record(z.string(), z.array(z.string())),
  // task_type -> tool-name prefixes (browser_/code_/sql_…).
  tool_prefixes: z.record(z.string(), z.array(z.string())),
  // Open record: new task names allowed; missing keys fall back to default
  // activation in the (downstream) task-detection consumer.
  task_activation: z.record(z.string(), z.number()).default({}),
  overrides: z.object({
    heartbeat_tokens: z.array(z.string()).default(["HEARTBEAT_OK"]),
    formal_logic_keywords: z.array(z.string()).default([]),
    tools_floor: TierSchema.default("standard"),
    long_context_token_threshold: z.number().int().positive().default(64_000),
    long_context_floor: TierSchema.default("complex"),
    short_message_max_chars: z.number().int().positive().default(50),
  }),
  momentum: z.object({
    enabled: z.boolean().default(true),
    ttl_sec: z.number().int().positive().default(1800), // 30 min
    history_size: z.number().int().positive().default(5),
    short_message_max_chars: z.number().int().positive().default(30),
    disable_above_chars: z.number().int().positive().default(100),
    max_history_weight: z.number().min(0).max(1).default(0.6),
  }),
  // Language-coverage guard. The keyword lists above are ENGLISH-ONLY, so a
  // predominantly non-Latin prompt (Chinese / Japanese / Korean / Cyrillic / …)
  // cannot be scored by keywords. When `non_latin_uncertain` is on, such a prompt
  // is forced `uncertain` so the cascade escalates to the (multilingual) Layer-2
  // eval — or, with eval OFF, degrades deterministically to `balanced` instead of
  // a misleading high-confidence keyword verdict. Prefaulted so an omitted block
  // parses through inner defaults (fail-open, principle 3).
  language: z
    .object({
      non_latin_uncertain: z.boolean().default(true),
      non_latin_min_ratio: z.number().min(0).max(1).default(0.3),
    })
    .prefault({}),
});

// Layer-2 eval block — the hardened schema is the single source of truth, defined
// once in eval-config.schema.ts (z.literal locks, max_tokens cap, outer_timeout_ms,
// cache.max_entries). Re-exported under the classifier-scoped name for back-compat
// with existing consumers; do NOT redefine the eval shape here (default drift).
export const ClassifierEvalConfigSchema = EvalConfigSchema;

export const ClassifierConfigSchema = z.object({
  // prefault: parse the omitted block through inner defaults rather than using a
  // bare object literal (Zod v4 .default short-circuits without inner defaults).
  rules: ClassifierRulesConfigSchema.prefault({
    tier_boundaries: {},
    dimensions: {},
    task_keywords: {},
    tool_prefixes: {},
    overrides: {},
    momentum: {},
  }),
  // prefault with the default model: the eval schema requires `model` (an enabled
  // eval with no model is a lie), so an omitted block must still carry one to
  // parse through inner defaults. enabled stays false regardless.
  eval: ClassifierEvalConfigSchema.prefault({ model: "deepseek/deepseek-v4-flash" }),
});

// Strict full-replace variant for the admin PUT /admin/api/classifier endpoint.
// Unlike ClassifierConfigSchema (whose rules/eval are prefaulted so an omitted —
// or wrong-shaped — block silently parses to all-defaults), this REQUIRES both
// blocks and rejects unknown keys (`strictObject`). A config-replacing write must
// fail closed on a partial/mis-shaped body (principle 2), not overwrite the live
// config with defaults. The admin UI PUTs the whole fetched object, so it passes.
export const ClassifierConfigStrictSchema = z.strictObject({
  rules: ClassifierRulesConfigSchema,
  eval: ClassifierEvalConfigSchema,
});

export type Tier = z.infer<typeof TierSchema>;
export type DimensionConfig = z.infer<typeof DimensionConfigSchema>;
export type ClassifierRulesConfig = z.infer<typeof ClassifierRulesConfigSchema>;
export type ClassifierEvalConfig = z.infer<typeof ClassifierEvalConfigSchema>;
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
