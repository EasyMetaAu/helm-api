import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { detectCodeBlock, detectStackTrace } from "./signals.js";
import type { Complexity } from "./tiers.js";

// Layer-1 hard overrides & shortcuts — the deterministic signals that BYPASS the
// weighted dimension score and pin (or floor) a tier directly. Per the Manifest
// "hard overrides & shortcuts": heartbeat → simple, formal logic → reasoning, tools → ≥standard,
// long context → ≥complex, very-short-no-signal → simple. Keywords/thresholds/
// floor tiers are DATA (classifier.yaml.overrides); matching and the tier-order
// control flow are CODE here (CLAUDE.md principle 4 — a pure, network-free,
// deterministic function: same input => same output, zero I/O). The `approxTokens`
// estimate is INJECTED by the engine; this function never encodes/tokenizes.
// See docs/03-classification.md §Layer-1 and docs/research-notes.md (Manifest).

export type OverrideKind = "set" | "floor";

export interface OverrideHit {
  /** "heartbeat" | "formal_logic" | "tools_floor" | "long_context" | "short_message" */
  rule: string;
  kind: OverrideKind;
  complexity: Complexity;
}

// Total tier order. `floor` may only raise toward a higher index, never lower.
// RANK is derived from ORDER so the sequence is the single source of truth.
const ORDER: Complexity[] = ["simple", "standard", "complex", "reasoning"];
const RANK: Record<Complexity, number> = Object.fromEntries(
  ORDER.map((tier, i) => [tier, i]),
) as Record<Complexity, number>;

type OverrideInput = Pick<InternalRequest, "messages" | "tools" | "max_tokens">;

// Returns ALL matching overrides (possibly empty). The engine decides the final
// tier via `applyOverrides`. This separation keeps detection pure and lets the
// decision record explain every signal that fired, even the ones that lost.
export function evaluateOverrides(
  req: OverrideInput,
  cfg: ClassifierRulesConfig,
  approxTokens: number,
): OverrideHit[] {
  const ov = cfg.overrides;
  const hits: OverrideHit[] = [];

  const lastUserText = lastUserMessageText(req.messages);
  const fullText = allText(req.messages);

  // ── set overrides (absolute, highest priority) ──────────────────────────────

  // Heartbeat: the WHOLE last user message must BE the token (after trim), not a
  // substring — "explain HEARTBEAT_OK protocol" is a real coding question.
  if (isHeartbeat(lastUserText, ov.heartbeat_tokens)) {
    hits.push({ rule: "heartbeat", kind: "set", complexity: "simple" });
  }

  // Formal logic: a configured keyword anywhere in the conversation pins
  // reasoning regardless of how low the weighted score was.
  if (containsAny(fullText, ov.formal_logic_keywords)) {
    hits.push({ rule: "formal_logic", kind: "set", complexity: "reasoning" });
  }

  // Short-message shortcut: a tiny last user message with NO complex structural
  // signal (no code block / stack trace / over-long body) is trivially simple.
  if (isShortAndSimple(lastUserText, ov.short_message_max_chars)) {
    hits.push({ rule: "short_message", kind: "set", complexity: "simple" });
  }

  // ── floor overrides (raise-only) ────────────────────────────────────────────

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    hits.push({ rule: "tools_floor", kind: "floor", complexity: ov.tools_floor });
  }

  if (approxTokens > ov.long_context_token_threshold) {
    hits.push({ rule: "long_context", kind: "floor", complexity: ov.long_context_floor });
  }

  return hits;
}

// Resolve the final tier from the base (weighted) tier and the override hits.
// Priority: any `set` hit wins outright (heartbeat / formal logic are high-
// certainty signals — they pin the tier and ignore floors). Otherwise every
// `floor` raises the base toward its tier, taking the HIGHEST. floors never
// lower. With no hits, returns `base` unchanged. Documented tradeoff: see
// implementation-notes (set-over-floor precedence).
export function applyOverrides(base: Complexity, hits: OverrideHit[]): Complexity {
  const set = hits.find((h) => h.kind === "set");
  if (set) return set.complexity;

  let result = base;
  for (const hit of hits) {
    if (hit.kind === "floor" && RANK[hit.complexity] > RANK[result]) {
      result = hit.complexity;
    }
  }
  return result;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isHeartbeat(text: string, tokens: string[]): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return tokens.some((t) => t.length > 0 && trimmed === t.trim());
}

function isShortAndSimple(text: string, maxChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= maxChars) return false;
  // A complex structural signal disqualifies the shortcut even when short.
  if (detectCodeBlock(text) > 0) return false;
  if (detectStackTrace(text) > 0) return false;
  return true;
}

function containsAny(text: string, keywords: string[]): boolean {
  if (text.trim().length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.some((kw) => kw.length > 0 && haystack.includes(kw.toLowerCase()));
}

// Text of the LAST user-role message (heartbeat / short-message look at the
// final user turn, not the whole transcript).
function lastUserMessageText(messages: OverrideInput["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user") return contentToString(msg.content);
  }
  return "";
}

// Whole-conversation text (formal-logic keyword may appear anywhere).
function allText(messages: OverrideInput["messages"]): string {
  const parts: string[] = [];
  for (const msg of messages) parts.push(contentToString(msg.content));
  return parts.join("\n");
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
