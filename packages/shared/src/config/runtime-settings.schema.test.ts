import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { type RuntimeSettings, RuntimeSettingsSchema } from "./runtime-settings.schema.js";

// Runtime-mutable settings — the admin "System Settings" surface. Per CLAUDE.md
// principle 2 (config-as-code, invalid => fail-closed): the admin PUT validates
// against this schema and rejects on any invalid field.

describe("RuntimeSettingsSchema", () => {
  it("backfills documented defaults from an empty object", () => {
    const parsed = RuntimeSettingsSchema.parse({});
    expect(parsed.capture_payloads).toBe(true);
    expect(parsed.payload_retention_days).toBe(30);
    expect(parsed.rate_limit_enabled).toBe(false);
    expect(parsed.log_level).toBe("info");
  });

  it("parses a full settings object field-by-field", () => {
    const parsed = RuntimeSettingsSchema.parse({
      capture_payloads: false,
      payload_retention_days: 7,
      rate_limit_enabled: true,
      log_level: "debug",
    });
    expect(parsed).toEqual({
      capture_payloads: false,
      payload_retention_days: 7,
      rate_limit_enabled: true,
      log_level: "debug",
    });
  });

  it("rejects a non-integer retention (fail-closed)", () => {
    const res = RuntimeSettingsSchema.safeParse({ payload_retention_days: 1.5 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "payload_retention_days")).toBe(
        true,
      );
    }
  });

  it("rejects a zero/negative retention (must be positive)", () => {
    expect(RuntimeSettingsSchema.safeParse({ payload_retention_days: 0 }).success).toBe(false);
    expect(RuntimeSettingsSchema.safeParse({ payload_retention_days: -3 }).success).toBe(false);
  });

  it("rejects a retention above the 10-year cap", () => {
    expect(RuntimeSettingsSchema.safeParse({ payload_retention_days: 4000 }).success).toBe(false);
  });

  it("rejects an unknown log level (fail-closed)", () => {
    const res = RuntimeSettingsSchema.safeParse({ log_level: "verbose" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "log_level")).toBe(true);
    }
  });

  it("RuntimeSettings is the z.infer of RuntimeSettingsSchema (single type source)", () => {
    expectTypeOf<RuntimeSettings>().toEqualTypeOf<z.infer<typeof RuntimeSettingsSchema>>();
  });
});
