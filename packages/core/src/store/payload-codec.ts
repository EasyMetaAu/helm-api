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
