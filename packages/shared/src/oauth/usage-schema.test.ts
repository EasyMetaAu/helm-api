import { describe, expect, it } from "vitest";
import { OAuthQuotaSnapshotSchema } from "./usage-schema.js";

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

  it("rejects a non-integer cooldown", () => {
    expect(() => OAuthQuotaSnapshotSchema.parse({ ...base, usageLimitedUntilMs: 1.5 })).toThrow();
  });
});
