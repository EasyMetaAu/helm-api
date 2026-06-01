import { describe, expect, it } from "vitest";
import {
  AccountRecordSchema,
  CreditAdjustRequestSchema,
  CreditLedgerEntrySchema,
} from "./schema.js";

function fullAccount() {
  return {
    account_id: "acct_default",
    name: null,
    credit_balance_usd: 0,
    credit_quota_usd: null,
    disabled: false,
    created_at: 1_700_000_000_000,
  };
}

function fullLedgerEntry() {
  return {
    id: "led_1",
    account_id: "acct_default",
    request_id: "req_1",
    api_key_id: "k_root",
    amount_usd: -0.0123,
    balance_after_usd: 0.9877,
    kind: "debit",
    cost_measured: true,
    created_at: 1_700_000_000_000,
  };
}

describe("AccountRecordSchema", () => {
  it("accepts a full account record", () => {
    expect(AccountRecordSchema.safeParse(fullAccount()).success).toBe(true);
  });

  it("applies defaults: balance 0, name null, quota null, disabled false", () => {
    const parsed = AccountRecordSchema.parse({
      account_id: "acct_x",
      created_at: 1,
    });
    expect(parsed.credit_balance_usd).toBe(0);
    expect(parsed.name).toBeNull();
    expect(parsed.credit_quota_usd).toBeNull();
    expect(parsed.disabled).toBe(false);
  });

  it("credit_quota_usd is tri-state: null (inherit), number (cap), 0 (unlimited)", () => {
    for (const q of [null, 0, 12.5]) {
      expect(AccountRecordSchema.safeParse({ ...fullAccount(), credit_quota_usd: q }).success).toBe(
        true,
      );
    }
    // NaN / Infinity must be rejected (fail-closed on a non-finite quota).
    expect(
      AccountRecordSchema.safeParse({
        ...fullAccount(),
        credit_quota_usd: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-finite balance", () => {
    expect(
      AccountRecordSchema.safeParse({ ...fullAccount(), credit_balance_usd: Number.NaN }).success,
    ).toBe(false);
  });

  it("rejects an empty account_id", () => {
    expect(AccountRecordSchema.safeParse({ ...fullAccount(), account_id: "" }).success).toBe(false);
  });
});

describe("CreditLedgerEntrySchema", () => {
  it("accepts a full ledger entry", () => {
    expect(CreditLedgerEntrySchema.safeParse(fullLedgerEntry()).success).toBe(true);
  });

  it("enforces the kind enum", () => {
    for (const k of ["debit", "topup", "adjustment"] as const) {
      expect(CreditLedgerEntrySchema.safeParse({ ...fullLedgerEntry(), kind: k }).success).toBe(
        true,
      );
    }
    expect(
      CreditLedgerEntrySchema.safeParse({ ...fullLedgerEntry(), kind: "refund" }).success,
    ).toBe(false);
  });

  it("accepts a null request_id and null api_key_id (topup has no request)", () => {
    const entry = { ...fullLedgerEntry(), request_id: null, api_key_id: null, kind: "topup" };
    expect(CreditLedgerEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("api_key_id accepts a key_id string only (principle 7 — never plaintext)", () => {
    expect(
      CreditLedgerEntrySchema.safeParse({ ...fullLedgerEntry(), api_key_id: "k_abc" }).success,
    ).toBe(true);
  });

  it("amount_usd must be finite", () => {
    expect(
      CreditLedgerEntrySchema.safeParse({ ...fullLedgerEntry(), amount_usd: Number.NaN }).success,
    ).toBe(false);
  });

  it("cost_measured defaults to true when omitted", () => {
    const { cost_measured, ...rest } = fullLedgerEntry();
    void cost_measured;
    expect(CreditLedgerEntrySchema.parse(rest).cost_measured).toBe(true);
  });
});

describe("CreditAdjustRequestSchema", () => {
  it("accepts a finite amount_usd and optional note", () => {
    expect(CreditAdjustRequestSchema.safeParse({ amount_usd: 10 }).success).toBe(true);
    expect(CreditAdjustRequestSchema.safeParse({ amount_usd: -5, note: "refund" }).success).toBe(
      true,
    );
  });

  it("rejects a non-finite amount and unknown fields (fail-closed)", () => {
    expect(
      CreditAdjustRequestSchema.safeParse({ amount_usd: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(CreditAdjustRequestSchema.safeParse({ amount_usd: 1, bogus: true }).success).toBe(false);
  });
});
