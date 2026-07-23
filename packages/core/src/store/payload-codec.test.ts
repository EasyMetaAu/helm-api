import { describe, expect, it } from "vitest";
import { decodePayloadValue, encodePayloadText } from "./payload-codec.js";

describe("payload-codec", () => {
  it("gzip round-trips arbitrary unicode text", () => {
    const text = JSON.stringify({ msg: "héllo 世界 🌍", arr: [1, 2, 3] });
    expect(decodePayloadValue(encodePayloadText(text))).toBe(text);
  });

  it("actually shrinks repetitive transcript text", () => {
    const text = "the quick brown fox ".repeat(2000);
    expect(encodePayloadText(text).length).toBeLessThan(text.length / 5);
  });

  it("reads legacy TEXT rows verbatim (no gzip)", () => {
    const legacy = '{"verbatim":"old row"}';
    expect(decodePayloadValue(legacy)).toBe(legacy);
  });

  it("null/undefined → null", () => {
    expect(decodePayloadValue(null)).toBeNull();
    expect(decodePayloadValue(undefined)).toBeNull();
  });

  it("non-gzip buffer is read as utf8 (defensive)", () => {
    expect(decodePayloadValue(Buffer.from("raw", "utf8"))).toBe("raw");
  });

  it("treats a truncated gzip BLOB as unavailable instead of throwing", () => {
    expect(decodePayloadValue(Buffer.from([0x1f, 0x8b, 0x08]))).toBeNull();
  });
});
