// The policy Zod schema is the single source of truth in @helm/shared (so
// HelmConfigSchema validates config/policies.yaml against the SAME shape the
// policy engine consumes; schema-first, no duplicate definitions — CLAUDE.md
// 代码规范). This module re-exports it for core's routing code (policy-engine,
// route-request). See docs/04-routing-and-lanes.md, packages/shared policy-schema.
export {
  type PoliciesConfig,
  PoliciesConfigSchema,
  type Policy,
  type PolicyMatch,
  PolicyMatchSchema,
  PolicySchema,
  parsePoliciesConfig,
} from "@helm/shared";
