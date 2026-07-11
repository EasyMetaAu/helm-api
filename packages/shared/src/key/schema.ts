import { z } from "zod";
import { MemoryModeSchema } from "../request/schema.js";

// API key record (storage layer shape) per docs/06. Per CLAUDE.md principle 7,
// keys are stored as sha256 hash + display prefix ONLY — there is no plaintext
// field anywhere in this schema. Single source of truth via z.infer.

export const KeyRoleSchema = z.enum(["root", "user"]);

// What to do when a key exceeds one of its usage budgets (docs/06 "usage budgets").
// `degrade` (default): keep serving but force the request down to a cheaper lane —
// bounds cost without interrupting service. `reject`: hard 429 once over budget.
export const OverBudgetBehaviorSchema = z.enum(["degrade", "reject"]);

// Where the memory THREAD anchor comes from when x-thread-id is absent (issue #97).
// `auto`: derive from signals the client already sends (body metadata.thread_id /
// conversation_id → x-session-key → OpenAI prompt_cache_key → Anthropic
// metadata.user_id) so static-header-only clients (Claude Code / Codex) can get
// per-conversation memory once memory is explicitly enabled. `header`: only the
// explicit x-thread-id header (opt out of derivation — the pre-#97 behavior). NEW
// keys are minted with `auto` in the keystores; moot while memory is off.
export const MemoryThreadSourceSchema = z.enum(["header", "auto"]);

// Human-readable key label (docs/06) — cosmetic only, never an auth/routing input.
// `.trim()` runs BEFORE the length checks, so a whitespace-only label collapses to
// "" and fails min(1) (fail-closed, Principle 2) instead of masquerading as a real
// name, and a padded label is stored normalized. Reused by the record + create +
// update schemas so the three can never drift apart.
const KeyNameSchema = z.string().trim().min(1).max(100);

// Exact client-facing model ids blocked for this API key across direct requests
// and lane/fallback chains. Trim only; do not lowercase provider/model ids.
const BlockedModelsSchema = z.array(z.string().trim().min(1)).nullable();

export const ApiKeyRecordSchema = z.object({
  key_id: z.string().min(1),
  hash: z.string().min(1), // sha256(plaintext) hex; never the plaintext
  prefix: z.string().min(1), // e.g. helm_live_ab12 — display/debug only
  account_id: z.string().min(1),
  role: KeyRoleSchema,
  // Human-readable label so an operator can tell at a glance which project/client a
  // key belongs to (the prefix alone is opaque). PURELY cosmetic — never an auth or
  // routing input. null = unnamed. `.default(null)` (like the budgets/memory fields)
  // so legacy rows predating the column — and unrelated record fixtures — still parse.
  name: KeyNameSchema.nullable().default(null),
  // Per-key caps (docs/06): present-but-nullable so the storage shape is explicit.
  allowed_lanes: z.array(z.string()).nullable(),
  allow_custom_model: z.boolean(),
  // Per-key model blacklist. It removes case-insensitive exact/glob model
  // patterns from every route this key can take; legacy rows default to null.
  blocked_models: BlockedModelsSchema.default(null),
  // Per-key Fast-mode passthrough cap. false = client-requested Fast is downgraded
  // unless the serving subscription account itself has Fast mode forced on.
  allow_fast_mode: z.boolean().default(false),
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
  // Per-key MEMORY DEFAULTS: server-side settings for clients limited to static
  // headers (Claude Code / Codex). Explicit x-memory-* request headers always
  // override. memory_mode is a BEHAVIOR-level default (inject rewrites requests),
  // so omitted/new records stay off unless a key explicitly opts in. `.default()`ed
  // so legacy rows predating the migration still parse with memory off.
  memory_mode: MemoryModeSchema.default("off"),
  memory_project_id: z.string().min(1).nullable().default(null),
  // Zod parse-default is the conservative `header` (legacy rows / record fixtures
  // that omit the column — mirrors memory_mode parse-defaulting to `off`). NEW keys
  // are minted with `auto` in the keystores, so a memory-on key derives its thread
  // out of the box; existing keys keep their stored value.
  memory_thread_source: MemoryThreadSourceSchema.default("header"),
});

export type KeyRole = z.infer<typeof KeyRoleSchema>;
export type OverBudgetBehavior = z.infer<typeof OverBudgetBehaviorSchema>;
export type MemoryThreadSource = z.infer<typeof MemoryThreadSourceSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

// A key's EFFECTIVE memory project scope. `memory_project_id` is the explicit
// opt-in to SHARE a memory pool across several keys; absent (null) it falls back
// to the key's OWN id, so each API key isolates its memory by default — key A's
// facts never leak to key B, while a single key keeps cross-session recall.
// `account_id` stays the tenant boundary ABOVE this project sub-scope. Clearing
// memory_project_id back to null therefore reverts a key to isolated-by-self.
export function effectiveMemoryProjectId(
  rec: Pick<ApiKeyRecord, "memory_project_id" | "key_id">,
): string {
  return rec.memory_project_id ?? rec.key_id;
}

// Admin-facing create-key request (docs/06 Key management). The plaintext is minted
// server-side; the operator only specifies role + per-key caps. `.strict()` so an
// unknown field fails closed (Principle 2). role defaults to "user" — root keys are not
// minted casually through the admin UI.
export const CreateKeyRequestSchema = z
  .object({
    role: KeyRoleSchema.default("user"),
    // Optional human-readable label at mint time (omitted => unnamed). Cosmetic only.
    name: KeyNameSchema.optional(),
    allowed_lanes: z.array(z.string().min(1)).optional(),
    allow_custom_model: z.boolean().optional(),
    blocked_models: z.array(z.string().trim().min(1)).optional(),
    allow_fast_mode: z.boolean().optional(),
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
    // Optional per-key memory defaults at mint time. Omitted => the keystore mints
    // fail-safe NEW-KEY defaults (mode "off", thread_source "auto"); pass
    // memory_mode explicitly to opt in. Explicit x-memory-* headers always override.
    memory_mode: MemoryModeSchema.optional(),
    memory_project_id: z.string().min(1).optional(),
    memory_thread_source: MemoryThreadSourceSchema.optional(),
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
// allow_custom_model / allow_fast_mode are plain booleans (not nullable): present
// = set, omit = leave.
export const UpdateKeyRequestSchema = z
  .object({
    // Rename a key after mint. Omit = leave unchanged; null = clear back to unnamed.
    name: KeyNameSchema.nullable().optional(),
    allowed_lanes: z.array(z.string().min(1)).nullable().optional(),
    allow_custom_model: z.boolean().optional(),
    blocked_models: BlockedModelsSchema.optional(),
    allow_fast_mode: z.boolean().optional(),
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
    // Memory default edits (issue #97). Omit = leave unchanged; mode/source have
    // no null (they always resolve to an enum value); project null clears it.
    memory_mode: MemoryModeSchema.optional(),
    memory_project_id: z.string().min(1).nullable().optional(),
    memory_thread_source: MemoryThreadSourceSchema.optional(),
  })
  .strict();

export type UpdateKeyRequest = z.infer<typeof UpdateKeyRequestSchema>;

// Customer self-service subset. Deliberately separate from UpdateKeyRequestSchema:
// a bearer-key holder may tune only this key's Memory behavior and project scope,
// never lanes, budgets, role, or any other administrator-owned capability.
export const PortalMemorySettingsRequestSchema = z
  .object({
    memory_mode: MemoryModeSchema,
    memory_project_id: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();

export type PortalMemorySettingsRequest = z.infer<typeof PortalMemorySettingsRequestSchema>;
