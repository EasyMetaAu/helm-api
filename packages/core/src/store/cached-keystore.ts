import type { ApiKeyRecord } from "@helm/shared";
import type { CreateKeyInput, KeyPatch, KeyStore } from "./ports.js";

export interface CachedKeyStoreOptions {
  // How long a getByHash result (hit OR miss) stays fresh. Also the upper bound on
  // cross-instance staleness when several gateways share one Postgres DB: a key
  // revoked on instance A keeps serving on instance B for at most this long.
  ttlMs: number;
  // Hard cap on cached hashes; LRU-evicts past it so a flood of distinct (invalid)
  // keys cannot grow the Map without bound.
  maxEntries: number;
  // Injected clock (ms) — never calls Date.now() itself, so TTL is deterministic
  // under test, mirroring classifier/eval/cache.ts.
  now: () => number;
}

interface Entry {
  value: ApiKeyRecord | null;
  expireAt: number;
}

// Wrap a KeyStore with an in-process TTL + LRU cache over getByHash — the per-request
// auth lookup. better-sqlite3 is synchronous, so an uncached getByHash is a blocking
// point-read on the single event-loop thread for EVERY request on all four AI faces;
// caching collapses repeat lookups of the same bearer key to a Map hit. BOTH hits and
// misses are cached (an invalid-key flood must not become a DB-read flood). Recency is
// tracked by Map insertion order (delete + re-insert moves a key to most-recent), the
// same proven pattern as createEvalCache.
//
// Any mutation (createKey/disable/deleteKey/updateKey/rotateKey) forwards to the
// inner store and then busts the WHOLE cache: mutations are rare admin operations,
// and a full clear avoids maintaining a keyId→hash reverse index while
// guaranteeing a revoked, edited, or rotated key is never served stale within the
// process (all mutations flow through this same wrapped instance — see server.ts
// composition root).
export function createCachedKeyStore(inner: KeyStore, opts: CachedKeyStoreOptions): KeyStore {
  const { ttlMs, maxEntries, now } = opts;
  const cache = new Map<string, Entry>();

  return {
    async getByHash(hash: string): Promise<ApiKeyRecord | null> {
      const nowMs = now();
      const hit = cache.get(hash);
      if (hit !== undefined) {
        if (hit.expireAt > nowMs) {
          // Fresh hit — refresh recency (delete + re-insert → most-recent).
          cache.delete(hash);
          cache.set(hash, hit);
          return hit.value;
        }
        // Expired — drop and fall through to a fresh read.
        cache.delete(hash);
      }
      const value = await inner.getByHash(hash);
      cache.set(hash, { value, expireAt: nowMs + ttlMs });
      // Evict least-recently-used entries until within capacity.
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return value;
    },

    getById(keyId: string): Promise<ApiKeyRecord | null> {
      return inner.getById(keyId);
    },

    list(): Promise<ApiKeyRecord[]> {
      return inner.list();
    },

    async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
      const created = await inner.createKey(input);
      cache.clear();
      return created;
    },

    async disable(keyId: string): Promise<void> {
      await inner.disable(keyId);
      cache.clear();
    },

    async deleteKey(keyId: string): Promise<void> {
      await inner.deleteKey(keyId);
      cache.clear();
    },

    async updateKey(keyId: string, patch: KeyPatch): Promise<void> {
      await inner.updateKey(keyId, patch);
      cache.clear();
    },

    async rotateKey(keyId, input) {
      await inner.rotateKey(keyId, input);
      cache.clear();
    },

    getSecretEnc(keyId) {
      return inner.getSecretEnc(keyId);
    },
  };
}
