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
      messages: [{ role: "user", content: "private content" }],
      attachments: ["blobdata"],
    });
    expect(out.messages).toEqual({ redacted: true, kind: "array", itemCount: 1 });
    expect(out.attachments).toEqual({ redacted: true, kind: "array", itemCount: 1 });
    expect(JSON.stringify(out)).not.toContain("private content");
    expect(JSON.stringify(out)).not.toContain("blobdata");
  });

  it("preserves non-sensitive fields verbatim", () => {
    const input = {
      trace_id: "t1",
      latency_ms: 1200,
      // Served-stream generation window (true-TPS denominator): a plain scalar
      // whose key carries no secret substring, so it must survive verbatim — the
      // admin derives TPS from it and would otherwise see it vanish.
      generation_ms: 4200,
      cost_usd: 0.004,
      status: "ok",
      error_class: null,
      selected_lane: "balanced",
    };
    expect(redact(input)).toEqual(input);
  });

  // Regression (docs/12 live-integration find): `memory_tokens_injected` matches the
  // secret pattern ("token") but is a NUMERIC COUNT — the old behaviour summarized it
  // into {redacted:true,kind:"number"}, corrupting the persisted DecisionRecord and
  // 502-ing /admin/api/requests on read. Scalars (number/boolean/null) can never
  // carry credential material → they pass through even under a secret-matching key.
  it("numeric token COUNTS pass through (scalars are never credentials)", () => {
    const input = {
      memory: { memory_tokens_injected: 191, memory_hydrated: true },
      max_tokens: 24,
      tokens_used: 1042,
    };
    expect(redact(input)).toEqual(input);
  });

  // Load-bearing guard for the dashboard token-accounting block (DecisionRecord
  // `usage`). The container key is `usage` — deliberately NOT matching the secret
  // pattern — so the object is recursed and its scalar `*_tokens` COUNT leaves pass
  // through verbatim. If anyone renames the block to a "token"-matching key the
  // whole object would summarize to {redacted:true,kind:"object"} and the counts
  // would vanish from telemetry. This pins that the counts survive.
  it("preserves the DecisionRecord usage token-count block verbatim", () => {
    const input = {
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 567,
        cached_tokens: 800,
        cache_creation_tokens: 0,
      },
      trace_id: "t1",
    };
    expect(redact(input)).toEqual(input);
  });

  it("preserves string token metrics and rate-limit headers while filtering real token fields", () => {
    const out = redact({
      provider_headers: {
        "x-ratelimit-remaining-tokens": "123",
        "x-request-id": "req-1",
      },
      token_count: "456",
      access_token: "oauth-secret-value",
      x_google_api_key: "google-secret-value",
      x_access_token: "oauth-header-secret-value",
      x_proxy_authorization: "proxy-header-secret-value",
    });

    expect(out.provider_headers).toEqual({
      "x-ratelimit-remaining-tokens": "123",
      "x-request-id": "req-1",
    });
    expect(out.token_count).toBe("456");
    expect(out.access_token).toMatch(/^sha256:/);
    expect(out.x_google_api_key).toMatch(/^sha256:/);
    expect(out.x_access_token).toMatch(/^sha256:/);
    expect(out.x_proxy_authorization).toMatch(/^sha256:/);
    expect(JSON.stringify(out)).not.toContain("oauth-secret-value");
    expect(JSON.stringify(out)).not.toContain("google-secret-value");
    expect(JSON.stringify(out)).not.toContain("oauth-header-secret-value");
    expect(JSON.stringify(out)).not.toContain("proxy-header-secret-value");
  });

  it("boolean/null under a secret-matching key pass through; strings/objects stay redacted", () => {
    const out = redact({
      token_present: true, // boolean — not a credential
      refresh_token: null, // null — nothing to leak
      access_token: "eyJhbGciOi.secret.payload", // string — fingerprint
      token_bundle: { access: "sk-live-1" }, // object — could hold secrets → summarize
    });
    expect(out.token_present).toBe(true);
    expect(out.refresh_token).toBeNull();
    expect(out.access_token).toMatch(/^sha256:/);
    expect(out.token_bundle).toEqual({ redacted: true, kind: "object", itemCount: 1 });
    expect(JSON.stringify(out)).not.toContain("sk-live-1");
    expect(JSON.stringify(out)).not.toContain("secret.payload");
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

  it("preserves the DecisionRecord protocol verbatim (drives Retry's native re-issue)", () => {
    // `protocol` is routing metadata, not credential material — it must survive
    // redaction so the admin Retry path can recover the original protocol from the
    // stored (redacted) DecisionRecord and re-issue the request in its native shape.
    const input = { protocol: "openai_responses", trace_id: "t1" };
    expect(redact(input)).toEqual(input);
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
