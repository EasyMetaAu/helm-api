import { createRateLimiter, InMemoryRateLimitStore } from "@helm/core";
import type { RateLimitConfig } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimitMiddleware } from "./rate-limit.js";

function cfg(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return { enabled: true, default: { rpm: 2, tpm: 0 }, overrides: {}, ...over };
}

// Build an app: a tiny middleware seeds identity.keyId (auth runs upstream of
// rate limiting in production), then rate limit, then a downstream handler.
function buildApp(config: RateLimitConfig, keyId = "k1") {
  const limiter = createRateLimiter({ config, store: new InMemoryRateLimitStore() });
  const app = new Hono();
  app.use("*", async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub for the test
    (c as any).set("identity", { keyId });
    await next();
  });
  app.use("*", rateLimitMiddleware({ limiter, now: () => 0, estimateTokens: () => 0 }));
  app.get("/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitMiddleware", () => {
  it("returns 429 rate_limited once the rpm bucket is exhausted", async () => {
    const app = buildApp(cfg({ default: { rpm: 2, tpm: 0 } }));
    expect((await app.request("/v1/chat/completions")).status).toBe(200);
    expect((await app.request("/v1/chat/completions")).status).toBe(200);
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string; limited_by: string } };
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.limited_by).toBe("rpm");
  });

  it("sets x-ratelimit-* headers on success and they decrement", async () => {
    const app = buildApp(cfg({ default: { rpm: 3, tpm: 0 } }));
    const r1 = await app.request("/v1/chat/completions");
    expect(r1.headers.get("x-ratelimit-limit")).toBe("3");
    expect(r1.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(r1.headers.get("x-ratelimit-reset")).not.toBeNull();
    const r2 = await app.request("/v1/chat/completions");
    expect(r2.headers.get("x-ratelimit-remaining")).toBe("1");
  });

  it("sets retry-after (positive) and rate limit headers when blocked", async () => {
    const app = buildApp(cfg({ default: { rpm: 1, tpm: 0 } }));
    await app.request("/v1/chat/completions");
    const blocked = await app.request("/v1/chat/completions");
    expect(blocked.status).toBe(429);
    const retry = Number(blocked.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("1");
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("enforces the TPM bucket via the injected estimateTokens (not a silent 0)", async () => {
    // A TPM-only key (rpm:0 unlimited, tpm:100). With a real estimator that
    // pre-debits each request's token estimate, the SECOND request that pushes
    // the window past 100 tokens is blocked by tpm — proving the estimator is
    // wired and TPM is no longer admit-everything.
    const limiter = createRateLimiter({
      config: cfg({ default: { rpm: 0, tpm: 100 } }),
      store: new InMemoryRateLimitStore(),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub
      (c as any).set("identity", { keyId: "k1" });
      await next();
    });
    // Fixed 60-token estimate per request: 1st (60) allowed, 2nd (120>100) blocked.
    app.use("*", rateLimitMiddleware({ limiter, now: () => 0, estimateTokens: () => 60 }));
    app.get("/v1/chat/completions", (c) => c.json({ ok: true }));

    expect((await app.request("/v1/chat/completions")).status).toBe(200);
    const blocked = await app.request("/v1/chat/completions");
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { limited_by: string } };
    expect(body.error.limited_by).toBe("tpm");
  });

  it("applies the per-key override carried on identity.caps.rateLimit (tighter than default)", async () => {
    // System default is rpm:5, but this key carries its OWN override rpm:1 (from
    // its ApiKeyRecord, surfaced by Auth). The middleware must thread that into
    // the probe so the key is blocked on its 2nd request, not the 6th.
    const limiter = createRateLimiter({
      config: cfg({ default: { rpm: 5, tpm: 0 } }),
      store: new InMemoryRateLimitStore(),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub for the test
      (c as any).set("identity", { keyId: "k1", caps: { rateLimit: { rpm: 1, tpm: null } } });
      await next();
    });
    app.use("*", rateLimitMiddleware({ limiter, now: () => 0, estimateTokens: () => 0 }));
    app.get("/v1/chat/completions", (c) => c.json({ ok: true }));

    expect((await app.request("/v1/chat/completions")).status).toBe(200);
    const blocked = await app.request("/v1/chat/completions");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("1");
  });

  it("is a no-op pass-through when disabled (no headers, always allowed)", async () => {
    const app = buildApp(cfg({ enabled: false, default: { rpm: 1, tpm: 0 } }));
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/v1/chat/completions");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    }
  });
});
