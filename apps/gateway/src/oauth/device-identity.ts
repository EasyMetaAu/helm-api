import { createHash } from "node:crypto";

// Stable per-account device identity for subscription anti-ban (issue #38,
// ref claude-relay-service). The cardinal rule the operator called out: the Device ID
// must NEVER rotate — one request must not use one id and the next another. So every
// id here is a PURE, DETERMINISTIC function of (providerId, account) salted by the
// deployment's OAuth at-rest key:
//   • STABLE across requests AND process restarts (no rotation — the core requirement),
//   • UNIQUE per account (improves on CRS's single global-constant device_id),
//   • not guessable (salted by the encryption key), and needs NO DB write-back.
// CRS's weakness was a per-request random session_id; here the session id is stable
// per account too, so the whole identity is fixed for an account's lifetime.

function digest(label: string, providerId: string, account: string, salt: Buffer): Buffer {
  return createHash("sha256").update(salt).update(`${label}:${providerId}:${account}`).digest();
}

// Format the first 16 bytes of a digest as an RFC-4122 v4-shaped UUID (deterministic).
// Some upstreams validate session ids as UUIDs, so we emit that shape rather than raw hex.
function uuidFrom(buf: Buffer): string {
  const b = Buffer.from(buf.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10x
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Anthropic `metadata.user_id` — the opaque ≤256-char string the official Claude Code
// client sends to identify its device/session. Shape mirrors CRS:
// {device_id, account_uuid, session_id}, both ids stable per account.
export function anthropicMetadataUserId(
  providerId: string,
  account: string,
  encKey: Buffer,
): string {
  const device_id = digest("device", providerId, account, encKey).toString("hex");
  const session_id = uuidFrom(digest("session", providerId, account, encKey));
  return JSON.stringify({ device_id, account_uuid: "", session_id });
}

// Codex (OpenAI Responses) `session_id` / `prompt_cache_key`: a stable per-account
// UUID so a ChatGPT account's prompt cache is coherent and the session id never churns.
export function stableSessionId(providerId: string, account: string, encKey: Buffer): string {
  return uuidFrom(digest("codex-session", providerId, account, encKey));
}
