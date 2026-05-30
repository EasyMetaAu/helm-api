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
});

export type KeyRole = z.infer<typeof KeyRoleSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;
