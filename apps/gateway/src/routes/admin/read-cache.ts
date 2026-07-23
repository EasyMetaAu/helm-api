export type AdminReadCacheStatus = "miss" | "coalesced" | "fresh" | "stale";

export interface AdminReadCacheResult<T> {
  value: T;
  status: AdminReadCacheStatus;
}

export interface AdminReadCacheOptions {
  freshTtlMs?: number;
  staleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  schedule?: (run: () => void) => void;
  runInBackground?: (task: () => Promise<unknown>, onError?: (error: unknown) => void) => boolean;
}

interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

const DEFAULT_FRESH_TTL_MS = 10_000;
const DEFAULT_STALE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;

function defer(run: () => void): void {
  const timer = setTimeout(run, 0);
  if (typeof timer.unref === "function") timer.unref();
}

// Small stale-while-revalidate cache for expensive, read-only Admin aggregates.
// A cold miss is still authoritative and awaited. Once a last-known-good snapshot
// exists, an expired read returns it immediately and schedules one coalesced refresh.
// The deferred refresh matters for better-sqlite3: calling an async wrapper directly
// would still enter its synchronous SQL work before the stale response can leave.
export function createAdminReadCache<T>(options: AdminReadCacheOptions = {}) {
  const freshTtlMs = options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
  const staleTtlMs = Math.max(options.staleTtlMs ?? DEFAULT_STALE_TTL_MS, freshTtlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defer;
  const runInBackground = options.runInBackground;
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  const scheduled = new Set<string>();

  const store = (key: string, value: T): T => {
    const at = now();
    entries.delete(key);
    entries.set(key, {
      value,
      freshUntil: at + freshTtlMs,
      staleUntil: at + staleTtlMs,
    });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return value;
  };

  const loadOnce = (
    key: string,
    load: () => Promise<T>,
  ): { promise: Promise<T>; shared: boolean } => {
    const current = inFlight.get(key);
    if (current !== undefined) return { promise: current, shared: true };
    // Defer invocation to a microtask so the in-flight marker exists before a
    // synchronous adapter begins work; concurrent callers then share one scan.
    const promise = Promise.resolve()
      .then(load)
      .then((value) => store(key, value))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return { promise, shared: false };
  };

  const scheduleRefresh = (key: string, load: () => Promise<T>): void => {
    if (scheduled.has(key) || inFlight.has(key)) return;
    scheduled.add(key);
    schedule(() => {
      scheduled.delete(key);
      const refresh = () => loadOnce(key, load).promise;
      if (runInBackground?.(refresh, () => {}) === true) return;
      if (runInBackground !== undefined) return;
      void refresh().catch(() => {
        // Keep the last-known-good stale snapshot. The next read may retry; an
        // auxiliary Admin refresh failure must not become an unhandled rejection.
      });
    });
  };

  return {
    async get(key: string, load: () => Promise<T>): Promise<AdminReadCacheResult<T>> {
      const at = now();
      const hit = entries.get(key);
      if (hit !== undefined && hit.freshUntil > at) {
        entries.delete(key);
        entries.set(key, hit);
        return { value: hit.value, status: "fresh" };
      }
      if (hit !== undefined && hit.staleUntil > at) {
        scheduleRefresh(key, load);
        return { value: hit.value, status: "stale" };
      }
      if (hit !== undefined) entries.delete(key);

      const pending = loadOnce(key, load);
      return {
        value: await pending.promise,
        status: pending.shared ? "coalesced" : "miss",
      };
    },
  };
}

export function adminWindowCacheKey(input: {
  start: number;
  end: number;
  now: number;
  startWasDefault: boolean;
  endWasDefault: boolean;
  dimensions: readonly (string | number | undefined)[];
}): string {
  const live = input.endWasDefault || Math.abs(input.end - input.now) <= 60_000;
  const duration = input.end - input.start;
  const rollingPresetMs = [
    3_600_000,
    6 * 3_600_000,
    86_400_000,
    7 * 86_400_000,
    30 * 86_400_000,
  ].find((candidate) => Math.abs(duration - candidate) <= 1_000);
  const start =
    live && (input.startWasDefault || rollingPresetMs !== undefined)
      ? `rolling:${rollingPresetMs ?? duration}`
      : input.start;
  const end = live ? "live" : input.end;
  return JSON.stringify([start, end, ...input.dimensions]);
}
