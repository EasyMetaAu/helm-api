import { z } from "zod";

// Account + credit-ledger storage shapes (Issue #37 "Account credit quotas /
// billing"). One ACCOUNT : N keys (ApiKeyRecord.account_id links a key to its
// account). Per CLAUDE.md principle 7 the ledger carries a key_id ONLY — never a
// plaintext or hashed key. Zod is the single source of truth; types via z.infer.

// A finite USD amount (rejects NaN/±Infinity). Money must never be a non-finite
// number — a non-finite quota/balance would silently defeat the credit gate
// (Principle 2: fail-closed on malformed config/data).
const finiteUsd = z.number().finite();

// Account record. `credit_quota_usd` is TRI-STATE, mirroring the rate-limit quota
// convention (resolveQuota): null = inherit the system default
// (credit_default_quota_usd); a positive number = the hard cap; 0 = explicitly
// unlimited (no credit gate for this account). `credit_balance_usd` is the live
// running balance, decremented by post-served debits and increased by topups.
export const AccountRecordSchema = z.object({
  account_id: z.string().min(1),
  name: z.string().nullable().default(null),
  credit_balance_usd: finiteUsd.default(0),
  credit_quota_usd: finiteUsd.nullable().default(null),
  disabled: z.boolean().default(false),
  created_at: z.number().int(), // epoch ms
});

export type AccountRecord = z.infer<typeof AccountRecordSchema>;

// Append-only credit-ledger entry — the audit trail for every balance change.
// `kind`: 'debit' (post-served cost), 'topup' (operator adds credit),
// 'adjustment' (manual correction). `cost_measured` distinguishes a real measured
// 0 from "pricing unknown" (cost_usd === null) — a null-cost debit records 0 with
// cost_measured=false so reconciliation can find under-billed requests later (D4).
// `request_id`/`api_key_id` are null for topups/adjustments (no originating call).
export const CreditLedgerKindSchema = z.enum(["debit", "topup", "adjustment"]);

export const CreditLedgerEntrySchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  request_id: z.string().nullable().default(null),
  api_key_id: z.string().nullable().default(null), // key_id ONLY (principle 7)
  amount_usd: finiteUsd, // signed: negative = debit, positive = topup/credit
  balance_after_usd: finiteUsd,
  kind: CreditLedgerKindSchema,
  cost_measured: z.boolean().default(true),
  created_at: z.number().int(), // epoch ms
});

export type CreditLedgerKind = z.infer<typeof CreditLedgerKindSchema>;
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>;

// Admin-facing topup/adjustment request. `.strict()` so an unknown field fails
// closed (Principle 2). A positive amount adds credit (topup); a negative amount
// is a manual deduction (adjustment). The route decides the `kind` from the sign.
export const CreditAdjustRequestSchema = z
  .object({
    amount_usd: finiteUsd,
    note: z.string().min(1).optional(),
  })
  .strict();

export type CreditAdjustRequest = z.infer<typeof CreditAdjustRequestSchema>;
