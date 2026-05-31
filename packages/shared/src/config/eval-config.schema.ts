import { z } from "zod";

// Layer-2 (small-model eval) config block — the typed, hardened foundation that
// every downstream eval module (eval.contract / eval.client / eval.cache /
// eval.cascade) reads. Those modules NEVER parse yaml themselves; they consume
// this already-validated object. Per CLAUDE.md principle 2 (config-as-code,
// Zod-validated, invalid => fail-closed at load) and principle 4 (eval runs at
// temperature:0, is OFF by default, and is cached). See docs/03-classification.md
// Layer 2 and docs/research-notes.md (llm-router probe — don't let config lie;
// cap max_tokens; double-timeout hardening with an outer race).
//
// Hardening choices (vs a loose object): `enabled` is explicitly .default(false)
// — never true; `temperature`/`on_failure`/`cache.key` are z.literal locks so a
// typo'd yaml fails closed instead of running degraded; `max_tokens` is capped at
// 1024 (research-notes: no cap is a scaling cost risk). `outer_timeout_ms` exists
// so eval.client's consumer-side Promise.race outer timeout is configured here,
// not hard-coded — the schema must not advertise a field nobody wires.

export const EvalCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Only content-hash keying is supported today; a literal tightens against
  // misconfig. Widen when more key strategies actually land (eval.cache).
  key: z.literal("content_hash").default("content_hash"),
  ttl_sec: z.number().int().positive().default(300),
  // LRU capacity; consumed by eval.cache. Default 5000 entries.
  max_entries: z.number().int().positive().default(5000),
});

export const EvalConfigSchema = z.object({
  // OFF by default — non-negotiable. No .default(true); explicit false.
  enabled: z.boolean().default(false),
  // Internal small-model alias, e.g. deepseek/deepseek-v4-flash. Required: a
  // missing model fails closed (an enabled eval with no model is a lie).
  model: z.string().min(1),
  // Determinism: locked to 0 (principle 4). A non-zero value fails closed.
  temperature: z.literal(0).default(0),
  // Capped at 1024 to bound per-call cost at scale (research-notes probe gap).
  max_tokens: z.number().int().positive().max(1024).default(256),
  // Inner (runner) timeout — Promise.race inside the eval runner.
  timeout_ms: z.number().int().positive().default(300),
  // Outer (consumer) timeout — the second Promise.race in eval.client. Double
  // timeout hardening; configured here so the field is not dead config.
  outer_timeout_ms: z.number().int().positive().default(250),
  // Fail-open lane when eval errors/times out — locked to balanced (principle 3,
  // 5). A different value would let config lie about the fallback target.
  on_failure: z.literal("balanced").default("balanced"),
  // prefault (not default): parse the omitted block THROUGH the inner field
  // defaults rather than treating it as a bare {} (Zod v4 .default short-circuits
  // inner defaults).
  cache: EvalCacheConfigSchema.prefault({}),
});

export type EvalCacheConfig = z.infer<typeof EvalCacheConfigSchema>;
export type EvalConfig = z.infer<typeof EvalConfigSchema>;
