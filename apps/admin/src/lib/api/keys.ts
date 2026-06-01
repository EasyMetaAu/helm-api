// Admin API key client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic and owns
// NO auth logic (CLAUDE.md Principle 1). The backend (apps/gateway admin/keys.ts) is the
// single source of truth and enforces CLAUDE.md Principle 7 / docs/06:
//   - keys are stored as sha256 hash + display prefix ONLY; the list view
//     projects to a redacted KeySummary (prefix only — NEVER hash full-text or
//     plaintext);
//   - the plaintext is minted server-side and returned EXACTLY ONCE in the POST
//     response, never persisted or echoed again;
//   - revocation is a soft DELETE (disabled:true), never a physical delete or
//     in-place rewrite (rotation/revocation semantics).
// We define UI-facing types here rather than depend on @helm/core (admin must not
// import core); the role enum mirrors the server KeyRoleSchema (root | user).

// Redacted key view for list/detail. By construction this NEVER carries a hash
// full-text or plaintext — only the short display prefix.
export interface ApiKeyView {
  key_id: string;
  prefix: string; // e.g. helm_live_ab12 — display/debug only
  role: 'root' | 'user';
  max_lane: string | null; // cap lane
  allowed_lanes: string[] | null; // whitelist
  allow_custom_model: boolean; // explicit client-model passthrough
  disabled: boolean; // revoked state (soft)
  rate_limit_rpm: number | null; // per-key RPM override; null = inherit system default
  rate_limit_tpm: number | null; // per-key TPM override; null = inherit system default
}

// Operator-specified caps for a new key. The plaintext is minted server-side; the
// operator only chooses role + per-key caps. role defaults to "user" — root keys
// are not minted casually (docs/06).
export interface CreateKeyInput {
  role?: 'root' | 'user';
  max_lane?: string;
  allowed_lanes?: string[];
  allow_custom_model?: boolean;
  // Optional per-key rate limits at mint time. Omitted => inherit the system
  // default. 0 => explicitly unlimited for that dimension.
  rate_limit_rpm?: number;
  rate_limit_tpm?: number;
}

// Editable caps for an existing key (PATCH). Mirrors the server
// UpdateKeyRequestSchema: every field is OPTIONAL (omit = leave unchanged); the
// nullable ones accept null to CLEAR (max_lane / allowed_lanes → no cap; rate
// limit → inherit the system default). `role` and the immutable identity are
// deliberately absent — role cannot be edited (rotate by revoke + re-mint).
export interface UpdateKeyInput {
  max_lane?: string | null;
  allowed_lanes?: string[] | null;
  allow_custom_model?: boolean;
  rate_limit_rpm?: number | null;
  rate_limit_tpm?: number | null;
}

// The ONLY shape that ever carries plaintext, returned once by POST. `prefix` is
// the server-minted non-sensitive display prefix (same value stored + listed) —
// carried so the UI builds the redacted view from it instead of slicing plaintext.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
  prefix: string;
}

// DELETE response (soft revoke). The server echoes the revoked id; it does NOT
// return the record (the UI marks the row disabled locally).
export interface RevokeResult {
  revoked: string;
}

const BASE = '/admin/api/keys';

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
  return {
    key_id: String(raw.key_id ?? ''),
    prefix: String(raw.prefix ?? ''),
    role: raw.role === 'root' ? 'root' : 'user',
    max_lane: typeof raw.max_lane === 'string' ? raw.max_lane : null,
    allowed_lanes: Array.isArray(allowed) ? allowed.map(String) : null,
    allow_custom_model: raw.allow_custom_model === true,
    disabled: raw.disabled === true,
    // null/absent = inherit system default; a finite number (incl. 0) = override.
    rate_limit_rpm: typeof raw.rate_limit_rpm === 'number' ? raw.rate_limit_rpm : null,
    rate_limit_tpm: typeof raw.rate_limit_tpm === 'number' ? raw.rate_limit_tpm : null,
  };
}

// Send only the caps the operator set. The server CreateKeyRequestSchema is
// `.strict()`, so empty/undefined optional fields must be omitted (Principle 2 fail-closed).
function toServerBody(input: CreateKeyInput): Record<string, unknown> {
  const out: Record<string, unknown> = { role: input.role ?? 'user' };
  if (input.max_lane) out.max_lane = input.max_lane;
  if (input.allowed_lanes && input.allowed_lanes.length > 0) {
    out.allowed_lanes = input.allowed_lanes;
  }
  if (input.allow_custom_model !== undefined) {
    out.allow_custom_model = input.allow_custom_model;
  }
  // Send rate limits only when set (0 is meaningful = unlimited, so check undefined).
  if (input.rate_limit_rpm !== undefined) out.rate_limit_rpm = input.rate_limit_rpm;
  if (input.rate_limit_tpm !== undefined) out.rate_limit_tpm = input.rate_limit_tpm;
  return out;
}

// GET /admin/api/keys -> redacted ApiKeyView[] (prefix only).
export async function listKeys(): Promise<ApiKeyView[]> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const rows = await asJson<Record<string, unknown>[]>(res);
  return rows.map(normalizeView);
}

// POST /admin/api/keys -> { key_id, plaintext } (plaintext returned ONCE).
export async function createKey(input: CreateKeyInput): Promise<CreatedKey> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toServerBody(input)),
  });
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
