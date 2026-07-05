import { describe, expect, it } from "vitest";
import {
  CodexOAuthUsageSchema,
  CodexResetResultSchema,
  OAuthQuotaSnapshotSchema,
} from "./usage-schema.js";

// The auto-park cooldown (`usageLimitedUntilMs`) rides on the quota snapshot. It must
// be OPTIONAL on the wire: legacy rows + unit fixtures written before the column existed
// omit it, and the parse must still succeed (defaulting to null), exactly like the
// `windowMinutes` field. A present value round-trips unchanged.
describe("OAuthQuotaSnapshotSchema — usageLimitedUntilMs", () => {
  const base = {
    providerId: "openai-codex",
    account: "default",
    windows: [],
    capturedAt: 123,
    source: "codex-headers" as const,
  };

  it("defaults usageLimitedUntilMs to null when absent (legacy rows parse)", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse(base);
    expect(parsed.usageLimitedUntilMs).toBeNull();
  });

  it("accepts an explicit null", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: null });
    expect(parsed.usageLimitedUntilMs).toBeNull();
  });

  it("round-trips an integer cooldown timestamp", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: 1_700_000 });
    expect(parsed.usageLimitedUntilMs).toBe(1_700_000);
  });

  it("round-trips an optional Codex reset-credit count", () => {
    const parsed = OAuthQuotaSnapshotSchema.parse({ ...base, resetCredits: 2 });
    expect(parsed.resetCredits).toBe(2);
  });

  it("rejects a non-integer cooldown", () => {
    expect(() => OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: 1.5 })).toThrow();
  });
});

describe("CodexOAuthUsageSchema.rate_limit_reset_credits", () => {
  it("parses available_count when present", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      rate_limit: { primary_window: { used_percent: 1 } },
      rate_limit_reset_credits: { available_count: 2 },
    });
    expect(parsed.rate_limit_reset_credits?.available_count).toBe(2);
  });

  it("accepts an absent or null reset-credits block (fail-open)", () => {
    expect(CodexOAuthUsageSchema.parse({}).rate_limit_reset_credits).toBeUndefined();
    expect(
      CodexOAuthUsageSchema.parse({ rate_limit_reset_credits: null }).rate_limit_reset_credits,
    ).toBeNull();
  });

  it("tolerates extra fields on the reset-credits block", () => {
    const parsed = CodexOAuthUsageSchema.parse({
      rate_limit_reset_credits: { available_count: 0, next_grant_at: 123, foo: "bar" },
    });
    expect(parsed.rate_limit_reset_credits?.available_count).toBe(0);
  });
});

describe("CodexResetResultSchema", () => {
  it("parses the consume envelope (code + windows_reset)", () => {
    const parsed = CodexResetResultSchema.parse({
      code: "ok",
      credit: { id: "c_1", status: "redeemed" },
      windows_reset: 2,
    });
    expect(parsed.code).toBe("ok");
    expect(parsed.windows_reset).toBe(2);
  });

  it("fails open on a body missing the fields we read", () => {
    const parsed = CodexResetResultSchema.parse({ unexpected: true });
    expect(parsed.code).toBeUndefined();
    expect(parsed.windows_reset).toBeUndefined();
  });
});
