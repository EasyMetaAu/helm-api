import { describe, expect, it } from "vitest";
import {
  ApiKeyRecordSchema,
  CreateKeyRequestSchema,
  KeyRoleSchema,
  UpdateKeyRequestSchema,
} from "./schema.js";

function fullKey() {
  return {
    key_id: "k_root",
    hash: "abc123",
    prefix: "helm_live_ab12",
    account_id: "acct_default",
    role: "root",
    max_lane: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
  };
}

describe("ApiKeyRecordSchema", () => {
  it("accepts a full key record (docs/06 fields)", () => {
    expect(ApiKeyRecordSchema.safeParse(fullKey()).success).toBe(true);
  });

  it("accepts optional caps as null and as values", () => {
    const withCaps = { ...fullKey(), max_lane: "balanced", allowed_lanes: ["economy", "balanced"] };
    expect(ApiKeyRecordSchema.safeParse(withCaps).success).toBe(true);
  });

  it("enforces the role enum", () => {
    for (const r of ["root", "user"] as const) {
      expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), role: r }).success).toBe(true);
    }
    const res = ApiKeyRecordSchema.safeParse({ ...fullKey(), role: "admin" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  it("contains NO plaintext key field", () => {
    const parsed = ApiKeyRecordSchema.parse(fullKey());
    expect("plaintext" in parsed).toBe(false);
    expect("key" in parsed).toBe(false);
    expect("secret" in parsed).toBe(false);
  });

  it.each([
    "key_id",
    "hash",
    "prefix",
    "account_id",
    "role",
    "disabled",
    "rate_limit_rpm",
    "rate_limit_tpm",
  ])("rejects when required field %s is missing", (field) => {
    const base = fullKey() as Record<string, unknown>;
    delete base[field];
    expect(ApiKeyRecordSchema.safeParse(base).success).toBe(false);
  });

  it("accepts per-key rate-limit overrides (null = inherit, number = override)", () => {
    const inherit = ApiKeyRecordSchema.safeParse(fullKey());
    expect(inherit.success).toBe(true);
    const overridden = ApiKeyRecordSchema.safeParse({
      ...fullKey(),
      rate_limit_rpm: 60,
      rate_limit_tpm: 0, // 0 = explicitly unlimited for this dimension
    });
    expect(overridden.success).toBe(true);
  });

  it("rejects a negative / non-integer per-key rate limit (fail-closed)", () => {
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), rate_limit_rpm: -1 }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), rate_limit_tpm: 1.5 }).success).toBe(false);
  });

  it("exposes the role enum options", () => {
    expect([...KeyRoleSchema.options].sort()).toEqual(["root", "user"]);
  });
});

describe("CreateKeyRequestSchema", () => {
  it("accepts optional per-key rate limits", () => {
    const res = CreateKeyRequestSchema.safeParse({
      role: "user",
      rate_limit_rpm: 30,
      rate_limit_tpm: 10000,
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rate_limit_rpm).toBe(30);
      expect(res.data.rate_limit_tpm).toBe(10000);
    }
  });

  it("omits rate limits when not provided (inherit system default)", () => {
    const res = CreateKeyRequestSchema.safeParse({ role: "user" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rate_limit_rpm).toBeUndefined();
      expect(res.data.rate_limit_tpm).toBeUndefined();
    }
  });

  it("rejects an unknown field (strict)", () => {
    expect(CreateKeyRequestSchema.safeParse({ role: "user", nope: 1 }).success).toBe(false);
  });

  it("rejects a negative per-key rate limit", () => {
    expect(CreateKeyRequestSchema.safeParse({ rate_limit_rpm: -5 }).success).toBe(false);
  });
});

describe("UpdateKeyRequestSchema", () => {
  it("accepts a number (override) or null (clear to inherit) per dimension", () => {
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_rpm: 100 }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_rpm: null }).success).toBe(true);
    expect(
      UpdateKeyRequestSchema.safeParse({ rate_limit_rpm: null, rate_limit_tpm: 5000 }).success,
    ).toBe(true);
  });

  it("accepts an empty object (no-op patch)", () => {
    expect(UpdateKeyRequestSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown fields and invalid values (fail-closed)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ role: "root" }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_tpm: -1 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_rpm: 2.5 }).success).toBe(false);
  });
});
