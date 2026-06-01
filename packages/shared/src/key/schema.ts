import { z } from "zod";

// API key record (storage layer shape) per docs/06. Per CLAUDE.md principle 7,
// keys are stored as sha256 hash + display prefix ONLY — there is no plaintext
// field anywhere in this schema. Single source of truth via z.infer.

export const KeyRoleSchema = z.enum(["root", "user"]);

export const ApiKeyRecordSchema = z.object({
  key_id: z.string().min(1),
  hash: z.string().min(1), // sha256(plaintext) hex; never the plaintext
  prefix: z.string().min(1), // e.g. helm_live_ab12 — display/debug only
  account_id: z.string().min(1),
  role: KeyRoleSchema,
  // Per-key caps (docs/06): present-but-nullable so the storage shape is explicit.
  max_lane: z.string().nullable(),
  allowed_lanes: z.array(z.string()).nullable(),
  allow_custom_model: z.boolean(),
  disabled: z.boolean(),
  // Per-key rate-limit overrides (docs/06). NULL = inherit the system default
  // (runtime setting rate_limit_default_{rpm,tpm}); a number overrides that ONE
  // dimension only (0 = explicitly unlimited for this key). present-but-nullable
  // so the storage shape is explicit, mirroring the other per-key caps above.
  rate_limit_rpm: z.number().int().nonnegative().nullable(),
  rate_limit_tpm: z.number().int().nonnegative().nullable(),
});

export type KeyRole = z.infer<typeof KeyRoleSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

// Admin-facing create-key request (docs/06 Key 管理). The plaintext is minted
// server-side; the operator only specifies role + per-key caps. `.strict()` so an
// unknown field fails closed (原则2). role defaults to "user" — root keys are not
// minted casually through the admin UI.
export const CreateKeyRequestSchema = z
  .object({
    role: KeyRoleSchema.default("user"),
    max_lane: z.string().min(1).optional(),
    allowed_lanes: z.array(z.string().min(1)).optional(),
    allow_custom_model: z.boolean().optional(),
    // Optional per-key rate limits at mint time. Omitted => inherit the system
    // default. 0 => explicitly unlimited for that dimension (原则2 fail-closed on
    // a negative/non-int value).
    rate_limit_rpm: z.number().int().nonnegative().optional(),
    rate_limit_tpm: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CreateKeyRequest = z.infer<typeof CreateKeyRequestSchema>;

// Admin-facing update-key request (docs/06). Every per-key cap is editable after
// mint EXCEPT the immutable identity (key_id/hash/prefix/account_id) and `role`
// — role stays fixed so the edit path can never escalate a user key to root
// (rotate role by revoking + re-minting). `.strict()` so an unknown field fails
// closed (Principle 2). Every field is OPTIONAL (omit = leave unchanged); the
// nullable ones accept null to CLEAR the cap/override back to the default/no-cap:
//   - max_lane:             null = remove the lane cap.
//   - allowed_lanes:        null = remove the whitelist.
//   - rate_limit_{rpm,tpm}: null = inherit the system default; a number sets an
//     explicit override (0 = unlimited for that dimension).
// allow_custom_model is a plain boolean (not nullable): present = set, omit = leave.
export const UpdateKeyRequestSchema = z
  .object({
    max_lane: z.string().min(1).nullable().optional(),
    allowed_lanes: z.array(z.string().min(1)).nullable().optional(),
    allow_custom_model: z.boolean().optional(),
    rate_limit_rpm: z.number().int().nonnegative().nullable().optional(),
    rate_limit_tpm: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export type UpdateKeyRequest = z.infer<typeof UpdateKeyRequestSchema>;
