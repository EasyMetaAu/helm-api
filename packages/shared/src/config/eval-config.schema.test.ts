import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { EvalCacheConfigSchema, type EvalConfig, EvalConfigSchema } from "./eval-config.schema.js";

// Hardened Layer-2 (small-model eval) config block — the typed foundation every
// downstream eval module (eval.contract/client/cache/cascade) reads. Per CLAUDE.md
// principle 2 (config-as-code, invalid => fail-closed) and principle 4 (eval is
// temperature:0, OFF by default, cached). See docs/03-classification.md Layer 2.

// The documented full eval block (config/classifier.yaml.classifier.eval).
function fullEval() {
  return {
    enabled: false,
    model: "deepseek/deepseek-v4-flash",
    temperature: 0,
    max_tokens: 256,
    timeout_ms: 250,
    outer_timeout_ms: 350,
    on_failure: "balanced",
    cache: {
      enabled: true,
      key: "content_hash",
      ttl_sec: 300,
      max_entries: 5000,
    },
  };
}

describe("EvalConfigSchema", () => {
  it("defaults to disabled with documented defaults from a minimal block (only model)", () => {
    const parsed = EvalConfigSchema.parse({ model: "deepseek/deepseek-v4-flash" });
    expect(parsed.enabled).toBe(false);
    expect(parsed.temperature).toBe(0);
    expect(parsed.max_tokens).toBe(256);
    expect(parsed.timeout_ms).toBe(250);
    expect(parsed.outer_timeout_ms).toBe(350);
    expect(parsed.on_failure).toBe("balanced");
    expect(parsed.cache.enabled).toBe(true);
    expect(parsed.cache.key).toBe("content_hash");
    expect(parsed.cache.ttl_sec).toBe(300);
    expect(parsed.cache.max_entries).toBe(5000);
  });

  it("parses the full documented eval block field-by-field", () => {
    const parsed = EvalConfigSchema.parse(fullEval());
    expect(parsed.enabled).toBe(false);
    expect(parsed.model).toBe("deepseek/deepseek-v4-flash");
    expect(parsed.temperature).toBe(0);
    expect(parsed.max_tokens).toBe(256);
    expect(parsed.timeout_ms).toBe(250);
    expect(parsed.outer_timeout_ms).toBe(350);
    expect(parsed.on_failure).toBe("balanced");
    expect(parsed.cache).toEqual({
      enabled: true,
      key: "content_hash",
      ttl_sec: 300,
      max_entries: 5000,
    });
  });

  it("rejects a missing model (fail-closed, error path contains model)", () => {
    const res = EvalConfigSchema.safeParse({});
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "model")).toBe(true);
    }
  });

  it("rejects a non-zero temperature via z.literal(0) (fail-closed)", () => {
    const bad = { ...fullEval(), temperature: 0.7 };
    const res = EvalConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "temperature")).toBe(true);
    }
  });

  it("rejects an on_failure other than balanced (no config that lies)", () => {
    const bad = { ...fullEval(), on_failure: "cheap" };
    const res = EvalConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "on_failure")).toBe(true);
    }
  });

  it("rejects a max_tokens above the 1024 cap (scale cost guard)", () => {
    const bad = { ...fullEval(), max_tokens: 4096 };
    const res = EvalConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "max_tokens")).toBe(true);
    }
  });

  it("defaults the outer timeout strictly above the inner (backstop ordering)", () => {
    const parsed = EvalConfigSchema.parse({ model: "deepseek-flash" });
    expect(parsed.outer_timeout_ms).toBeGreaterThan(parsed.timeout_ms);
  });

  it("rejects outer_timeout_ms <= timeout_ms (fail-closed; outer must back-stop inner)", () => {
    const bad = { ...fullEval(), timeout_ms: 300, outer_timeout_ms: 250 };
    const res = EvalConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "outer_timeout_ms")).toBe(true);
    }
  });

  it("rejects outer_timeout_ms equal to timeout_ms (strict ordering, no tie)", () => {
    const bad = { ...fullEval(), timeout_ms: 300, outer_timeout_ms: 300 };
    expect(EvalConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a cache.key other than content_hash (tighten against misconfig)", () => {
    const bad = fullEval();
    (bad.cache as { key: string }).key = "prompt_hash";
    expect(EvalConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("EvalCacheConfigSchema backfills cache defaults from {}", () => {
    const parsed = EvalCacheConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.key).toBe("content_hash");
    expect(parsed.ttl_sec).toBe(300);
    expect(parsed.max_entries).toBe(5000);
  });

  it("EvalConfig is the z.infer of EvalConfigSchema (single type source)", () => {
    expectTypeOf<EvalConfig>().toEqualTypeOf<z.infer<typeof EvalConfigSchema>>();
  });
});
