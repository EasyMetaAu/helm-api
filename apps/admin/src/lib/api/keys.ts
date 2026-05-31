// Admin API key client. The admin UI is a pure consumer of the gateway's
// /admin/api/* HTTP surface — it imports NO core/gateway business logic and owns
// NO auth logic (CLAUDE.md 原则1). The backend (apps/gateway admin/keys.ts) is the
// single source of truth and enforces CLAUDE.md 原则7 / docs/06:
//   - keys are stored as sha256 hash + display prefix ONLY; the list view
//     projects to a redacted KeySummary (prefix only — NEVER hash full-text or
//     plaintext);
//   - the plaintext is minted server-side and returned EXACTLY ONCE in the POST
//     response, never persisted or echoed again;
//   - revocation is a soft DELETE (disabled:true), never a physical delete or
//     in-place rewrite (轮转/吊销语义).
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
}

// Operator-specified caps for a new key. The plaintext is minted server-side; the
// operator only chooses role + per-key caps. role defaults to "user" — root keys
// are not minted casually (docs/06).
export interface CreateKeyInput {
  role?: 'root' | 'user';
  max_lane?: string;
  allowed_lanes?: string[];
  allow_custom_model?: boolean;
}

// The ONLY shape that ever carries plaintext, returned once by POST.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
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
  };
}

// Send only the caps the operator set. The server CreateKeyRequestSchema is
// `.strict()`, so empty/undefined optional fields must be omitted (原则2 fail-closed).
function toServerBody(input: CreateKeyInput): Record<string, unknown> {
  const out: Record<string, unknown> = { role: input.role ?? 'user' };
  if (input.max_lane) out.max_lane = input.max_lane;
  if (input.allowed_lanes && input.allowed_lanes.length > 0) {
    out.allowed_lanes = input.allowed_lanes;
  }
  if (input.allow_custom_model !== undefined) {
    out.allow_custom_model = input.allow_custom_model;
  }
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

// DELETE /admin/api/keys/:id -> { revoked: id } (soft disable; row is kept).
export async function revokeKey(keyId: string): Promise<RevokeResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  return asJson<RevokeResult>(res);
}
