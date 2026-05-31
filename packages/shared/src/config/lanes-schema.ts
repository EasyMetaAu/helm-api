import { z } from "zod";

// lanes.yaml schema — the single typed source of truth for "which lanes exist,
// how each is dialed, and what constraints apply". Per CLAUDE.md principle 2
// (config-as-code, Zod-validated, invalid => fail-closed), principle 5 (the two
// fallbacks are distinct: classification fallback terminates at `balanced`),
// and principle 6 (expose the lane abstraction). Single source of truth via
// z.infer — no hand-written interfaces. See docs/04-routing-and-lanes.md and
// docs/02-architecture.md.
//
// This schema lives in @helm/shared so it can be composed into HelmConfigSchema
// (config validates against the SAME shape the router consumes — schema-first,
// no duplicate definitions). @helm/core re-exports it for its routing modules.
//
// Scope: STATIC structure only. This module does NOT resolve `primary`/`fallback`
// references, detect cycles, or probe lane health — reference resolution and
// cycle handling live in `executor.fallback`; health is a runtime/circuit
// concern. It also performs NO file or YAML I/O: the input is already-parsed
// `unknown` (YAML->object is the config-loader's job), keeping shared/core
// framework-free and purely unit-testable (principle 1).

// Lane constraints: the Capability Filter narrows candidates by these. All
// optional; flags default false so an omitted `constraints` is a no-op filter.
export const LaneConstraintsSchema = z
  .strictObject({
    require_tools: z.boolean().default(false),
    require_json: z.boolean().default(false),
    require_vision: z.boolean().default(false),
    min_context_tokens: z.number().int().positive().optional(),
    max_latency_ms: z.number().int().positive().optional(),
  })
  // prefault (not default): runs the parse on `{}` so inner flag defaults
  // (require_* => false) are filled when `constraints` is omitted. A plain
  // `.default({})` would substitute a raw `{}` without filling inner defaults.
  .prefault({});
export type LaneConstraints = z.infer<typeof LaneConstraintsSchema>;

// A single lane: a declarative ordered chain primary -> fallback[]. Each
// `primary`/`fallback` element may be a model alias OR another lane name (e.g.
// `coding.fallback: [premium, balanced]`); we only validate non-empty strings
// here. NOTE: a `*/auto` provider alias should only appear at the tail of
// `fallback` (docs/02 security rule) — not enforced by the schema; review/lint
// guards it.
export const LaneSchema = z.strictObject({
  purpose: z.string().optional(), // human-readable; semantically required for default lanes
  primary: z.string().min(1),
  fallback: z.array(z.string().min(1)).default([]),
  constraints: LaneConstraintsSchema,
});
export type Lane = z.infer<typeof LaneSchema>;

// lanes.yaml top level: lane name -> Lane, with `balanced` enforced present —
// it is the terminal of the classification fallback (docs/04, principle 5).
export const LanesConfigSchema = z
  .record(z.string().min(1), LaneSchema)
  .refine((m) => "balanced" in m, {
    message: "lanes.yaml must define a `balanced` lane (classification fallback terminal)",
    path: ["balanced"],
  });
export type LanesConfig = z.infer<typeof LanesConfigSchema>;

// Parse + fail-closed: invalid input throws (ZodError); the startup sequence
// catches and refuses to boot. Never degrade to "no lanes is fine".
export function parseLanesConfig(raw: unknown): LanesConfig {
  return LanesConfigSchema.parse(raw);
}
