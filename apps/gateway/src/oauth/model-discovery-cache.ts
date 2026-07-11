export const DEFAULT_OAUTH_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_OAUTH_MODEL_DISCOVERY_FAILURE_TTL_MS = 60 * 1000;
export const DEFAULT_OAUTH_MODEL_DISCOVERY_CACHE_MAX_ENTRIES = 128;

export interface OAuthModelDiscoveryCacheKey {
  providerId: string;
  account: string;
}

export interface OAuthModelDiscoveryCache {
  load(key: OAuthModelDiscoveryCacheKey, discover: () => Promise<string[]>): Promise<string[]>;
  invalidate(key: OAuthModelDiscoveryCacheKey): void;
}

export interface OAuthModelDiscoveryCacheOptions {
  ttlMs?: number;
  failureTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  models: string[];
  fetchedAtMs: number;
  retryAtMs: number;
}

function cacheKey(key: OAuthModelDiscoveryCacheKey): string {
  return JSON.stringify([key.providerId, key.account]);
}

function normalizeModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);
}

export function createOAuthModelDiscoveryCache(
  options: OAuthModelDiscoveryCacheOptions = {},
): OAuthModelDiscoveryCache {
  const ttlMs = boundedDuration(options.ttlMs, DEFAULT_OAUTH_MODEL_DISCOVERY_CACHE_TTL_MS);
  const failureTtlMs = boundedDuration(
    options.failureTtlMs,
    DEFAULT_OAUTH_MODEL_DISCOVERY_FAILURE_TTL_MS,
  );
  const maxEntries =
    options.maxEntries === undefined || !Number.isFinite(options.maxEntries)
      ? DEFAULT_OAUTH_MODEL_DISCOVERY_CACHE_MAX_ENTRIES
      : Math.max(1, Math.floor(options.maxEntries));
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry>();
  const refreshes = new Map<string, Promise<string[]>>();
  const generations = new Map<string, number>();

  function store(id: string, generation: number, entry: CacheEntry): void {
    if ((generations.get(id) ?? 0) !== generation) return;
    entries.set(id, entry);
    if (entries.size <= maxEntries) return;
    const oldest = [...entries.entries()]
      .filter(([candidate]) => candidate !== id)
      .sort(
        ([, left], [, right]) =>
          Math.max(left.fetchedAtMs, left.retryAtMs) - Math.max(right.fetchedAtMs, right.retryAtMs),
      )[0];
    if (oldest) entries.delete(oldest[0]);
  }

  return {
    async load(key, discover) {
      const id = cacheKey(key);
      const currentTime = now();
      const hit = entries.get(id);
      if (
        hit &&
        ((hit.models.length > 0 && currentTime - hit.fetchedAtMs < ttlMs) ||
          currentTime < hit.retryAtMs)
      ) {
        return [...hit.models];
      }

      const active = refreshes.get(id);
      if (active) return active.then((models) => [...models]);

      const generation = generations.get(id) ?? 0;
      let run: Promise<string[]>;
      run = (async () => {
        try {
          const models = normalizeModels(await discover());
          const refreshedAt = now();
          if (models.length > 0) {
            store(id, generation, {
              models,
              fetchedAtMs: refreshedAt,
              retryAtMs: 0,
            });
            return models;
          }
          const fallback = hit?.models ?? [];
          store(id, generation, {
            models: fallback,
            fetchedAtMs: hit?.fetchedAtMs ?? refreshedAt,
            retryAtMs: refreshedAt + failureTtlMs,
          });
          return fallback;
        } catch {
          const failedAt = now();
          const fallback = hit?.models ?? [];
          store(id, generation, {
            models: fallback,
            fetchedAtMs: hit?.fetchedAtMs ?? failedAt,
            retryAtMs: failedAt + failureTtlMs,
          });
          return fallback;
        }
      })().finally(() => {
        if (refreshes.get(id) === run) refreshes.delete(id);
      });
      refreshes.set(id, run);
      return run.then((models) => [...models]);
    },

    invalidate(key) {
      const id = cacheKey(key);
      generations.set(id, (generations.get(id) ?? 0) + 1);
      entries.delete(id);
      refreshes.delete(id);
    },
  };
}
