import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPrefix, generateKey, hashKey, KEY_PREFIX } from "./keygen.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keygen", () => {
  it("generates a key with the helm_live_ prefix and a >=32 char random segment", () => {
    const { plaintext } = generateKey();
    expect(plaintext.startsWith(KEY_PREFIX)).toBe(true);
    const random = plaintext.slice(KEY_PREFIX.length);
    expect(random.length).toBeGreaterThanOrEqual(32);
  });

  it("hashKey is deterministic and equals sha256 hex of the input", () => {
    const p = "helm_live_example";
    expect(hashKey(p)).toBe(hashKey(p));
    const expected = createHash("sha256").update(p, "utf8").digest("hex");
    expect(hashKey(p)).toBe(expected);
  });

  it("generated hash equals hashKey(plaintext) (so middleware can resolve it)", () => {
    const k = generateKey();
    expect(k.hash).toBe(hashKey(k.plaintext));
  });

  it("extractPrefix is redacted: starts with prefix, far shorter than plaintext", () => {
    const { plaintext, prefix } = generateKey();
    expect(prefix.startsWith(KEY_PREFIX)).toBe(true);
    expect(prefix.length).toBeLessThan(plaintext.length);
    expect(prefix).not.toBe(plaintext);
    // does not contain the full random segment
    expect(plaintext.includes(prefix.slice(KEY_PREFIX.length))).toBe(true);
    expect(prefix.length).toBeLessThan(KEY_PREFIX.length + 8);
  });

  it("produces unique plaintext and hash across many generations (high entropy)", () => {
    const plains = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const k = generateKey();
      plains.add(k.plaintext);
      hashes.add(k.hash);
    }
    expect(plains.size).toBe(1000);
    expect(hashes.size).toBe(1000);
  });

  it("does not lowercase or trim the input when hashing", () => {
    expect(hashKey("ABC ")).not.toBe(hashKey("abc"));
    expect(hashKey(" abc")).not.toBe(hashKey("abc"));
  });

  it("never logs (no console output from this module)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    generateKey();
    hashKey("x");
    extractPrefix("helm_live_abcd");
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
