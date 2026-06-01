// Admin lane API client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic. The
// lane shape mirrors the gateway's Zod schema (the single source of truth);
// these UI-facing types match docs/04 + the admin.lanes-ui contract. Extra
// server-only constraint fields (e.g. require_vision, min_context_tokens) are
// round-tripped untouched so a PUT never drops them (CLAUDE.md Principle 1, Principle 6).

// Server constraint shape uses optional/omitted for "unset". The UI prefers an
// explicit `max_latency_ms: number | null` (null = cleared); we translate at
// the HTTP boundary.
export interface LaneConstraints {
  require_tools: boolean;
  require_json: boolean;
  max_latency_ms: number | null;
  // Preserved verbatim on save; not surfaced in this view.
  [extra: string]: unknown;
}

export interface Lane {
  name: string; // economy | balanced | premium | coding | ...
  purpose?: string;
  primary: string;
  fallback: string[];
  constraints: LaneConstraints;
}

const BASE = '/admin/api/lanes';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`lanes api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

function normalizeConstraints(raw: Record<string, unknown> | undefined): LaneConstraints {
  const c = raw ?? {};
  const latency = c.max_latency_ms;
  return {
    ...c,
    require_tools: c.require_tools === true,
    require_json: c.require_json === true,
    max_latency_ms: typeof latency === 'number' ? latency : null,
  };
}

function normalizeLane(raw: Record<string, unknown>): Lane {
  return {
    name: String(raw.name ?? ''),
    purpose: typeof raw.purpose === 'string' ? raw.purpose : undefined,
    primary: String(raw.primary ?? ''),
    fallback: Array.isArray(raw.fallback) ? raw.fallback.map(String) : [],
    constraints: normalizeConstraints(raw.constraints as Record<string, unknown> | undefined),
  };
}

// Translate the UI lane back to the gateway PUT body: drop `name` (server schema
// is a strictObject — it must not appear) and convert a null latency to omitted.
function toServerBody(lane: Lane): Record<string, unknown> {
  const { name: _name, constraints, ...rest } = lane;
  const { max_latency_ms, ...restConstraints } = constraints;
  const serverConstraints: Record<string, unknown> = { ...restConstraints };
  if (typeof max_latency_ms === 'number') {
    serverConstraints.max_latency_ms = max_latency_ms;
  }
  return { ...rest, constraints: serverConstraints };
}

// GET /admin/api/lanes -> [{ name, ...lane }]
export async function listLanes(): Promise<Lane[]> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const rows = await asJson<Record<string, unknown>[]>(res);
  return rows.map(normalizeLane);
}

// PUT /admin/api/lanes/:name <- Lane (sans `name`; server fail-closed on extras).
export async function saveLane(name: string, lane: Lane): Promise<Lane> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toServerBody(lane)),
  });
  const saved = await asJson<Record<string, unknown>>(res);
  return normalizeLane({ name, ...saved });
}
