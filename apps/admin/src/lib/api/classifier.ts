// Admin classifier API client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic and runs
// NO classification (CLAUDE.md Principle 1). The server round-trips the FULL classifier
// config (ClassifierConfigSchema, the single source of truth); this client
// projects that into a small read-only UI view and, on save, merges the two
// editable knobs (eval on/off, rules.confidence_threshold) back onto the current
// server config and PUTs the whole object — so untouched data (dimensions,
// boundaries, eval details) is never dropped. See docs/03 + docs/11.

// A single scoring dimension, read-only in the UI. `direction` is derived from the
// weight's sign (+ pushes complexity up, - pulls it down) for display only.
export interface RuleDimension {
  name: string;
  weight: number;
  direction: 'up' | 'down' | 'neutral';
}

export interface ClassifierConfig {
  rules: {
    enabled: boolean; // read-only: Layer-1 is always on
    confidence_threshold: number; // editable, [0,1], default 0.45
    dimensions: RuleDimension[]; // read-only display
    boundaries?: Record<string, number>; // read-only: four-tier complexity boundaries
  };
  eval: {
    enabled: boolean; // editable: turn eval on/off
    model: string; // read-only
    temperature: number; // read-only (locked 0)
    max_tokens: number; // read-only
    timeout_ms: number; // read-only
    on_failure: string; // read-only (balanced)
    cache: { enabled: boolean; ttl_sec: number }; // read-only display
  };
}

const BASE = '/admin/api/classifier';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`classifier api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function direction(weight: number): RuleDimension['direction'] {
  if (weight > 0) return 'up';
  if (weight < 0) return 'down';
  return 'neutral';
}

// Project the server's record-keyed config into the ordered, read-only UI view.
function project(server: Record<string, unknown>): ClassifierConfig {
  const rules = (server.rules ?? {}) as Record<string, unknown>;
  const evalCfg = (server.eval ?? {}) as Record<string, unknown>;
  const dimRecord = (rules.dimensions ?? {}) as Record<string, { weight?: number }>;
  const cache = (evalCfg.cache ?? {}) as Record<string, unknown>;

  const dimensions: RuleDimension[] = Object.entries(dimRecord).map(([name, d]) => {
    const weight = num(d?.weight, 0);
    return { name, weight, direction: direction(weight) };
  });

  return {
    rules: {
      enabled: rules.enabled === true,
      confidence_threshold: num(rules.confidence_threshold, 0.45),
      dimensions,
      boundaries: (rules.tier_boundaries ?? undefined) as Record<string, number> | undefined,
    },
    eval: {
      enabled: evalCfg.enabled === true,
      model: typeof evalCfg.model === 'string' ? evalCfg.model : '',
      temperature: num(evalCfg.temperature, 0),
      max_tokens: num(evalCfg.max_tokens, 256),
      timeout_ms: num(evalCfg.timeout_ms, 250),
      on_failure: typeof evalCfg.on_failure === 'string' ? evalCfg.on_failure : 'balanced',
      cache: { enabled: cache.enabled === true, ttl_sec: num(cache.ttl_sec, 300) },
    },
  };
}

// GET /admin/api/classifier -> full config; projected to the read-only UI view.
export async function getClassifier(): Promise<ClassifierConfig> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const server = await asJson<Record<string, unknown>>(res);
  return project(server);
}

// PUT /admin/api/classifier <- the FULL config. The server schema is the source
// of truth and validates the whole object (out-of-range threshold -> 400, config
// unchanged: fail-closed, Principle 2). We re-read the current config, apply only the
// two editable knobs, and write the merged object back so no server-only field is
// lost. Returns the projected, persisted view.
export async function saveClassifier(patch: {
  eval_enabled?: boolean;
  confidence_threshold?: number;
}): Promise<ClassifierConfig> {
  const getRes = await fetch(BASE, { headers: { accept: 'application/json' } });
  const current = await asJson<Record<string, unknown>>(getRes);

  const next = structuredClone(current) as {
    rules: Record<string, unknown>;
    eval: Record<string, unknown>;
  };
  if (patch.confidence_threshold !== undefined) {
    next.rules.confidence_threshold = patch.confidence_threshold;
  }
  if (patch.eval_enabled !== undefined) {
    next.eval.enabled = patch.eval_enabled;
  }

  const putRes = await fetch(BASE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  const saved = await asJson<Record<string, unknown>>(putRes);
  return project(saved);
}
