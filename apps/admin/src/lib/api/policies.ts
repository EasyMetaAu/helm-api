// Admin policy API client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic and does
// NO matching (first-match resolution lives in headless core). The Policy shape
// mirrors the gateway's Zod schema (the single source of truth; @helm/core
// PolicySchema) — duplicated here as a UI-facing type only because admin must
// not import core (CLAUDE.md Principle 1). Per docs/04 the policy list is ORDERED and
// the order IS the match priority, so the client preserves order on the wire and
// the gateway PUTs the whole set (no per-item patch that could lose priority).

export interface PolicyMatch {
  task_type?: string; // enum: docs/03 task_type set (TASK_TYPE_OPTIONS)
  complexity?: string; // enum: server PolicyMatchSchema set (COMPLEXITY_OPTIONS)
  needs_json?: boolean;
  // NOTE: no org_id / user_id — routing has no org/user scope (per-key limits live
  // on the API key, not in policies). The server PolicyMatchSchema rejects them.
}

export interface Policy {
  id?: string;
  match: PolicyMatch; // all written fields AND together; empty match = catch-all
  use_lane?: string; // force matching requests onto this lane
}

// Dropdown enums. task_type MUST mirror the gateway's canonical TaskTypeSchema
// (@helm/shared classifier/eval-output.schema.ts — also @helm/core TaskType);
// admin can't import it (Principle 1), so it is duplicated here and guarded by a test.
// A config policy whose task_type is absent here renders the <select> blank
// (e.g. a `security` policy showed empty). complexity mirrors the SERVER
// PolicyMatchSchema enum (simple|medium|complex) — the gateway fail-closes (400)
// on any other value, so the UI must offer exactly that set to avoid writing
// config the gateway would reject. See implementation-notes.md.
export const TASK_TYPE_OPTIONS = [
  'chat',
  'coding',
  'math',
  'writing',
  'extraction',
  'tool_use',
  'vision',
  'web',
  'data',
  'security',
] as const;

export const COMPLEXITY_OPTIONS = ['simple', 'medium', 'complex'] as const;

const BASE = '/admin/api/policies';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`policies api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

function normalizeMatch(raw: Record<string, unknown> | undefined): PolicyMatch {
  const m = raw ?? {};
  const out: PolicyMatch = {};
  if (typeof m.task_type === 'string') out.task_type = m.task_type;
  if (typeof m.complexity === 'string') out.complexity = m.complexity;
  if (typeof m.needs_json === 'boolean') out.needs_json = m.needs_json;
  return out;
}

function normalizePolicy(raw: Record<string, unknown>): Policy {
  const p: Policy = {
    match: normalizeMatch(raw.match as Record<string, unknown> | undefined),
  };
  if (typeof raw.id === 'string') p.id = raw.id;
  if (typeof raw.use_lane === 'string') p.use_lane = raw.use_lane;
  return p;
}

// Drop empty/undefined match fields and send exactly one action. The server
// PolicyMatchSchema is `.strict()`, so unknown/empty noise must not be sent.
function toServerBody(p: Policy): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (p.match.task_type) match.task_type = p.match.task_type;
  if (p.match.complexity) match.complexity = p.match.complexity;
  if (p.match.needs_json === true) match.needs_json = true;

  const out: Record<string, unknown> = { match };
  if (p.id) out.id = p.id;
  if (p.use_lane) out.use_lane = p.use_lane;
  return out;
}

// GET /admin/api/policies -> Policy[] (ordered).
export async function listPolicies(): Promise<Policy[]> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const rows = await asJson<Record<string, unknown>[]>(res);
  return rows.map(normalizePolicy);
}

// PUT /admin/api/policies <- Policy[] (whole ordered set; order = priority).
export async function savePolicies(list: Policy[]): Promise<Policy[]> {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(list.map(toServerBody)),
  });
  const saved = await asJson<Record<string, unknown>[]>(res);
  return saved.map(normalizePolicy);
}
