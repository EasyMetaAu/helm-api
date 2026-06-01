// Admin client for the gateway's public, same-origin meta endpoints. Both are
// served at the ORIGIN ROOT (not under /admin) and require no auth, so the SPA
// reaches them with a relative fetch. Like the rest of the admin UI this is a
// pure consumer — it renders what the gateway reports, computes nothing.
//
//   GET /version  -> { version, gitSha, builtAt }   (apps/gateway/src/build-info.ts)
//   GET /healthz  -> { status, ready, checks }       (200 ok / 503 degraded)

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

/** Live gateway reachability, collapsed to three operator-facing states. */
export type HealthState = 'online' | 'degraded' | 'offline';

type FetchFn = typeof fetch;

const JSON_HEADERS = { accept: 'application/json' } as const;

export async function getVersion(fetchFn: FetchFn = fetch): Promise<BuildInfo> {
  const res = await fetchFn('/version', { headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`/version responded ${res.status}`);
  return (await res.json()) as BuildInfo;
}

/**
 * Probe the gateway's readiness. Fail-open by design (CLAUDE.md Principle 3):
 * a network/unreachable error becomes `offline` rather than throwing, so a
 * polling caller never has to guard against rejection.
 *  - 200            -> online
 *  - reachable, !ok -> degraded (e.g. 503 store probe failure)
 *  - throw/network  -> offline
 */
export async function getHealth(fetchFn: FetchFn = fetch): Promise<HealthState> {
  try {
    const res = await fetchFn('/healthz', { headers: JSON_HEADERS });
    return res.ok ? 'online' : 'degraded';
  } catch {
    return 'offline';
  }
}
