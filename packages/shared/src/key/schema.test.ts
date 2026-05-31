import { describe, expect, it } from "vitest";
import { ApiKeyRecordSchema, KeyRoleSchema } from "./schema.js";

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
  ])("rejects when required field %s is missing", (field) => {
    const base = fullKey() as Record<string, unknown>;
    delete base[field];
    expect(ApiKeyRecordSchema.safeParse(base).success).toBe(false);
  });

  it("exposes the role enum options", () => {
    expect([...KeyRoleSchema.options].sort()).toEqual(["root", "user"]);
  });
});
