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
    expect(parsed.native_protocol_passthrough).toBe(true);
    expect(parsed.payload_retention_days).toBe(30);
    expect(parsed.rate_limit_enabled).toBe(false);
    expect(parsed.rate_limit_default_rpm).toBe(0);
    expect(parsed.rate_limit_default_tpm).toBe(0);
    expect(parsed.log_level).toBe("info");
  });

  it("parses a full settings object field-by-field", () => {
    const parsed = RuntimeSettingsSchema.parse({
      capture_payloads: false,
      native_protocol_passthrough: false,
      payload_retention_days: 7,
      rate_limit_enabled: true,
      rate_limit_default_rpm: 60,
      rate_limit_default_tpm: 90000,
      log_level: "debug",
    });
    expect(parsed).toEqual({
      capture_payloads: false,
      native_protocol_passthrough: false,
      payload_retention_days: 7,
      rate_limit_enabled: true,
      rate_limit_default_rpm: 60,
      rate_limit_default_tpm: 90000,
      log_level: "debug",
      // Queueing fields backfilled by their schema defaults (both OFF).
      concurrency_queue_enabled: false,
      concurrency_queue_min_size: 5,
      concurrency_queue_size_multiplier: 0,
      concurrency_queue_wait_timeout_ms: 10_000,
      user_message_queue_enabled: false,
      user_message_queue_delay_ms: 200,
      user_message_queue_wait_timeout_ms: 5_000,
    });
  });

  it("rejects a negative / non-integer default rate limit (fail-closed)", () => {
    expect(RuntimeSettingsSchema.safeParse({ rate_limit_default_rpm: -1 }).success).toBe(false);
    expect(RuntimeSettingsSchema.safeParse({ rate_limit_default_tpm: 1.5 }).success).toBe(false);
  });

  it("accepts 0 as the default rate limit (0 = unlimited)", () => {
    expect(RuntimeSettingsSchema.safeParse({ rate_limit_default_rpm: 0 }).success).toBe(true);
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

  it("backfills queueing defaults from an empty object (both queues OFF)", () => {
    const parsed = RuntimeSettingsSchema.parse({});
    expect(parsed.concurrency_queue_enabled).toBe(false);
    expect(parsed.concurrency_queue_min_size).toBe(5);
    expect(parsed.concurrency_queue_size_multiplier).toBe(0);
    expect(parsed.concurrency_queue_wait_timeout_ms).toBe(10_000);
    expect(parsed.user_message_queue_enabled).toBe(false);
    expect(parsed.user_message_queue_delay_ms).toBe(200);
    expect(parsed.user_message_queue_wait_timeout_ms).toBe(5_000);
  });

  it("accepts a full queueing config within bounds", () => {
    const res = RuntimeSettingsSchema.safeParse({
      concurrency_queue_enabled: true,
      concurrency_queue_min_size: 100,
      concurrency_queue_size_multiplier: 2.5,
      concurrency_queue_wait_timeout_ms: 300_000,
      user_message_queue_enabled: true,
      user_message_queue_delay_ms: 0,
      user_message_queue_wait_timeout_ms: 1_000,
    });
    expect(res.success).toBe(true);
  });

  it("rejects out-of-bounds concurrency queue values (fail-closed)", () => {
    expect(RuntimeSettingsSchema.safeParse({ concurrency_queue_min_size: 0 }).success).toBe(false);
    expect(RuntimeSettingsSchema.safeParse({ concurrency_queue_min_size: 101 }).success).toBe(
      false,
    );
    expect(RuntimeSettingsSchema.safeParse({ concurrency_queue_min_size: 1.5 }).success).toBe(
      false,
    );
    expect(
      RuntimeSettingsSchema.safeParse({ concurrency_queue_size_multiplier: -0.1 }).success,
    ).toBe(false);
    expect(
      RuntimeSettingsSchema.safeParse({ concurrency_queue_wait_timeout_ms: 4_999 }).success,
    ).toBe(false);
    expect(
      RuntimeSettingsSchema.safeParse({ concurrency_queue_wait_timeout_ms: 300_001 }).success,
    ).toBe(false);
  });

  it("rejects out-of-bounds user-message queue values (fail-closed)", () => {
    expect(RuntimeSettingsSchema.safeParse({ user_message_queue_delay_ms: -1 }).success).toBe(
      false,
    );
    expect(RuntimeSettingsSchema.safeParse({ user_message_queue_delay_ms: 10_001 }).success).toBe(
      false,
    );
    expect(
      RuntimeSettingsSchema.safeParse({ user_message_queue_wait_timeout_ms: 999 }).success,
    ).toBe(false);
    expect(
      RuntimeSettingsSchema.safeParse({ user_message_queue_wait_timeout_ms: 300_001 }).success,
    ).toBe(false);
  });
});
