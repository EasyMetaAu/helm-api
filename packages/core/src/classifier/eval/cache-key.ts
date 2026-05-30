import { createHash } from "node:crypto";
import type { InternalRequest } from "@helm/shared";

// eval.cache-key — the canonical content-hash that keys the Layer-2 eval cache.
// PURE function (CLAUDE.md principle 4): zero I/O, no clock, no randomness; same
// input ⇒ same key. The cache is keyed by CONTENT, not conversation_id, because
// the gateway is stateless — same/similar requests across instances must still
// collapse onto the same key (docs/03-classification.md Layer 2, cache.key =
// content_hash).
//
// The hash covers EXACTLY the 5 inputs that influence classification, pinned in
// implementation-notes (2026-05-30):
//   1. last_user_message  — last user message, trim()ed, NOT lowercased
//   2. turn_count         — number of user-role messages (fixed 口径, see below)
//   3. tool_names         — tool names only (no schema), lexicographically sorted
//   4. response_format_json — whether response_format requests JSON
//   5. has_attachments    — whether an image/vision attachment is present
// Volatile fields (request/message/trace ids, timestamps, account/user/org id,
// model name, stream flag, conversation_id) are DELIBERATELY excluded — including
// them would give two logically identical requests different keys and drive the
// hit rate to 0. No lowercasing anywhere: case can change meaning, and folding it
// would create false cache hits.

// The classifier subset this module consumes. Callers pass a full
// `InternalRequest`; only these fields are read.
export type ClassifierInput = Pick<
  InternalRequest,
  "messages" | "tools" | "response_format" | "attachments"
>;

// Canonical normalized object. The key ORDER here is fixed and load-bearing:
// JSON.stringify serializes own-keys in insertion order, so constructing the
// object with this exact order (independent of the input's key order) yields a
// stable canonical string for logically identical requests.
export interface CanonicalEvalInput {
  last_user_message: string;
  turn_count: number;
  tool_names: string[];
  response_format_json: boolean;
  has_attachments: boolean;
}

/**
 * Project a request onto the canonical 5-field classifier input. Exported for
 * unit testing the field set / normalization directly. Robust to the MVP's open
 * message/tool/attachment shapes — never throws.
 */
export function toCanonicalInput(input: ClassifierInput): CanonicalEvalInput {
  // Fixed key order — do NOT reorder; it defines the canonical JSON.
  return {
    last_user_message: lastUserMessage(input.messages),
    turn_count: userTurnCount(input.messages),
    tool_names: extractToolNames(input.tools).sort(),
    response_format_json: isJsonResponseFormat(input.response_format),
    has_attachments: hasImageAttachment(input.attachments),
  };
}

/**
 * Content-hash cache key: sha256 of the canonical JSON, hex-encoded. Stable for
 * logically identical requests; sensitive to any of the 5 classification inputs.
 */
export function buildEvalCacheKey(input: ClassifierInput): string {
  const canonical = toCanonicalInput(input);
  // Keys are already in fixed insertion order — JSON.stringify preserves it.
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

// ── extraction helpers (defensive against open MVP shapes) ──────────────────

// Last user-role message, content flattened to a string and trimmed. NOT
// lowercased. Returns "" when there is no user message.
function lastUserMessage(messages: ClassifierInput["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user") {
      return contentToString(msg.content).trim();
    }
  }
  return "";
}

// turn_count 口径 (fixed): number of role==="user" messages. This is the
// classification-relevant turn measure; documented here so eval.cascade and any
// future consumer use the SAME counting rule and the key never drifts.
function userTurnCount(messages: ClassifierInput["messages"]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg && msg.role === "user") count += 1;
  }
  return count;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }
  return "";
}

// Tool name lives at tools[].function.name (OpenAI shape) or tools[].name
// (Anthropic shape). Names ONLY — schema bodies are deliberately not hashed
// (signature-level identity is enough and schema text is volatile). Malformed
// entries are skipped, never thrown.
function extractToolNames(tools: ClassifierInput["tools"]): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = tool.function;
    if (isRecord(fn) && typeof fn.name === "string") {
      names.push(fn.name);
    } else if (typeof tool.name === "string") {
      names.push(tool.name);
    }
  }
  return names;
}

function isJsonResponseFormat(rf: ClassifierInput["response_format"]): boolean {
  if (!isRecord(rf)) return false;
  const t = rf.type;
  return typeof t === "string" && (t === "json_object" || t === "json_schema");
}

function hasImageAttachment(attachments: ClassifierInput["attachments"]): boolean {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  for (const att of attachments) {
    if (!isRecord(att)) return true; // bare/unknown attachment → treat as visual
    const t = att.type;
    if (typeof t !== "string") return true;
    if (t === "image" || t === "image_url" || t.startsWith("image")) return true;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
