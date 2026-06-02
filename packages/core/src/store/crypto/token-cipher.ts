// Encryption-at-rest for OAuth secrets (packages/core, principle 1 — framework
// agnostic). UNLIKE API keys (which Helm stores sha256-only, principle 7), an
// OAuth refresh/access token MUST be stored REVERSIBLY because it is replayed to
// the upstream token endpoint. This is a new secret class, so it is encrypted at
// rest with AES-256-GCM under an operator-supplied key (env HELM_OAUTH_ENC_KEY,
// resolved at the composition root — this module only ever receives the already
// decoded key Buffer, never the env name).
//
// Blob format: "v1:" + base64(iv(12) | ciphertext | authTag(16)). The "v1:" prefix
// reserves room for an algorithm/key-rotation change without a data migration.
// The GCM auth tag makes a wrong key (or a tampered blob) fail loudly on decrypt,
// never silently return garbage.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16; // GCM auth tag length
const KEY_LEN = 32; // AES-256

// Encrypt a plaintext secret. `key` MUST be 32 bytes (enforced by loadEncKeyFromEnv).
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, ct, tag]).toString("base64")}`;
}

// Decrypt a blob produced by encryptSecret. Throws on an unknown version prefix,
// a malformed blob, or a failed auth tag (wrong key / tampering).
export function decryptSecret(blob: string, key: Buffer): string {
  const sep = blob.indexOf(":");
  if (sep === -1 || blob.slice(0, sep) !== VERSION) {
    throw new Error("token-cipher: unrecognized blob (expected v1: prefix)");
  }
  const raw = Buffer.from(blob.slice(sep + 1), "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("token-cipher: blob too short");
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Resolve the at-rest encryption key from the environment (composition root only).
// Returns null when HELM_OAUTH_ENC_KEY is UNSET — the caller decides whether the
// key is required (fail-closed only when a subscription OAuth provider is
// configured). Accepts the key as 64 hex chars OR base64; a value that is PRESENT
// but does not decode to exactly 32 bytes is an operator error and THROWS (never
// silently runs with a weak/short key).
export function loadEncKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.HELM_OAUTH_ENC_KEY;
  if (raw === undefined || raw === "") return null;
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== KEY_LEN) {
    throw new Error(
      `HELM_OAUTH_ENC_KEY must decode to ${KEY_LEN} bytes (got ${decoded.length}); supply 32 bytes as base64 or 64 hex chars`,
    );
  }
  return decoded;
}
