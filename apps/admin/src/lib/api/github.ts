// GitHub star count for the header badge. Fetched CLIENT-SIDE (not proxied
// through the gateway) so the headless core stays free of outbound calls
// (CLAUDE.md Principle 6 / minimal-runtime). The unauthenticated GitHub API
// allows ~60 req/hr per IP, so we cache the result in localStorage and only
// refetch past the TTL. Every failure path is silent: the caller gets `null`
// and simply hides the count — a missing star badge must never break the UI.

export const REPO = 'EasyMetaAu/helm-api';

const CACHE_KEY = 'helm_admin_gh_stars';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

type FetchFn = typeof fetch;

interface StarCache {
  count: number;
  fetchedAt: number;
}

export interface StarCountOptions {
  fetchFn?: FetchFn;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Pass `null` to disable caching; defaults to localStorage when available. */
  storage?: Storage | null;
  ttlMs?: number;
}

/** Compact star count: 999 -> "999", 1234 -> "1.2k", 12345 -> "12.3k", 1_500_000 -> "1.5M". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimDecimal(n / 1000)}k`;
  return `${trimDecimal(n / 1_000_000)}M`;
}

function trimDecimal(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '');
}

function resolveStorage(opts?: StarCountOptions): Storage | null {
  if (opts && 'storage' in opts) return opts.storage ?? null;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function readCache(storage: Storage | null): StarCache | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StarCache>;
    if (typeof parsed.count === 'number' && typeof parsed.fetchedAt === 'number') {
      return { count: parsed.count, fetchedAt: parsed.fetchedAt };
    }
  } catch {
    // corrupt cache — ignore and refetch
  }
  return null;
}

function writeCache(storage: Storage | null, entry: StarCache): void {
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // storage unavailable (private mode / quota) — count still returns for the session
  }
}

/**
 * Resolve the repo's stargazer count, or `null` if it cannot be determined.
 * Serves a fresh cached value without a network call; on a stale/missing cache
 * it refetches, falling back to any stale value if the refetch fails.
 */
export async function getStarCount(opts?: StarCountOptions): Promise<number | null> {
  const now = opts?.now ?? (() => Date.now());
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const storage = resolveStorage(opts);
  const fetchFn = opts?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  const cached = readCache(storage);
  if (cached && now() - cached.fetchedAt < ttlMs) return cached.count;

  if (!fetchFn) return cached?.count ?? null;

  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return cached?.count ?? null;
    const body = (await res.json()) as { stargazers_count?: number };
    if (typeof body?.stargazers_count !== 'number') return cached?.count ?? null;
    const count = body.stargazers_count;
    writeCache(storage, { count, fetchedAt: now() });
    return count;
  } catch {
    return cached?.count ?? null;
  }
}
