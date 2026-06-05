import { createHash } from "node:crypto";

// Redaction utilities. The LAST gate before anything is persisted or logged:
// plaintext API keys / credentials become irreversible sha256 fingerprints, and
// private payloads (messages/attachments/...) become summaries. Non-sensitive
// fields (trace_id, latency, cost, status, ...) pass through verbatim. Pure
// (never mutates input), framework-agnostic. See CLAUDE.md principle 7, docs/07.

const DEFAULT_KEY_PREFIX_LEN = 12;
const DEFAULT_PAYLOAD_KEYS = ["messages", "attachments", "prompt", "content", "input"];
const DEFAULT_SECRET_PATTERN = /(api[_-]?key|authorization|password|secret|token|credential)/i;

export interface RedactOptions {
  keyPrefixLen?: number;
  payloadKeys?: string[];
  secretKeyPattern?: RegExp;
}

// API key -> irreversible fingerprint: "sha256:<prefix hex>". Reconcilable with
// the keystore hash (same algorithm) but not reversible to plaintext.
export function redactKey(
  plaintextKey: string,
  prefixLen: number = DEFAULT_KEY_PREFIX_LEN,
): string {
  const full = createHash("sha256").update(plaintextKey, "utf8").digest("hex");
  return `sha256:${full.slice(0, prefixLen)}`;
}

interface ResolvedOptions {
  keyPrefixLen: number;
  payloadKeys: Set<string>;
  secretKeyPattern: RegExp;
}

function summarizePayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { redacted: true, kind: "array", itemCount: value.length };
  }
  if (typeof value === "string") {
    return { redacted: true, kind: "string", length: value.length };
  }
  if (value && typeof value === "object") {
    return { redacted: true, kind: "object", itemCount: Object.keys(value).length };
  }
  return { redacted: true, kind: typeof value };
}

function redactNode(value: unknown, opts: ResolvedOptions, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return undefined; // break cycles safely
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, opts, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (opts.secretKeyPattern.test(key)) {
      // Strings under a secret-matching key are fingerprinted; objects/arrays are
      // summarized (they could hold credentials). SCALARS pass through: a number,
      // boolean, null or undefined can never carry key material, and summarizing
      // them corrupts legitimate counters — `memory_tokens_injected` (a token
      // COUNT, matches "token") was persisted as {redacted:true,kind:"number"},
      // breaking the DecisionRecord schema on read and 502-ing the requests list
      // (docs/12 live-integration regression).
      if (typeof child === "string") {
        out[key] = redactKey(child, opts.keyPrefixLen);
      } else if (child !== null && typeof child === "object") {
        out[key] = summarizePayload(child);
      } else {
        out[key] = child; // number | boolean | null | undefined — not a credential
      }
    } else if (opts.payloadKeys.has(key)) {
      out[key] = summarizePayload(child);
    } else {
      out[key] = redactNode(child, opts, seen);
    }
  }
  return out;
}

// Deep-redact any value without mutating the input. Returns a new object.
export function redact<T>(value: T, opts: RedactOptions = {}): T {
  const resolved: ResolvedOptions = {
    keyPrefixLen: opts.keyPrefixLen ?? DEFAULT_KEY_PREFIX_LEN,
    payloadKeys: new Set(opts.payloadKeys ?? DEFAULT_PAYLOAD_KEYS),
    secretKeyPattern: opts.secretKeyPattern ?? DEFAULT_SECRET_PATTERN,
  };
  return redactNode(value, resolved, new WeakSet()) as T;
}
