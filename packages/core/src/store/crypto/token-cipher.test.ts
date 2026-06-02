import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, loadEncKeyFromEnv } from "./token-cipher.js";

// A deterministic 32-byte key for tests (NOT a real key).
const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);

describe("token-cipher (AES-256-GCM at rest)", () => {
  it("round-trips a secret through encrypt -> decrypt", () => {
    const secret = "rtok-rotating-refresh-token-abc123";
    const blob = encryptSecret(secret, KEY);
    expect(decryptSecret(blob, KEY)).toBe(secret);
  });

  it("emits a versioned blob that is NOT the plaintext", () => {
    const secret = "sk-super-secret";
    const blob = encryptSecret(secret, KEY);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain(secret);
  });

  it("uses a fresh IV each call (same plaintext -> different ciphertext)", () => {
    const secret = "same-input";
    expect(encryptSecret(secret, KEY)).not.toBe(encryptSecret(secret, KEY));
  });

  it("fails to decrypt with the wrong key (GCM auth tag)", () => {
    const blob = encryptSecret("secret", KEY);
    expect(() => decryptSecret(blob, OTHER)).toThrow();
  });

  it("rejects a blob without the v1: prefix", () => {
    expect(() => decryptSecret("garbage", KEY)).toThrow();
  });

  it("round-trips empty + unicode payloads", () => {
    for (const s of ["", "日本語トークン", "a".repeat(4096)]) {
      expect(decryptSecret(encryptSecret(s, KEY), KEY)).toBe(s);
    }
  });
});

describe("loadEncKeyFromEnv", () => {
  it("returns null when HELM_OAUTH_ENC_KEY is unset", () => {
    expect(loadEncKeyFromEnv({})).toBeNull();
  });

  it("decodes a 64-char hex key to 32 bytes", () => {
    const hex = "ab".repeat(32); // 64 hex chars
    const key = loadEncKeyFromEnv({ HELM_OAUTH_ENC_KEY: hex });
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.length).toBe(32);
  });

  it("decodes a base64 32-byte key", () => {
    const b64 = Buffer.alloc(32, 3).toString("base64");
    const key = loadEncKeyFromEnv({ HELM_OAUTH_ENC_KEY: b64 });
    expect(key?.length).toBe(32);
  });

  it("throws when the key is present but not 32 bytes (operator error, fail-closed)", () => {
    expect(() => loadEncKeyFromEnv({ HELM_OAUTH_ENC_KEY: "too-short" })).toThrow();
  });

  it("a key loaded from env round-trips a secret", () => {
    const b64 = Buffer.alloc(32, 5).toString("base64");
    const key = loadEncKeyFromEnv({ HELM_OAUTH_ENC_KEY: b64 });
    if (!key) throw new Error("expected a key");
    expect(decryptSecret(encryptSecret("hello", key), key)).toBe("hello");
  });
});
