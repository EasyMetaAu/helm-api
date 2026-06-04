import type { KeyedSemaphore } from "@helm/core";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Per-API-key concurrency overflow queue (issue #93, feature A). Glue ONLY: the
// counting semaphore (FIFO handoff, timeout, abort, watchdog) lives in core;
// this layer reads the live runtime settings, computes the effective queue
// capacity, and renders the 429. Position is a contract: AFTER auth (needs the
// resolved key_id + per-key limit) and AFTER rate-limit (a hard-rejected request
// must not occupy a queue slot), BEFORE classify/route.

export interface ConcurrencyGateConfig {
  enabled: boolean;
  // 固定最小排队数: fixed minimum queue capacity per key.
  minSize: number;
  // 排队数倍数: effective max queue = multiplier > 0
  //   ? MAX(floor(multiplier × limit), minSize) : minSize.
  multiplier: number;
  // 排队超时: max wait for a slot before the 429.
  waitTimeoutMs: number;
}

export type ConcurrencyAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "queue_full" | "timeout" | "aborted"; retryAfterSeconds: number };

// Injected into the self-auth routes (messages / responses / gemini) the same
// way their RateLimiterPort is — and consumed by concurrencyMiddleware for the
// chat surface. One port, every entrypoint.
export interface ConcurrencyGatePort {
  acquire(args: {
    keyId: string;
    limit: number | null;
    signal: AbortSignal;
  }): Promise<ConcurrencyAcquireResult>;
}

export interface ConcurrencyGateDeps {
  semaphore: KeyedSemaphore;
  // Live settings thunk (re-bound by the admin PUT) — read fresh on every
  // acquire so the toggle/knobs apply without a restart.
  getConfig: () => ConcurrencyGateConfig;
}

const NOOP_LEASE = { ok: true as const, release: (): void => {} };

export function createConcurrencyGate(deps: ConcurrencyGateDeps): ConcurrencyGatePort {
  return {
    async acquire({ keyId, limit, signal }) {
      const cfg = deps.getConfig();
      // Disabled feature or an unlimited key: zero-touch pass-through.
      if (!cfg.enabled || limit === null || limit <= 0) return NOOP_LEASE;
      const maxQueue =
        cfg.multiplier > 0
          ? Math.max(Math.floor(cfg.multiplier * limit), cfg.minSize)
          : cfg.minSize;
      const result = await deps.semaphore.acquire({
        key: keyId,
        limit,
        maxQueue,
        timeoutMs: cfg.waitTimeoutMs,
        signal,
      });
      if (result.ok) return result;
      // queue_full: the queue itself is saturated — retry almost immediately
      // (slots churn fast). timeout: the key is persistently over capacity —
      // suggest a slightly longer backoff.
      return {
        ok: false,
        reason: result.reason,
        retryAfterSeconds: result.reason === "queue_full" ? 1 : 5,
      };
    },
  };
}

declare module "hono" {
  interface ContextVariableMap {
    // Streaming claim (chat route): streamSSE returns its Response BEFORE the
    // stream body finishes, so the middleware's own finally would release a
    // streamed request's slot too early. The route CLAIMS the lease right
    // before returning streamSSE and releases it inside the stream's finally;
    // an unclaimed lease (non-stream, or a throw before the stream started) is
    // released by the middleware. Releases are idempotent either way.
    concurrencyClaim?: () => () => void;
    // Self-auth surfaces (messages / responses / gemini): the HANDLER acquires
    // (auth happens inside it) and parks the release here; the route-scoped
    // concurrencyReleaseGuard frees an unclaimed lease on ANY exit path. A
    // stream handler claims by clearing this var and releasing in its own
    // finally instead.
    concurrencyRelease?: (() => void) | undefined;
  }
}

// Release guard for the SELF-AUTH routes (messages / responses / gemini), where
// auth — and therefore the acquire — happens inside the handler. Registered on
// the route path BEFORE the handler: whatever the handler parks on
// `concurrencyRelease` is freed here on every exit path, including a throw into
// onError. Stream handlers claim the lease (clear the var) and release in their
// own finally, since this guard runs as soon as the Response is returned —
// before the stream body has finished. Releases are idempotent.
export function concurrencyReleaseGuard(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } finally {
      c.get("concurrencyRelease")?.();
    }
  };
}

export function concurrencyMiddleware(gate: ConcurrencyGatePort): MiddlewareHandler {
  return async (c, next) => {
    const identity = c.get("identity") as
      | { keyId?: string; caps?: { concurrencyLimit?: number | null } }
      | undefined;
    const keyId = identity?.keyId;
    // No resolved identity — nothing to gate; downstream handles auth.
    if (keyId === undefined) {
      await next();
      return;
    }
    const acquired = await gate.acquire({
      keyId,
      limit: identity?.caps?.concurrencyLimit ?? null,
      signal: c.req.raw.signal,
    });
    if (!acquired.ok) {
      c.header("retry-after", String(acquired.retryAfterSeconds));
      return c.json(
        {
          error: {
            type: "rate_limited" as const,
            message:
              acquired.reason === "queue_full"
                ? "concurrency queue is full"
                : "timed out waiting for a concurrency slot",
            limited_by: "concurrency",
            retry_after_seconds: acquired.retryAfterSeconds,
          },
        },
        429 as ContentfulStatusCode,
      );
    }
    let claimed = false;
    c.set("concurrencyClaim", () => {
      claimed = true;
      return acquired.release;
    });
    try {
      await next();
    } finally {
      if (!claimed) acquired.release();
    }
  };
}
