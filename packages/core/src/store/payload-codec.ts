import { gunzipSync, gzipSync } from "node:zlib";

// On-disk encoding for captured payload columns. After images are externalized
// (payload-blobs.ts) the remainder is conversation TEXT — Claude Code re-sends the
// whole transcript every turn, so it's large and highly compressible (~5-10x).
// We gzip it and store the bytes as a BLOB in the (text-affinity) payload column.
//
// Backward compatibility is by VALUE TYPE / MAGIC BYTES, not a schema column:
//   - legacy rows: the column holds a TEXT string  → returned as-is
//   - new rows:    the column holds gzip BLOB bytes → gunzipped
// so old uncompressed rows keep reading correctly with zero migration.

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
export const PAYLOAD_TEXT_CHUNK_RAW_BYTES = 256 * 1024;

export interface PayloadTextChunk {
  chunkIndex: number;
  codec: "gzip" | "raw";
  rawBytes: number;
  bytes: Buffer;
}

export function encodePayloadText(text: string): Buffer {
  return gzipSync(Buffer.from(text, "utf8"));
}

// Decode a raw DB column value (better-sqlite3 returns string for TEXT, Buffer for
// BLOB; pg returns Buffer for bytea). Null-safe.
export function decodePayloadValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value; // legacy uncompressed row
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1) {
    try {
      return gunzipSync(buf).toString("utf8");
    } catch {
      return null;
    }
  }
  return buf.toString("utf8"); // defensive: raw bytes stored without gzip
}

export function* iteratePayloadTextChunks(text: string): Generator<PayloadTextChunk> {
  const encoder = new TextEncoder();
  const rawBuffer = new Uint8Array(PAYLOAD_TEXT_CHUNK_RAW_BYTES);
  let charOffset = 0;
  let chunkIndex = 0;
  do {
    let windowEnd = Math.min(text.length, charOffset + PAYLOAD_TEXT_CHUNK_RAW_BYTES);
    const lastCodeUnit = text.charCodeAt(windowEnd - 1);
    const nextCodeUnit = text.charCodeAt(windowEnd);
    if (
      windowEnd < text.length &&
      lastCodeUnit >= 0xd800 &&
      lastCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      windowEnd += 1;
    }
    const window = text.slice(charOffset, windowEnd);
    const { read, written } = encoder.encodeInto(window, rawBuffer);
    if (text.length > 0 && read === 0) throw new Error("unable to encode payload text chunk");
    const raw = Buffer.from(rawBuffer.subarray(0, written));
    const compressed = gzipSync(raw);
    yield compressed.length < raw.length
      ? { chunkIndex, codec: "gzip", rawBytes: raw.length, bytes: compressed }
      : { chunkIndex, codec: "raw", rawBytes: raw.length, bytes: raw };
    charOffset += read;
    chunkIndex += 1;
  } while (charOffset < text.length);
}

export function encodePayloadTextChunks(text: string): PayloadTextChunk[] {
  return [...iteratePayloadTextChunks(text)];
}

export function decodePayloadTextChunks(
  chunks: readonly Pick<PayloadTextChunk, "chunkIndex" | "codec" | "rawBytes" | "bytes">[],
): string | null {
  if (chunks.length === 0) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decoded: string[] = [];
  try {
    for (const [index, chunk] of chunks.entries()) {
      if (
        chunk.chunkIndex !== index ||
        !Number.isSafeInteger(chunk.rawBytes) ||
        chunk.rawBytes < 0 ||
        chunk.rawBytes > PAYLOAD_TEXT_CHUNK_RAW_BYTES ||
        (chunk.codec !== "gzip" && chunk.codec !== "raw") ||
        chunk.bytes.length > chunk.rawBytes
      ) {
        return null;
      }
      const raw =
        chunk.codec === "gzip"
          ? gunzipSync(chunk.bytes, { maxOutputLength: PAYLOAD_TEXT_CHUNK_RAW_BYTES + 1 })
          : Buffer.from(chunk.bytes);
      if (raw.length !== chunk.rawBytes) return null;
      decoded.push(decoder.decode(raw, { stream: index < chunks.length - 1 }));
    }
    return decoded.join("");
  } catch {
    return null;
  }
}
