import type { RateLimitStore } from "../store/ports.js";
import type { RateLimitConfig, RateLimitProbe, RateLimitResult } from "./types.js";

export interface RateLimiterDeps {
  config: RateLimitConfig;
  store: RateLimitStore;
}

interface ResolvedQuota {
  rpm: number;
  tpm: number;
}

// Resolve the effective quota for a key: per-key override (partial) layered over
// `default`. A missing override dimension falls back to default — overrides only
// affect the dimensions they name, and only for their own key.
function resolveQuota(config: RateLimitConfig, keyId: string): ResolvedQuota {
  const override = config.overrides[keyId];
  return {
    rpm: override?.rpm ?? config.default.rpm,
    tpm: override?.tpm ?? config.default.tpm,
  };
}

const ALLOWED: RateLimitResult = {
  allowed: true,
  limitedBy: null,
  limit: 0,
  remaining: Number.POSITIVE_INFINITY,
  resetSeconds: 0,
  retryAfterSeconds: 0,
};

// Build the per-key rate limiter. core-only: pure logic + a Store port, no web
// framework (principle 1). enabled=false OR both dimensions unlimited (0) ->
// always allowed and the store is NEVER touched (zero-overhead fast path,
// asserted in tests). When active, BOTH the RPM bucket (cost 1) and the TPM
// bucket (cost estimatedTokens) must admit the request; either shortfall rejects.
// Store failures propagate (fail-closed) — the middleware turns them into 429,
// never "unlimited".
export function createRateLimiter(deps: RateLimiterDeps): {
  check(probe: RateLimitProbe): Promise<RateLimitResult>;
} {
  const { config, store } = deps;

  async function check(probe: RateLimitProbe): Promise<RateLimitResult> {
    if (!config.enabled) return ALLOWED;
    const quota = resolveQuota(config, probe.keyId);
    const rpmOn = quota.rpm > 0;
    const tpmOn = quota.tpm > 0;
    if (!rpmOn && !tpmOn) return ALLOWED;

    // RPM first: 1 request = 1 token. A rejection here short-circuits before we
    // touch the TPM bucket (don't debit tokens for a request we already refused).
    if (rpmOn) {
      const r = await store.consume(probe.keyId, "rpm", null, quota.rpm, 1, probe.now);
      if (!r.ok) {
        return {
          allowed: false,
          limitedBy: "rpm",
          limit: quota.rpm,
          remaining: r.remaining,
          resetSeconds: r.resetSeconds,
          retryAfterSeconds: Math.max(1, r.resetSeconds),
        };
      }
      // RPM admitted. If TPM is off, this dimension's numbers ARE the headers.
      if (!tpmOn) {
        return {
          allowed: true,
          limitedBy: null,
          limit: quota.rpm,
          remaining: r.remaining,
          resetSeconds: r.resetSeconds,
          retryAfterSeconds: 0,
        };
      }
      // Both dims active: consume TPM, then report the tighter one.
      const t = await store.consume(
        probe.keyId,
        "tpm",
        null,
        quota.tpm,
        probe.estimatedTokens,
        probe.now,
      );
      if (!t.ok) {
        return {
          allowed: false,
          limitedBy: "tpm",
          limit: quota.tpm,
          remaining: t.remaining,
          resetSeconds: t.resetSeconds,
          retryAfterSeconds: Math.max(1, t.resetSeconds),
        };
      }
      // Both admitted: headers describe the dimension with less headroom
      // (fraction of its quota remaining), so the client sees the binding limit.
      const rpmFrac = r.remaining / quota.rpm;
      const tpmFrac = t.remaining / quota.tpm;
      const tighter =
        rpmFrac <= tpmFrac ? { res: r, limit: quota.rpm } : { res: t, limit: quota.tpm };
      return {
        allowed: true,
        limitedBy: null,
        limit: tighter.limit,
        remaining: tighter.res.remaining,
        resetSeconds: tighter.res.resetSeconds,
        retryAfterSeconds: 0,
      };
    }

    // Only TPM is active.
    const t = await store.consume(
      probe.keyId,
      "tpm",
      null,
      quota.tpm,
      probe.estimatedTokens,
      probe.now,
    );
    return {
      allowed: t.ok,
      limitedBy: t.ok ? null : "tpm",
      limit: quota.tpm,
      remaining: t.remaining,
      resetSeconds: t.resetSeconds,
      retryAfterSeconds: t.ok ? 0 : Math.max(1, t.resetSeconds),
    };
  }

  return { check };
}
