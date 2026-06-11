import { createHash } from "node:crypto";

// Dedup fingerprint for raw memory messages (the idempotency key behind the
// memory_messages UNIQUE(thread_id, role, content_hash) constraint). The client
// re-sends the FULL transcript every turn; without an idempotency key the store
// blind-inserts the whole history each time (O(n²) row growth — the re-ingestion
// bug). Hashing content lets the write path collapse a re-sent message to a
// no-op via ON CONFLICT DO NOTHING.
//
// DELIBERATELY VERBATIM — unlike forgetting/facts.ts `normalizeFactText`, this
// does NOT lowercase or collapse whitespace. Memory messages are exact text /
// serialized JSON / code; two turns differing only in whitespace or case are
// genuinely different messages and must NOT collide. Mirrors the eval-cache-key
// convention (stable key, no lowercasing). Hex sha256 of the exact UTF-8 bytes.
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
