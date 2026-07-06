// Admin API key client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic and owns
// NO auth logic (CLAUDE.md Principle 1). Normal list/detail responses are redacted
// KeySummary rows (prefix only — NEVER hash full-text, plaintext, or ciphertext).
// Full keys cross this boundary only through dedicated create/reveal/rotate calls.
// Rotation mutates only the secret value for the same key_id; revocation is a soft
// DELETE (disabled:true).
// We define UI-facing types here rather than depend on @helm/core (admin must not
// import core); the role enum mirrors the server KeyRoleSchema (root | user).

// Redacted key view for list/detail. By construction this NEVER carries a hash
// full-text, plaintext, or ciphertext — only the short display prefix.
export interface ApiKeyView {
  key_id: string;
  prefix: string; // e.g. helm_live_ab12 — display/debug only
  role: 'root' | 'user';
  name: string | null; // human-readable label; null = unnamed (cosmetic only)
  allowed_lanes: string[] | null; // lane whitelist (empty/null = any lane)
  allow_custom_model: boolean; // explicit client-model passthrough
  blocked_models: string[] | null; // exact model ids denied across direct and lane routes
  allow_fast_mode: boolean; // explicit client-requested Fast mode passthrough
  disabled: boolean; // revoked state (soft)
  rate_limit_rpm: number | null; // per-key RPM override; null = inherit system default
  rate_limit_tpm: number | null; // per-key TPM override; null = inherit system default
  // Per-key usage budgets (docs/06). null = no cap for that dimension. When over a
  // budget, the key is DEGRADED to `degrade_lane` (default economy) or REJECTED
  // (429), per `over_budget_behavior`. window null = system default.
  budget_requests: number | null;
  budget_tokens: number | null;
  budget_spend_usd: number | null;
  budget_window_seconds: number | null;
  over_budget_behavior: 'degrade' | 'reject';
  degrade_lane: string | null;
  // Per-key max in-flight requests (issue #93). null = unlimited. Enforced only
  // while the runtime setting concurrency_queue_enabled is ON.
  concurrency_limit: number | null;
  // Per-key memory defaults (issue #97). Explicit x-memory-* request headers
  // always override; mode 'off' (the default) = memory inert for this key.
  memory_mode: 'off' | 'observe' | 'inject';
  memory_project_id: string | null;
  memory_thread_source: 'header' | 'auto';
}

// Operator-specified caps for a new key. The plaintext is minted server-side; the
// operator only chooses role + per-key caps. role defaults to "user" — root keys
// are not minted casually (docs/06).
export interface CreateKeyInput {
  role?: 'root' | 'user';
  // Optional human-readable label at mint time (omitted => unnamed).
  name?: string;
  allowed_lanes?: string[];
  allow_custom_model?: boolean;
  blocked_models?: string[];
  allow_fast_mode?: boolean;
  // Optional per-key rate limits at mint time. Omitted => inherit the system
  // default. 0 => explicitly unlimited for that dimension.
  rate_limit_rpm?: number;
  rate_limit_tpm?: number;
  // Optional per-key usage budgets at mint time. Omitted => no cap for that
  // dimension. over_budget_behavior omitted => server default ("degrade").
  budget_requests?: number;
  budget_tokens?: number;
  budget_spend_usd?: number;
  budget_window_seconds?: number;
  over_budget_behavior?: 'degrade' | 'reject';
  degrade_lane?: string;
  // Optional max in-flight requests at mint time. Omitted => unlimited.
  concurrency_limit?: number;
  // Optional per-key memory defaults at mint time (issue #97). Omitted => the server
  // mints the new-key defaults (mode 'inject', thread_source 'auto').
  memory_mode?: 'off' | 'observe' | 'inject';
  memory_project_id?: string;
  memory_thread_source?: 'header' | 'auto';
}

// Editable caps for an existing key (PATCH). Mirrors the server
// UpdateKeyRequestSchema: every field is OPTIONAL (omit = leave unchanged); the
// nullable ones accept null to CLEAR (allowed_lanes → no whitelist; rate limit →
// inherit the system default). `role` and the immutable identity are deliberately
// absent — role cannot be edited (rotate by revoke + re-mint).
export interface UpdateKeyInput {
  // Rename: omit = leave unchanged; null = clear back to unnamed.
  name?: string | null;
  allowed_lanes?: string[] | null;
  allow_custom_model?: boolean;
  blocked_models?: string[] | null;
  allow_fast_mode?: boolean;
  rate_limit_rpm?: number | null;
  rate_limit_tpm?: number | null;
  budget_requests?: number | null;
  budget_tokens?: number | null;
  budget_spend_usd?: number | null;
  budget_window_seconds?: number | null;
  over_budget_behavior?: 'degrade' | 'reject';
  degrade_lane?: string | null;
  // Omit = leave unchanged; null = clear back to unlimited.
  concurrency_limit?: number | null;
  // Memory default edits (issue #97). Omit = leave unchanged; project null clears.
  memory_mode?: 'off' | 'observe' | 'inject';
  memory_project_id?: string | null;
  memory_thread_source?: 'header' | 'auto';
}

// Create/rotate responses intentionally carry plaintext so the operator can copy
// the new value. `prefix` is the server-minted non-sensitive display prefix (same
// value stored + listed) — carried so the UI builds the redacted view from it
// instead of slicing plaintext.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
  prefix: string;
  // true when the server stored encrypted recovery material, so this key can be
  // revealed later from the admin surface. Older/self-hosted deployments without
  // an encryption key still return plaintext now, but cannot reveal it later.
  recoverable?: boolean;
}

export interface RevealedKey {
  key_id: string;
  plaintext: string;
}

// DELETE response (soft revoke). The server echoes the revoked id; it does NOT
// return the record (the UI marks the row disabled locally).
export interface RevokeResult {
  revoked: string;
}

// DELETE ?purge=true response (permanent delete of an already-revoked key). The
// server echoes the deleted id; the UI drops the row locally.
export interface DeleteResult {
  deleted: string;
}

// Per-key usage rollup for the list "Usage" column (GET /admin/api/keys/usage).
// One row per key that saw traffic in the window; the list merges it by key_id (a
// key absent here saw zero traffic). `cost_usd` null = "not measured" (distinct
// from a measured 0), mirroring the requests list cost convention. No key material.
export interface KeyUsage {
  key_id: string;
  requests: number;
  error_count: number;
  cost_usd: number | null;
  total_tokens: number;
}

// Half-open window for the usage rollup; both bounds optional (the API Keys page
// sends local-midnight start for "today"; the backend falls back to today, then
// now, and fails open on junk).
export interface KeyUsageWindow {
  start?: number; // epoch ms (inclusive)
  end?: number; // epoch ms (exclusive)
}

const BASE = '/admin/api/keys';
export const FULL_KEY_UNAVAILABLE_MESSAGE =
  'This key was created before full-key recovery was enabled. Helm only stored a hash, so the old full value cannot be reconstructed.';

export class FullKeyUnavailableError extends Error {
  constructor() {
    super(FULL_KEY_UNAVAILABLE_MESSAGE);
    this.name = 'FullKeyUnavailableError';
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`keys api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// Re-project the server row to the redacted view, dropping any field that could
// leak a secret even if the server response ever changed shape (defence in depth).
function normalizeView(raw: Record<string, unknown>): ApiKeyView {
  const allowed = raw.allowed_lanes;
  const blocked = raw.blocked_models;
  return {
    key_id: String(raw.key_id ?? ''),
    prefix: String(raw.prefix ?? ''),
    role: raw.role === 'root' ? 'root' : 'user',
    // null/absent/blank = unnamed; trim so a whitespace-only value never renders as
    // an apparently-empty name cell (defence in depth — the server already trims).
    name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : null,
    allowed_lanes: Array.isArray(allowed) ? allowed.map(String) : null,
    allow_custom_model: raw.allow_custom_model === true,
    blocked_models: Array.isArray(blocked) ? blocked.map(String) : null,
    allow_fast_mode: raw.allow_fast_mode === true,
    disabled: raw.disabled === true,
    // null/absent = inherit system default; a finite number (incl. 0) = override.
    rate_limit_rpm: typeof raw.rate_limit_rpm === 'number' ? raw.rate_limit_rpm : null,
    rate_limit_tpm: typeof raw.rate_limit_tpm === 'number' ? raw.rate_limit_tpm : null,
    // null/absent = no cap for that dimension; a finite number = the ceiling.
    budget_requests: typeof raw.budget_requests === 'number' ? raw.budget_requests : null,
    budget_tokens: typeof raw.budget_tokens === 'number' ? raw.budget_tokens : null,
    budget_spend_usd: typeof raw.budget_spend_usd === 'number' ? raw.budget_spend_usd : null,
    budget_window_seconds:
      typeof raw.budget_window_seconds === 'number' ? raw.budget_window_seconds : null,
    over_budget_behavior: raw.over_budget_behavior === 'reject' ? 'reject' : 'degrade',
    degrade_lane: typeof raw.degrade_lane === 'string' ? raw.degrade_lane : null,
    concurrency_limit: typeof raw.concurrency_limit === 'number' ? raw.concurrency_limit : null,
    memory_mode:
      raw.memory_mode === 'inject' ? 'inject' : raw.memory_mode === 'observe' ? 'observe' : 'off',
    memory_project_id: typeof raw.memory_project_id === 'string' ? raw.memory_project_id : null,
    memory_thread_source: raw.memory_thread_source === 'auto' ? 'auto' : 'header',
  };
}

// Send only the caps the operator set. The server CreateKeyRequestSchema is
// `.strict()`, so empty/undefined optional fields must be omitted (Principle 2 fail-closed).
function toServerBody(input: CreateKeyInput): Record<string, unknown> {
  const out: Record<string, unknown> = { role: input.role ?? 'user' };
  // Send a name only when the operator typed one (omitted => unnamed; .strict()).
  if (input.name !== undefined && input.name.length > 0) out.name = input.name;
  if (input.allowed_lanes && input.allowed_lanes.length > 0) {
    out.allowed_lanes = input.allowed_lanes;
  }
  if (input.allow_custom_model !== undefined) {
    out.allow_custom_model = input.allow_custom_model;
  }
  if (input.blocked_models && input.blocked_models.length > 0) {
    out.blocked_models = input.blocked_models;
  }
  if (input.allow_fast_mode !== undefined) {
    out.allow_fast_mode = input.allow_fast_mode;
  }
  // Send rate limits only when set (0 is meaningful = unlimited, so check undefined).
  if (input.rate_limit_rpm !== undefined) out.rate_limit_rpm = input.rate_limit_rpm;
  if (input.rate_limit_tpm !== undefined) out.rate_limit_tpm = input.rate_limit_tpm;
  // Send budgets only when set (omitted = no cap; server schema is .strict()).
  if (input.budget_requests !== undefined) out.budget_requests = input.budget_requests;
  if (input.budget_tokens !== undefined) out.budget_tokens = input.budget_tokens;
  if (input.budget_spend_usd !== undefined) out.budget_spend_usd = input.budget_spend_usd;
  if (input.budget_window_seconds !== undefined) {
    out.budget_window_seconds = input.budget_window_seconds;
  }
  if (input.over_budget_behavior !== undefined) {
    out.over_budget_behavior = input.over_budget_behavior;
  }
  if (input.degrade_lane !== undefined && input.degrade_lane.length > 0) {
    out.degrade_lane = input.degrade_lane;
  }
  // Send only when set (omitted = unlimited; server schema is .strict()).
  if (input.concurrency_limit !== undefined) out.concurrency_limit = input.concurrency_limit;
  // Memory defaults (issue #97): send only when set (omitted = off; .strict()).
  if (input.memory_mode !== undefined) out.memory_mode = input.memory_mode;
  if (input.memory_project_id !== undefined && input.memory_project_id.length > 0) {
    out.memory_project_id = input.memory_project_id;
  }
  if (input.memory_thread_source !== undefined) {
    out.memory_thread_source = input.memory_thread_source;
  }
  return out;
}

// Defensively coerce a server usage row to the UI shape — counts to finite numbers
// (junk → 0), cost to number-or-null ("not measured" preserved, never faked to 0).
function normalizeUsage(raw: Record<string, unknown>): KeyUsage {
  const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    key_id: String(raw.key_id ?? ''),
    requests: numOr0(raw.requests),
    error_count: numOr0(raw.error_count),
    cost_usd:
      typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd) ? raw.cost_usd : null,
    total_tokens: numOr0(raw.total_tokens),
  };
}

// GET /admin/api/keys -> redacted ApiKeyView[] (prefix only).
export async function listKeys(): Promise<ApiKeyView[]> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const rows = await asJson<Record<string, unknown>[]>(res);
  return rows.map(normalizeView);
}

// GET /admin/api/keys/:id -> the single redacted key record (prefix only), or null
// when the key genuinely does not exist (404). A 404 is the ONLY "not found"
// signal — every OTHER non-2xx (500/503, network) THROWS via asJson so the caller
// can surface a real load error instead of masking an outage as "key not found".
export async function getKey(keyId: string): Promise<ApiKeyView | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return null;
  const raw = await asJson<Record<string, unknown>>(res);
  return normalizeView(raw);
}

// GET /admin/api/keys/usage?start&end -> per-key usage rollup for the list column.
// The window is resolved client-side (the list defaults to today); the backend
// fills its own today default when omitted and fails open on a bad window.
export async function getKeysUsage(window: KeyUsageWindow = {}): Promise<KeyUsage[]> {
  const qs = new URLSearchParams();
  if (window.start !== undefined) qs.set('start', String(window.start));
  if (window.end !== undefined) qs.set('end', String(window.end));
  const url = qs.toString() ? `${BASE}/usage?${qs}` : `${BASE}/usage`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const rows = await asJson<Record<string, unknown>[]>(res);
  return rows.map(normalizeUsage);
}

// POST /admin/api/keys -> { key_id, plaintext, prefix, recoverable }.
export async function createKey(input: CreateKeyInput): Promise<CreatedKey> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toServerBody(input)),
  });
  return asJson<CreatedKey>(res);
}

// GET /admin/api/keys/:id/secret -> reveal the stored full key. Throws when the
// row is hash-only/unrecoverable or the server has no encryption key configured.
export async function revealKey(keyId: string): Promise<RevealedKey> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}/secret`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 409) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    const serverError =
      body && typeof body === 'object' && 'error' in body ? String(body.error) : '';
    if (serverError.includes('full key is not available')) {
      throw new FullKeyUnavailableError();
    }
  }
  return asJson<RevealedKey>(res);
}

// POST /admin/api/keys/:id/rotate -> rotate the secret in-place for the same
// key_id. The response carries the new plaintext so the operator can copy it.
export async function rotateKey(keyId: string): Promise<CreatedKey> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}/rotate`, { method: 'POST' });
  return asJson<CreatedKey>(res);
}

// PATCH /admin/api/keys/:id -> edit a key's caps. The body is forwarded as-is: the
// server schema is `.strict()` + PARTIAL, so only the fields PRESENT are written
// (null clears a cap; a number/array/boolean sets it). The Edit dialog sends the
// whole editable set each call (explicit null for cleared) — overwrite intent.
export async function updateKey(keyId: string, patch: UpdateKeyInput): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await asJson<unknown>(res);
}

// DELETE /admin/api/keys/:id -> { revoked: id } (soft disable; row is kept).
export async function revokeKey(keyId: string): Promise<RevokeResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  return asJson<RevokeResult>(res);
}

// DELETE /admin/api/keys/:id?purge=true -> { deleted: id }. PERMANENTLY removes an
// already-revoked key (the server rejects an active one with 409). Call only on a
// row that is already disabled; the caller drops the row from the list on success.
export async function deleteKey(keyId: string): Promise<DeleteResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}?purge=true`, { method: 'DELETE' });
  return asJson<DeleteResult>(res);
}
