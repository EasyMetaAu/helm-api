import type { RateLimitProbe, RateLimitResult } from "@helm/core";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The limiter dependency (core, framework-agnostic). The middleware is glue ONLY
// — no token-bucket math, no quota resolution here (principle 1).
export interface RateLimiterPort {
  check(probe: RateLimitProbe): Promise<RateLimitResult>;
}

export interface RateLimitMiddlewareDeps {
  limiter: RateLimiterPort;
  // Injected clock (ms) so e2e/unit tests are deterministic; defaults to wall.
  now?: () => number;
  // Pre-classification token estimate for TPM pre-debit. Defaults to 0 (RPM-only
  // until a body-size estimator is wired). Kept injectable so it can grow without
  // touching the middleware contract.
  estimateTokens?: (c: Parameters<MiddlewareHandler>[0]) => number;
}

// Standard rate-limit headers (success and limited both carry the first three;
// limited additionally carries retry-after).
function setRateLimitHeaders(c: Parameters<MiddlewareHandler>[0], result: RateLimitResult): void {
  c.header("x-ratelimit-limit", String(result.limit));
  c.header("x-ratelimit-remaining", String(result.remaining));
  c.header("x-ratelimit-reset", String(result.resetSeconds));
}

// Rate-limit middleware. Position is a contract: AFTER auth (needs the resolved
// key_id) and BEFORE classify/route (cut off cost before classification/eval).
//   - allowed  -> set x-ratelimit-* headers, continue.
//   - !allowed -> 429 rate_limited (+ headers + retry-after), short-circuit.
// The error body is the structured rate_limited shape (docs/06/07); the Protocol
// Adapter may further translate it per client protocol. Logs use key_id ONLY,
// never a plaintext key (principle 7). Store failures from limiter.check()
// propagate (fail-CLOSED) — the global error handler turns them into a 5xx, NOT
// an "unlimited" pass-through.
export function rateLimitMiddleware(deps: RateLimitMiddlewareDeps): MiddlewareHandler {
  const now = deps.now ?? (() => Date.now());
  const estimateTokens = deps.estimateTokens ?? (() => 0);

  return async (c, next) => {
    const identity = c.get("identity") as { keyId?: string } | undefined;
    const keyId = identity?.keyId;
    // No resolved identity (e.g. an unauthenticated route slipped in) — nothing
    // to meter; let downstream handle auth. Never invents a key.
    if (keyId === undefined) {
      await next();
      return;
    }

    const result = await deps.limiter.check({
      keyId,
      estimatedTokens: estimateTokens(c),
      now: now(),
    });

    // Unmetered fast path (disabled / both dimensions unlimited): the limiter
    // reports limit 0. Pass through with NO x-ratelimit-* headers — zero
    // behavioral change on the main path.
    if (result.allowed && result.limit === 0) {
      await next();
      return;
    }

    setRateLimitHeaders(c, result);

    if (result.allowed) {
      await next();
      return;
    }

    c.header("retry-after", String(result.retryAfterSeconds));
    return c.json(
      {
        error: {
          type: "rate_limited" as const,
          message: `rate limit exceeded (${result.limitedBy})`,
          limited_by: result.limitedBy,
          retry_after_seconds: result.retryAfterSeconds,
        },
      },
      429 as ContentfulStatusCode,
    );
  };
}
