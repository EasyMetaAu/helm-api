import { describe, expect, it } from "vitest";
import { sha256Hex } from "./message-hash.js";

describe("sha256Hex (memory message dedup fingerprint)", () => {
  it("is deterministic for identical input", () => {
    expect(sha256Hex("hello world")).toBe(sha256Hex("hello world"));
  });

  it("returns a 64-char lowercase hex string", () => {
    const h = sha256Hex("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known sha256 vector for an empty string", () => {
    // Guards against accidental normalization/encoding drift.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is CASE-sensitive (must NOT normalize like fact hashing)", () => {
    expect(sha256Hex("Hello")).not.toBe(sha256Hex("hello"));
  });

  it("is WHITESPACE-sensitive (verbatim content, no collapse/trim)", () => {
    expect(sha256Hex("a  b")).not.toBe(sha256Hex("a b"));
    expect(sha256Hex(" a")).not.toBe(sha256Hex("a"));
  });

  it("distinguishes different content", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
