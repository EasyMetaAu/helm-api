import { z } from "zod";

// API key record (storage layer shape) per docs/06. Per CLAUDE.md principle 7,
// keys are stored as sha256 hash + display prefix ONLY — there is no plaintext
// field anywhere in this schema. Single source of truth via z.infer.

export const KeyRoleSchema = z.enum(["root", "user"]);

// What to do when a key exceeds one of its usage budgets (docs/06 "usage budgets").
// `degrade` (default): keep serving but force the request down to a cheaper lane —
// bounds cost without interrupting service. `reject`: hard 429 once over budget.
export const OverBudgetBehaviorSchema = z.enum(["degrade", "reject"]);

export const ApiKeyRecordSchema = z.object({
  key_id: z.string().min(1),
  hash: z.string().min(1), // sha256(plaintext) hex; never the plaintext
  prefix: z.string().min(1), // e.g. helm_live_ab12 — display/debug only
  account_id: z.string().min(1),
  role: KeyRoleSchema,
  // Per-key caps (docs/06): present-but-nullable so the storage shape is explicit.
  allowed_lanes: z.array(z.string()).nullable(),
  allow_custom_model: z.boolean(),
  disabled: z.boolean(),
  // Per-key rate-limit overrides (docs/06). NULL = inherit the system default
  // (runtime setting rate_limit_default_{rpm,tpm}); a number overrides that ONE
  // dimension only (0 = explicitly unlimited for this key). present-but-nullable
  // so the storage shape is explicit, mirroring the other per-key caps above.
  rate_limit_rpm: z.number().int().nonnegative().nullable(),
  rate_limit_tpm: z.number().int().nonnegative().nullable(),
  // Per-key usage budgets (docs/06 "usage budgets"). Each cap is OPTIONAL: a
  // STRICTLY POSITIVE number is the ceiling consumed over the rolling window;
  // null = no cap for that dimension. Unlike the rate limits, 0 is NOT a sentinel
  // here (null already means "no cap"), so 0 is rejected — it must never look like
  // an active cap while enforcing as unlimited. Exceeding a budget DEGRADES the
  // request to `degrade_lane` by default (keep serving, bound cost). These are
  // `.default()`ed (not just required-nullable like the rate limits) so legacy key
  // rows predating the migration — and unrelated record fixtures — still parse;
  // the keystores populate them explicitly from the columns.
  budget_requests: z.number().int().positive().nullable().default(null),
  budget_tokens: z.number().int().positive().nullable().default(null),
  budget_spend_usd: z.number().positive().nullable().default(null),
  // Rolling window the budgets are measured over (seconds). null = the system
  // default window. Continuous token-bucket refill, no hard reset.
  budget_window_seconds: z.number().int().positive().nullable().default(null),
  over_budget_behavior: OverBudgetBehaviorSchema.default("degrade"),
  // Lane to fall back to when degrading. null = `economy` (the cheapest ranked lane).
  degrade_lane: z.string().min(1).nullable().default(null),
  // Max in-flight requests for this key (issue #93). null = unlimited. Like the
  // budgets (and unlike the rate limits), 0 is NOT a sentinel — null already means
  // unlimited, so 0 is rejected. Enforced only while the runtime setting
  // concurrency_queue_enabled is ON; overflow waits in a FIFO queue (429 on
  // queue-full / wait-timeout). `.default()`ed so legacy rows still parse.
  concurrency_limit: z.number().int().positive().nullable().default(null),
});

export type KeyRole = z.infer<typeof KeyRoleSchema>;
export type OverBudgetBehavior = z.infer<typeof OverBudgetBehaviorSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

// Admin-facing create-key request (docs/06 Key management). The plaintext is minted
// server-side; the operator only specifies role + per-key caps. `.strict()` so an
// unknown field fails closed (Principle 2). role defaults to "user" — root keys are not
// minted casually through the admin UI.
export const CreateKeyRequestSchema = z
  .object({
    role: KeyRoleSchema.default("user"),
    allowed_lanes: z.array(z.string().min(1)).optional(),
    allow_custom_model: z.boolean().optional(),
    // Optional per-key rate limits at mint time. Omitted => inherit the system
    // default. 0 => explicitly unlimited for that dimension (Principle 2 fail-closed on
    // a negative/non-int value).
    rate_limit_rpm: z.number().int().nonnegative().optional(),
    rate_limit_tpm: z.number().int().nonnegative().optional(),
    // Optional per-key usage budgets at mint time (docs/06). Omitted => no cap for
    // that dimension; a cap must be strictly positive (0 is rejected — null = no
    // cap). over_budget_behavior omitted => stored default ("degrade").
    budget_requests: z.number().int().positive().optional(),
    budget_tokens: z.number().int().positive().optional(),
    budget_spend_usd: z.number().positive().optional(),
    budget_window_seconds: z.number().int().positive().optional(),
    over_budget_behavior: OverBudgetBehaviorSchema.optional(),
    degrade_lane: z.string().min(1).optional(),
    // Optional max in-flight requests at mint time. Omitted => unlimited (null);
    // must be strictly positive (0 rejected — null already means unlimited).
    concurrency_limit: z.number().int().positive().optional(),
  })
  .strict();

export type CreateKeyRequest = z.infer<typeof CreateKeyRequestSchema>;

// Admin-facing update-key request (docs/06). Every per-key cap is editable after
// mint EXCEPT the immutable identity (key_id/hash/prefix/account_id) and `role`
// — role stays fixed so the edit path can never escalate a user key to root
// (rotate role by revoking + re-minting). `.strict()` so an unknown field fails
// closed (Principle 2). Every field is OPTIONAL (omit = leave unchanged); the
// nullable ones accept null to CLEAR the cap/override back to the default/no-cap:
//   - allowed_lanes:        null = remove the whitelist.
//   - rate_limit_{rpm,tpm}: null = inherit the system default; a number sets an
//     explicit override (0 = unlimited for that dimension).
// allow_custom_model is a plain boolean (not nullable): present = set, omit = leave.
export const UpdateKeyRequestSchema = z
  .object({
    allowed_lanes: z.array(z.string().min(1)).nullable().optional(),
    allow_custom_model: z.boolean().optional(),
    rate_limit_rpm: z.number().int().nonnegative().nullable().optional(),
    rate_limit_tpm: z.number().int().nonnegative().nullable().optional(),
    // Budget edits (docs/06). Omit = leave unchanged; null = clear the cap (no cap);
    // a number must be strictly positive (0 rejected). over_budget_behavior has no
    // null (it always resolves to degrade|reject).
    budget_requests: z.number().int().positive().nullable().optional(),
    budget_tokens: z.number().int().positive().nullable().optional(),
    budget_spend_usd: z.number().positive().nullable().optional(),
    budget_window_seconds: z.number().int().positive().nullable().optional(),
    over_budget_behavior: OverBudgetBehaviorSchema.optional(),
    degrade_lane: z.string().min(1).nullable().optional(),
    // Omit = leave unchanged; null = clear back to unlimited; a number must be
    // strictly positive (0 rejected).
    concurrency_limit: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type UpdateKeyRequest = z.infer<typeof UpdateKeyRequestSchema>;
