// Admin memory API client. The admin UI is a pure consumer of the gateway's
// /admin/api/memory/* HTTP surface — it imports NO core/gateway business logic
// (CLAUDE.md Principle 1). The backend (apps/gateway admin/memory.ts) is the
// single source of truth: reads expose superseded/archived/pruned rows (status
// filter), fact edits recompute content_hash (409 on collision), deletes are
// SOFT. We define UI-facing types here rather than import @helm/shared — the
// admin package stays framework/core independent.

// One (account, project, resource, thread) group that holds live facts and/or an
// active reflection — the "By Scope" tab row. Timestamps are ISO strings off the
// wire (the gateway serializes Date → ISO via c.json()).
export interface MemoryScope {
  accountId: string;
  projectId: string | null;
  resourceId: string | null;
  threadId: string | null;
  factCount: number;
  reflectionCount: number;
  lastUpdated: string | null;
}

// Lifecycle status shared by facts (active|archived|pruned) and reflections
// (active|archived). 'pruned' never appears on a reflection.
export type MemoryStatus = 'active' | 'archived' | 'pruned';

// The status VALUES the fact-list filter accepts. 'superseded' is NOT a stored
// status — it is the derived view "status='active' AND expiredAt IS NOT NULL" (a
// live fact replaced by a newer same-subject one, shown with the "superseded" badge).
// 'all' drops the status predicate. A fact can only be PATCHed to a real MemoryStatus.
export type FactStatusFilter = MemoryStatus | 'all' | 'superseded';

// A persisted fact row read back from the store. ownerId = the account tenant
// boundary; project/resource/thread are in-account scopes (any may be null).
// expiredAt non-null on an ACTIVE row = the fact was superseded by a newer one.
export interface Fact {
  id: string;
  ownerId: string;
  projectId: string | null;
  resourceId: string | null;
  threadId: string | null;
  subjectKey: string;
  factText: string;
  contentHash: string;
  importance: number;
  referenceCount: number;
  referencedAt: string | null;
  validFrom: string;
  invalidAt: string | null;
  expiredAt: string | null;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

// A persisted reflection row — the slow-changing long tier, versioned per scope.
export interface Reflection {
  id: string;
  projectId: string | null;
  resourceId: string | null;
  threadId: string | null;
  reflectionText: string;
  version: number;
  tokenEstimate: number;
  updatedAt: string;
  referencedAt: string | null;
  referenceCount: number;
  status: 'active' | 'archived';
}

// Resolve-a-key response: the key's memory scope (account + default project).
export interface KeyScope {
  key_id: string;
  accountId: string;
  projectId: string | null;
}

// Fact list query: scope narrowing + status visibility ('all' shows superseded /
// archived / pruned rows too — a management read, unlike the inject hot path).
export interface FactQuery {
  accountId?: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  status?: FactStatusFilter;
  subjectKey?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// Hand-add a fact (POST /admin/api/memory/facts). Scope addresses where the fact
// lives (account + nullable project/resource/thread); `subjectText` is normalized to
// the supersede key server-side. importance defaults to 0.5 when omitted.
export interface FactCreate {
  accountId?: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  subjectText: string;
  factText: string;
  importance?: number;
}

// POST result: the created/resurrected row (null on a pure dedup) plus the reconcile
// summary so the UI can say "added" / "already existed" / "replaced an older fact".
export interface FactCreateResult {
  fact: Fact | null;
  added: string[];
  resurrected: string[];
  superseded: string[];
  deduped: boolean;
}

// Reflection list query. `includeAllVersions` returns every version row (default
// is the latest active version per scope).
export interface ReflectionQuery {
  accountId?: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  status?: 'active' | 'archived' | 'all';
  includeAllVersions?: boolean;
  limit?: number;
  offset?: number;
}

// Fact edit (partial). Absent key = leave unchanged; invalidAt is tri-state
// (omit = leave, null = clear, ISO string = set). subjectKey is NOT editable here
// (it is the supersede identity). Editing factText recomputes content_hash, which
// can 409 against a sibling row carrying identical text.
export interface FactPatch {
  factText?: string;
  importance?: number;
  status?: MemoryStatus;
  invalidAt?: string | null;
}

const BASE = '/admin/api/memory';

// Surface the server's structured {error} on a non-2xx so the page can show the
// real reason — notably 409 (a fact with identical text already exists) and 400
// (bad input). Falls back to the bare status when the body is not JSON.
async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `memory api ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      } else {
        message = `${message}: ${JSON.stringify(body)}`;
      }
    } catch {
      // body not JSON; keep the status-only message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// Build a query string, dropping undefined/empty params (each filter is
// present-only on the server). Booleans + numbers are stringified; false/0 are
// kept since they are meaningful, but `includeAllVersions:false` is dropped (the
// server only branches on the literal string "true").
function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      if (value) sp.set(key, 'true');
      continue;
    }
    if (typeof value === 'string' && value.length === 0) continue;
    sp.set(key, String(value));
  }
  const q = sp.toString();
  return q.length > 0 ? `?${q}` : '';
}

// GET /admin/api/memory/scopes -> one row per (account,project,resource,thread).
export async function listScopes(accountId?: string): Promise<MemoryScope[]> {
  const res = await fetch(`${BASE}/scopes${queryString({ accountId })}`, {
    headers: { accept: 'application/json' },
  });
  return asJson<MemoryScope[]>(res);
}

// GET /admin/api/memory/by-key/:keyId -> the key's memory scope (account +
// default project). 404 on an unknown key (surfaced as an error message).
export async function resolveKey(keyId: string): Promise<KeyScope> {
  const res = await fetch(`${BASE}/by-key/${encodeURIComponent(keyId)}`, {
    headers: { accept: 'application/json' },
  });
  return asJson<KeyScope>(res);
}

// GET /admin/api/memory/facts -> { rows, total } for a scope + status filter.
export async function listFacts(params: FactQuery): Promise<{ rows: Fact[]; total: number }> {
  const res = await fetch(`${BASE}/facts${queryString({ ...params })}`, {
    headers: { accept: 'application/json' },
  });
  return asJson<{ rows: Fact[]; total: number }>(res);
}

// POST /admin/api/memory/facts -> create a fact. Scope rides the querystring (same
// shape as the GET); the fact fields go in the body. 400 on empty/invalid input.
export async function createFact(params: FactCreate): Promise<FactCreateResult> {
  const { subjectText, factText, importance, ...scope } = params;
  const res = await fetch(`${BASE}/facts${queryString({ ...scope })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectText,
      factText,
      ...(importance !== undefined ? { importance } : {}),
    }),
  });
  return asJson<FactCreateResult>(res);
}

// PATCH /admin/api/memory/facts/:id -> the updated fact. 409 on a content_hash
// collision (identical text already exists); 400 on bad input; 404 if unknown.
export async function updateFact(id: string, patch: FactPatch): Promise<Fact> {
  const res = await fetch(`${BASE}/facts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return asJson<Fact>(res);
}

// DELETE /admin/api/memory/facts/:id -> soft delete (status='pruned').
export async function deleteFact(id: string): Promise<void> {
  const res = await fetch(`${BASE}/facts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await asJson<{ deleted: string }>(res);
}

// GET /admin/api/memory/reflections -> { rows, total } for a scope + status.
export async function listReflections(
  params: ReflectionQuery,
): Promise<{ rows: Reflection[]; total: number }> {
  const res = await fetch(`${BASE}/reflections${queryString({ ...params })}`, {
    headers: { accept: 'application/json' },
  });
  return asJson<{ rows: Reflection[]; total: number }>(res);
}

// PATCH /admin/api/memory/reflections/:id -> the updated reflection (text edited
// in place; the server recomputes tokenEstimate but does NOT bump version).
export async function updateReflection(
  id: string,
  patch: { reflectionText: string },
): Promise<Reflection> {
  const res = await fetch(`${BASE}/reflections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return asJson<Reflection>(res);
}

// DELETE /admin/api/memory/reflections/:id -> soft delete (status='archived').
export async function deleteReflection(id: string): Promise<void> {
  const res = await fetch(`${BASE}/reflections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await asJson<{ deleted: string }>(res);
}
