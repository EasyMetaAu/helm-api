import { describe, expect, it } from "vitest";
import {
  decodePayloadTextChunks,
  decodePayloadValue,
  encodePayloadText,
  encodePayloadTextChunks,
  PAYLOAD_TEXT_CHUNK_RAW_BYTES,
} from "./payload-codec.js";

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

  it("splits at the raw-byte boundary and round-trips unicode across chunks", () => {
    const text = `${"a".repeat(PAYLOAD_TEXT_CHUNK_RAW_BYTES - 1)}🌍世界`;
    const chunks = encodePayloadTextChunks(text);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(chunks[0]?.rawBytes).toBe(PAYLOAD_TEXT_CHUNK_RAW_BYTES - 1);
    expect(chunks[1]?.rawBytes).toBe(Buffer.byteLength("🌍世界", "utf8"));
    expect(chunks.every((chunk) => chunk.rawBytes <= PAYLOAD_TEXT_CHUNK_RAW_BYTES)).toBe(true);
    expect(chunks.every((chunk) => chunk.bytes.length <= chunk.rawBytes)).toBe(true);
    expect(decodePayloadTextChunks(chunks)).toBe(text);
  });

  it("stores an empty string as one valid zero-byte chunk", () => {
    const chunks = encodePayloadTextChunks("");
    expect(chunks).toEqual([expect.objectContaining({ chunkIndex: 0, codec: "raw", rawBytes: 0 })]);
    expect(chunks[0]?.bytes).toHaveLength(0);
    expect(decodePayloadTextChunks(chunks)).toBe("");
  });

  it("rejects missing, duplicate, reordered, oversized, and corrupt chunks", () => {
    const [first, second] = encodePayloadTextChunks(
      `${"x".repeat(PAYLOAD_TEXT_CHUNK_RAW_BYTES)}tail`,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("expected two chunks");

    expect(decodePayloadTextChunks([second])).toBeNull();
    expect(decodePayloadTextChunks([first, first])).toBeNull();
    expect(decodePayloadTextChunks([second, first])).toBeNull();
    expect(
      decodePayloadTextChunks([{ ...first, rawBytes: PAYLOAD_TEXT_CHUNK_RAW_BYTES + 1 }]),
    ).toBeNull();
    expect(
      decodePayloadTextChunks([{ ...first, bytes: Buffer.from([0x1f, 0x8b, 0x08]) }]),
    ).toBeNull();
    expect(decodePayloadTextChunks([{ ...first, rawBytes: first.rawBytes - 1 }])).toBeNull();
  });
});
