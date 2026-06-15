import { z } from "zod";

// policies.yaml schema — server-side custom policies let operators customize
// routing WITHOUT touching client code (docs/04 "policy configuration"). A policy declares a
// `match` (AND of all written fields) and at least one action: pin a lane
// (`use_lane`) and/or restrict the candidate to a whitelist (`allowed_lanes`).
//
// Per CLAUDE.md principle 2 (config-as-code, Zod-validated, invalid =>
// fail-closed) and principle 4 (deterministic, inspectable — no hidden magic
// scoring; docs/04). Single source of truth via z.infer — no hand-written
// interfaces. This module does NO file/YAML I/O (the loader hands us parsed
// `unknown`) and cross-references nothing in lanes.yaml (avoids coupling to
// `LanesConfigSchema`); lane-existence is the resolver/loader's concern.
//
// This schema lives in @helm/shared so it can be composed into HelmConfigSchema
// (config validates against the SAME shape the policy engine consumes —
// schema-first, no duplicate definitions). @helm/core re-exports it.

// match: every WRITTEN field must equal the ctx value (AND); unwritten fields
// are unconstrained. `.strict()` so a typo in a field name fails-closed.
export const PolicyMatchSchema = z
  .object({
    task_type: z.string().optional(),
    complexity: z.enum(["simple", "medium", "complex"]).optional(),
    needs_json: z.boolean().optional(),
    needs_tools: z.boolean().optional(),
    needs_vision: z.boolean().optional(),
    // NOTE: there is intentionally no org_id / user_id match dimension — usage and
    // routing limits are scoped to the API key, not to an org/user identity. (The
    // schema is `.strict()`, so a leftover org_id/user_id policy now fails closed at
    // boot rather than silently never matching.) `project_id` is reserved but the
    // runtime always supplies null (see PolicyContext), so it currently matches
    // nothing — kept for forward-compat with a future trusted project source.
    project_id: z.string().optional(),
  })
  .strict();

// A single policy. `id` is optional — when omitted the engine synthesizes
// "policy[N]" (by index) for telemetry. At least one action field is required
// so a policy can never be a silent no-op (fail-closed).
export const PolicySchema = z
  .object({
    id: z.string().min(1).optional(),
    match: PolicyMatchSchema,
    use_lane: z.string().min(1).optional(),
    allowed_lanes: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((p) => p.use_lane != null || p.allowed_lanes != null, {
    message: "policy must specify at least one of use_lane / allowed_lanes",
  });

export const PoliciesConfigSchema = z
  .object({ policies: z.array(PolicySchema).default([]) })
  .strict();

export type PolicyMatch = z.infer<typeof PolicyMatchSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PoliciesConfig = z.infer<typeof PoliciesConfigSchema>;

// Parse + fail-closed: invalid input throws (ZodError); startup catches and
// refuses to boot. Never degrade to "policies are optional, ignore them".
export function parsePoliciesConfig(raw: unknown): PoliciesConfig {
  return PoliciesConfigSchema.parse(raw);
}
