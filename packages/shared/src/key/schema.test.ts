import { describe, expect, it } from "vitest";
import {
  ApiKeyRecordSchema,
  CreateKeyRequestSchema,
  effectiveMemoryProjectId,
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

  it("accepts the allowed-lanes whitelist as null and as values", () => {
    const withCaps = { ...fullKey(), allowed_lanes: ["economy", "balanced"] };
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

  it("accepts per-key usage budgets (number = cap, null = no cap)", () => {
    const withBudgets = ApiKeyRecordSchema.safeParse({
      ...fullKey(),
      budget_requests: 1000,
      budget_tokens: 500_000,
      budget_spend_usd: 25.5,
      budget_window_seconds: 86_400,
      over_budget_behavior: "reject",
      degrade_lane: "economy",
    });
    expect(withBudgets.success).toBe(true);
  });

  it("defaults budgets to no-cap + degrade when omitted (legacy rows / additive field)", () => {
    const parsed = ApiKeyRecordSchema.parse(fullKey());
    expect(parsed.budget_requests).toBeNull();
    expect(parsed.budget_tokens).toBeNull();
    expect(parsed.budget_spend_usd).toBeNull();
    expect(parsed.budget_window_seconds).toBeNull();
    expect(parsed.over_budget_behavior).toBe("degrade");
    expect(parsed.degrade_lane).toBeNull();
  });

  it("rejects invalid budget values (fail-closed)", () => {
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_requests: -1 }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_tokens: 1.5 }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_spend_usd: -0.01 }).success).toBe(
      false,
    );
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_window_seconds: 0 }).success).toBe(
      false,
    );
    expect(
      ApiKeyRecordSchema.safeParse({ ...fullKey(), over_budget_behavior: "explode" }).success,
    ).toBe(false);
  });

  it("defaults concurrency_limit to null = unlimited (legacy rows / additive field)", () => {
    const parsed = ApiKeyRecordSchema.parse(fullKey());
    expect(parsed.concurrency_limit).toBeNull();
  });

  it("accepts a strictly positive concurrency_limit; rejects 0 / negative / non-int", () => {
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), concurrency_limit: 1 }).success).toBe(true);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), concurrency_limit: null }).success).toBe(
      true,
    );
    // 0 is NOT a sentinel here — null already means unlimited (mirrors budgets).
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), concurrency_limit: 0 }).success).toBe(
      false,
    );
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), concurrency_limit: -1 }).success).toBe(
      false,
    );
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), concurrency_limit: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a 0 budget cap (0 is NOT 'unlimited' — null means no cap)", () => {
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_requests: 0 }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_tokens: 0 }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), budget_spend_usd: 0 }).success).toBe(false);
  });

  it("defaults name to null when omitted (legacy rows / additive field)", () => {
    expect(ApiKeyRecordSchema.parse(fullKey()).name).toBeNull();
  });

  it("accepts a name (1..100 chars), trims it, and rejects empty/whitespace/over-long", () => {
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), name: "Production backend" }).success).toBe(
      true,
    );
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), name: null }).success).toBe(true);
    // A padded label is stored normalized (trimmed).
    expect(ApiKeyRecordSchema.parse({ ...fullKey(), name: "  Production  " }).name).toBe(
      "Production",
    );
    // Empty / whitespace-only must never masquerade as a real label — null is the
    // only "unnamed" (whitespace collapses to "" and fails min(1)).
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), name: "" }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), name: "   " }).success).toBe(false);
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), name: "x".repeat(101) }).success).toBe(
      false,
    );
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

  it("accepts optional per-key budgets + over-budget behavior", () => {
    const res = CreateKeyRequestSchema.safeParse({
      role: "user",
      budget_spend_usd: 10,
      budget_window_seconds: 3600,
      over_budget_behavior: "degrade",
      degrade_lane: "economy",
    });
    expect(res.success).toBe(true);
  });

  it("accepts an optional concurrency_limit at mint; rejects 0 / negative", () => {
    expect(CreateKeyRequestSchema.safeParse({ role: "user", concurrency_limit: 4 }).success).toBe(
      true,
    );
    expect(CreateKeyRequestSchema.safeParse({ role: "user" }).success).toBe(true);
    expect(CreateKeyRequestSchema.safeParse({ concurrency_limit: 0 }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ concurrency_limit: -2 }).success).toBe(false);
  });

  it("rejects invalid budget values on create (fail-closed; 0 rejected)", () => {
    expect(CreateKeyRequestSchema.safeParse({ budget_requests: -1 }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ budget_requests: 0 }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ budget_spend_usd: 0 }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ over_budget_behavior: "nope" }).success).toBe(false);
  });

  it("accepts an optional name at mint (trimmed); rejects empty / whitespace / over-long", () => {
    const res = CreateKeyRequestSchema.safeParse({ role: "user", name: "  Mobile app  " });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.name).toBe("Mobile app"); // stored trimmed
    expect(CreateKeyRequestSchema.safeParse({ role: "user" }).success).toBe(true);
    expect(CreateKeyRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
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

  it("accepts editable caps: allowed_lanes / allow_custom_model", () => {
    expect(
      UpdateKeyRequestSchema.safeParse({ allowed_lanes: ["economy", "balanced"] }).success,
    ).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ allow_custom_model: true }).success).toBe(true);
  });

  it("accepts null to clear the allowed-lanes whitelist", () => {
    expect(UpdateKeyRequestSchema.safeParse({ allowed_lanes: null }).success).toBe(true);
  });

  it("rejects role (immutable — cannot escalate via edit)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ role: "root" }).success).toBe(false);
  });

  it("rejects the retired max_lane cap (strict — no longer a per-key field)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ max_lane: "balanced" }).success).toBe(false);
    expect(CreateKeyRequestSchema.safeParse({ role: "user", max_lane: "balanced" }).success).toBe(
      false,
    );
  });

  it("rejects unknown fields and invalid values (fail-closed)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_tpm: -1 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ rate_limit_rpm: 2.5 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ allowed_lanes: [""] }).success).toBe(false);
  });

  it("accepts budget edits: number (set), null (clear), behavior + degrade lane", () => {
    expect(UpdateKeyRequestSchema.safeParse({ budget_spend_usd: 50 }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ budget_spend_usd: null }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ over_budget_behavior: "reject" }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ degrade_lane: null }).success).toBe(true);
  });

  it("rejects invalid budget edits (fail-closed)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ budget_tokens: -1 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ over_budget_behavior: "halt" }).success).toBe(false);
  });

  it("accepts concurrency_limit edits: number (set), null (clear to unlimited)", () => {
    expect(UpdateKeyRequestSchema.safeParse({ concurrency_limit: 8 }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ concurrency_limit: null }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ concurrency_limit: 0 }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ concurrency_limit: 2.5 }).success).toBe(false);
  });

  it("renames a key: new name (set, trimmed) / null (clear); rejects empty / whitespace / over-long", () => {
    const res = UpdateKeyRequestSchema.safeParse({ name: "  Renamed  " });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.name).toBe("Renamed"); // stored trimmed
    expect(UpdateKeyRequestSchema.safeParse({ name: null }).success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateKeyRequestSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

// Per-key memory defaults (issue #97): server-side defaults so clients that can
// only send static headers (Claude Code / Codex) — or none at all — still get
// memory. Explicit x-memory-* request headers always override these.
describe("per-key memory defaults (issue #97)", () => {
  it("defaults to off/null/header when omitted (legacy rows / additive fields)", () => {
    const parsed = ApiKeyRecordSchema.parse(fullKey());
    expect(parsed.memory_mode).toBe("off");
    expect(parsed.memory_project_id).toBeNull();
    expect(parsed.memory_thread_source).toBe("header");
  });

  it("accepts explicit memory defaults and enforces the enums (fail-closed)", () => {
    const ok = ApiKeyRecordSchema.parse({
      ...fullKey(),
      memory_mode: "inject",
      memory_project_id: "proj-1",
      memory_thread_source: "auto",
    });
    expect(ok.memory_mode).toBe("inject");
    expect(ok.memory_project_id).toBe("proj-1");
    expect(ok.memory_thread_source).toBe("auto");
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), memory_mode: "on" }).success).toBe(false);
    expect(
      ApiKeyRecordSchema.safeParse({ ...fullKey(), memory_thread_source: "magic" }).success,
    ).toBe(false);
    // Empty project id must never look like a real scope id.
    expect(ApiKeyRecordSchema.safeParse({ ...fullKey(), memory_project_id: "" }).success).toBe(
      false,
    );
  });

  it("CreateKeyRequest accepts optional memory defaults", () => {
    const res = CreateKeyRequestSchema.safeParse({
      role: "user",
      memory_mode: "inject",
      memory_project_id: "proj-1",
      memory_thread_source: "auto",
    });
    expect(res.success).toBe(true);
  });

  it("UpdateKeyRequest edits memory defaults; null clears the project id", () => {
    const res = UpdateKeyRequestSchema.safeParse({
      memory_mode: "observe",
      memory_project_id: null,
      memory_thread_source: "header",
    });
    expect(res.success).toBe(true);
    expect(UpdateKeyRequestSchema.safeParse({ memory_mode: "loud" }).success).toBe(false);
  });
});

describe("effectiveMemoryProjectId", () => {
  it("falls back to the key's own id when memory_project_id is null (isolate by key)", () => {
    expect(effectiveMemoryProjectId({ memory_project_id: null, key_id: "k-abc" })).toBe("k-abc");
  });

  it("uses the explicit memory_project_id when set (shared pool across keys)", () => {
    expect(effectiveMemoryProjectId({ memory_project_id: "team-pool", key_id: "k-abc" })).toBe(
      "team-pool",
    );
  });
});
