import { createHash, randomBytes } from "node:crypto";

// API key generation + hashing utilities. Pure, framework-agnostic, no I/O, no
// logging. Per CLAUDE.md principle 7: keys are stored as sha256 hash only; the
// plaintext is returned to the caller for one-time display and never persisted
// or logged. hashKey is the SAME function the auth middleware uses to resolve an
// inbound header key back to a stored hash — they must agree exactly.

export const KEY_PREFIX = "helm_live_" as const;

// Number of random bytes; base64url of 24 bytes => 32 chars (>= 32 required).
const RANDOM_BYTES = 24;
// How many chars of the random segment to surface in the display prefix.
const PREFIX_RANDOM_CHARS = 4;

export interface GeneratedKey {
  plaintext: string; // returned for one-time display ONLY — never stored/logged
  hash: string; // sha256(plaintext) hex — the stored value
  prefix: string; // display/debug only, e.g. helm_live_ab12 — not reversible
}

// Hash a plaintext key to a hex string. Deterministic. Does NOT trim or
// lowercase — keys are case-sensitive and must hash byte-for-byte as received.
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

// Extract a redacted display prefix: the fixed prefix plus a few chars of the
// random segment. Not enough to reconstruct the full key.
export function extractPrefix(plaintext: string): string {
  const random = plaintext.startsWith(KEY_PREFIX) ? plaintext.slice(KEY_PREFIX.length) : plaintext;
  return KEY_PREFIX + random.slice(0, PREFIX_RANDOM_CHARS);
}

// Generate a new key: high-entropy random (crypto, never Math.random).
export function generateKey(): GeneratedKey {
  const random = randomBytes(RANDOM_BYTES).toString("base64url");
  const plaintext = `${KEY_PREFIX}${random}`;
  return {
    plaintext,
    hash: hashKey(plaintext),
    prefix: extractPrefix(plaintext),
  };
}
