import { createHash } from "node:crypto";

// Dedup fingerprint for raw memory messages. The full idempotency key is
// (thread_id, message_index, role, content_hash): message_index keeps legitimate
// repeated text at later transcript positions, while content_hash keeps the index
// compact and safe for Postgres btree limits. The client re-sends the FULL
// transcript every turn; without this key the store blind-inserts the whole
// history each time (O(n²) row growth — the re-ingestion bug).
//
// DELIBERATELY VERBATIM — unlike forgetting/facts.ts `normalizeFactText`, this
// does NOT lowercase or collapse whitespace. Memory messages are exact text /
// serialized JSON / code; two turns differing only in whitespace or case are
// genuinely different messages and must NOT collide. Mirrors the eval-cache-key
// convention (stable key, no lowercasing). Hex sha256 of the exact UTF-8 bytes.
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
