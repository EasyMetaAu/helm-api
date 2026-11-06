import { createHash } from "node:crypto";

// Codex logical identity derives from the account label and encryption key.
// Anthropic uses its own persisted profile keyed by verified account UUID.

function digest(label: string, providerId: string, account: string, salt: Buffer): Buffer {
  return createHash("sha256").update(salt).update(`${label}:${providerId}:${account}`).digest();
}

// Seed the persisted Anthropic profile with the gateway's previous device value.
// Once persisted, this derivation no longer controls that account's device.
export function legacyAnthropicDeviceId(account: string, encKey: Buffer): string {
  return digest("device", "anthropic", account, encKey).toString("hex");
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

// Codex (OpenAI Responses) `session_id` / `prompt_cache_key`: a stable per-account
// UUID so a ChatGPT account's prompt cache is coherent and the session id never churns.
export function stableSessionId(providerId: string, account: string, encKey: Buffer): string {
  return uuidFrom(digest("codex-session", providerId, account, encKey));
}

// Codex `x-codex-installation-id` (header + `client_metadata` + the `x-codex-turn-metadata`
// JSON): the CLI's id is MACHINE-wide, so every ChatGPT account served from one install
// shares it. Bind one per account instead — same never-rotating derivation, distinct label.
export function stableInstallationId(providerId: string, account: string, encKey: Buffer): string {
  return uuidFrom(digest("codex-installation", providerId, account, encKey));
}
