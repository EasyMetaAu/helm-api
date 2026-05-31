import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redact, redactKey } from "./redaction.js";

describe("redactKey", () => {
  it("returns sha256:<12 hex>, stable, no plaintext, distinct per input", () => {
    const f = redactKey("helm_live_secret");
    expect(f).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(f).toBe(redactKey("helm_live_secret"));
    expect(f).not.toContain("helm_live_secret");
    expect(redactKey("a")).not.toBe(redactKey("b"));
  });

  it("reconciles with the keystore sha256(plaintext) prefix", () => {
    const plaintext = "helm_live_x";
    const full = createHash("sha256").update(plaintext, "utf8").digest("hex");
    expect(redactKey(plaintext)).toBe(`sha256:${full.slice(0, 12)}`);
  });
});

describe("redact", () => {
  it("fingerprints nested secret fields, never emitting plaintext", () => {
    const out = redact({
      api_key: "sk-xxx",
      authorization: "Bearer sk-yyy",
      provider: { apiKey: "sk-zzz" },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-xxx");
    expect(serialized).not.toContain("sk-yyy");
    expect(serialized).not.toContain("sk-zzz");
    expect(out.api_key).toMatch(/^sha256:/);
    expect(out.authorization).toMatch(/^sha256:/);
    expect((out.provider as { apiKey: string }).apiKey).toMatch(/^sha256:/);
  });

  it("summarizes private payload fields", () => {
    const out = redact({
      messages: [{ role: "user", content: "私密内容" }],
      attachments: ["blobdata"],
    });
    expect(out.messages).toEqual({ redacted: true, kind: "array", itemCount: 1 });
    expect(out.attachments).toEqual({ redacted: true, kind: "array", itemCount: 1 });
    expect(JSON.stringify(out)).not.toContain("私密内容");
    expect(JSON.stringify(out)).not.toContain("blobdata");
  });

  it("preserves non-sensitive fields verbatim", () => {
    const input = {
      trace_id: "t1",
      latency_ms: 1200,
      cost_usd: 0.004,
      status: "ok",
      error_class: null,
      selected_lane: "balanced",
    };
    expect(redact(input)).toEqual(input);
  });

  it("preserves key_prefix verbatim (display prefix only — never hashed)", () => {
    // `key_prefix` matches the secret-key pattern ("key"), but it is ALREADY a
    // safe display prefix (helm_live_ab12), not the plaintext key — it must pass
    // through unchanged (principle 7: prefix only, no plaintext, but also no
    // double-fingerprinting that would make the Debug UI key column useless).
    const input = { key_prefix: "helm_live_ab12", trace_id: "t1" };
    expect(redact(input)).toEqual(input);
    // A real secret field is still fingerprinted.
    expect((redact({ api_key: "sk-secret" }) as { api_key: string }).api_key).toMatch(/^sha256:/);
  });

  it("is pure: does not mutate the input", () => {
    const input = { api_key: "sk-xxx", messages: [{ content: "hi" }], trace_id: "t1" };
    const clone = structuredClone(input);
    redact(input);
    expect(input).toEqual(clone);
  });

  it("redacts secrets inside an error model while keeping shape fields", () => {
    const out = redact({
      error_class: "upstream_error",
      http_status: 502,
      trace_id: "t1",
      message: "ok",
      provider_raw: { authorization: "Bearer sk-secret", detail: "boom" },
    });
    expect(out.error_class).toBe("upstream_error");
    expect(out.http_status).toBe(502);
    expect(out.trace_id).toBe("t1");
    expect((out.provider_raw as { authorization: string }).authorization).toMatch(/^sha256:/);
    expect(JSON.stringify(out)).not.toContain("sk-secret");
  });

  it("handles null, primitives, and circular references without throwing", () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});
