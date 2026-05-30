import { z } from "zod";

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
    long_context_token_threshold: z.number().int().positive().default(50_000),
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
});

export const ClassifierEvalConfigSchema = z.object({
  enabled: z.boolean().default(false), // Layer-2 eval is OFF by default.
  model: z.string().default("deepseek/deepseek-v4-flash"),
  temperature: z.number().default(0),
  max_tokens: z.number().int().positive().default(256),
  timeout_ms: z.number().int().positive().default(300),
  on_failure: z.string().default("balanced"), // fail-open target tier
  cache: z
    .object({
      enabled: z.boolean().default(true),
      key: z.string().default("content_hash"),
      ttl_sec: z.number().int().positive().default(300),
    })
    // prefault (not default) so the omitted object is parsed through inner
    // field defaults instead of being used as a bare {}.
    .prefault({}),
});

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
  eval: ClassifierEvalConfigSchema.prefault({}),
});

export type Tier = z.infer<typeof TierSchema>;
export type DimensionConfig = z.infer<typeof DimensionConfigSchema>;
export type ClassifierRulesConfig = z.infer<typeof ClassifierRulesConfigSchema>;
export type ClassifierEvalConfig = z.infer<typeof ClassifierEvalConfigSchema>;
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
