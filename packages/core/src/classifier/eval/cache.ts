import type { EvalOutput } from "@helm/shared";
import { buildEvalCacheKey, type ClassifierInput } from "./cache-key.js";
import { type EvalClientDeps, type EvalDecision, runEval } from "./client.js";

// eval.cache — an in-process TTL + LRU container plus the `runEvalCached`
// wrapper. eval is a costly, latency-bearing network call; repeating it for the
// same (or essentially the same) request is waste. We key by the content-hash
// (eval.cache-key) — NOT conversation_id — because the gateway is stateless, so
// identical content hits the cache even across instances (each process keeps its
// own copy; that is self-consistent with the stateless key design).
//
// Time is INJECTED (nowMs) at every entry point — the container never calls
// Date.now() — so TTL expiry is deterministic under test. Only `decided:true`
// results are cached: fail-open shakes (timeout/jitter/circuit-open) are usually
// transient, and caching one would amplify a single blip into a 300s outage
// (CLAUDE.md principle 3).

export interface EvalCache {
  /** Hit (and fresh) → the cached output; expired or absent → undefined. */
  get(key: string, nowMs: number): EvalOutput | undefined;
  /** Insert with expireAt = nowMs + ttl; evicts the LRU entry past capacity. */
  set(key: string, value: EvalOutput, nowMs: number): void;
  readonly size: number;
}

interface Entry {
  value: EvalOutput;
  expireAt: number;
}

/**
 * Create a TTL + LRU eval cache. Recency is tracked by `Map` insertion order:
 * re-inserting a key moves it to the most-recent position, so the first key in
 * iteration order is always the least-recently-used eviction victim.
 */
export function createEvalCache(opts: { ttlSec: number; maxEntries: number }): EvalCache {
  const ttlMs = opts.ttlSec * 1000;
  const maxEntries = opts.maxEntries;
  const store = new Map<string, Entry>();

  return {
    get(key, nowMs) {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (entry.expireAt <= nowMs) {
        // Expired → treat as a miss and drop it.
        store.delete(key);
        return undefined;
      }
      // Refresh recency: delete + re-insert moves the key to most-recent.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value, nowMs) {
      // Re-insert at the most-recent position (delete first so order updates).
      store.delete(key);
      store.set(key, { value, expireAt: nowMs + ttlMs });
      // Evict least-recently-used entries until within capacity.
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get size() {
      return store.size;
    },
  };
}

/** Dependencies for the cached wrapper: the underlying `runEval` deps plus the
 *  cache, an injected clock, and an optional `runEval` override (defaults to the
 *  real client) for deterministic testing. */
export type EvalCachedDeps = EvalClientDeps<ClassifierInput> & {
  cache: EvalCache;
  nowMs: number;
  runEval?: (
    input: ClassifierInput,
    deps: EvalClientDeps<ClassifierInput>,
  ) => Promise<EvalDecision>;
};

/**
 * Cached eval. On a cache hit returns the stored decision tagged
 * `cache_hit:true` without touching the network; on a miss it runs `runEval`,
 * caches ONLY a `decided:true` result, and returns it tagged `cache_hit:false`.
 * Never throws — `runEval` itself fails open to `{ decided:false, reason }`.
 */
export async function runEvalCached(
  input: ClassifierInput,
  deps: EvalCachedDeps,
): Promise<EvalDecision & { cache_hit: boolean }> {
  const { cache, nowMs, runEval: runEvalImpl = runEval, ...clientDeps } = deps;
  const key = buildEvalCacheKey(input);

  const cached = cache.get(key, nowMs);
  if (cached !== undefined) {
    // Cache hit → no new model call, so NO incremental eval self-cost (cost_usd
    // null, not a stale figure: the cost was already counted when first run).
    return { decided: true, output: cached, latency_ms: 0, cost_usd: null, cache_hit: true };
  }

  const decision = await runEvalImpl(input, clientDeps);
  if (decision.decided) {
    cache.set(key, decision.output, nowMs);
  }
  return { ...decision, cache_hit: false };
}
