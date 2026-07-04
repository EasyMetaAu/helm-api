import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { isLowCostAutomationPrompt } from "./automation-signals.js";
import { detectCodeBlock, detectStackTrace, keywordMatcher } from "./signals.js";
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
  /** "heartbeat" | "exact_confirmation" | "low_cost_automation" | "cheap_model_low_risk" | "formal_logic" | "tools_floor" | "long_context" | "short_message" */
  rule: string;
  kind: OverrideKind;
  complexity: Complexity;
}

// Total tier order. `floor` may only raise toward a higher index, never lower.
// RANK is derived from ORDER so the sequence is the single source of truth.
const DEFAULT_EXACT_CONFIRMATION_TOKENS = ["yes", "no", "sure", "got it", "ok", "thanks"];

const ORDER: Complexity[] = ["simple", "standard", "complex", "reasoning"];
const RANK: Record<Complexity, number> = Object.fromEntries(
  ORDER.map((tier, i) => [tier, i]),
) as Record<Complexity, number>;

type OverrideInput = Pick<
  InternalRequest,
  "messages" | "requested_model" | "response_format" | "attachments" | "tools" | "max_tokens"
>;

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

  // Exact confirmations: weak words like "no" are safe only when the whole last
  // user utterance is exactly the confirmation, never as full-prompt keywords.
  const exactConfirmationTokens = ov.exact_confirmation_tokens ?? DEFAULT_EXACT_CONFIRMATION_TOKENS;
  if (isExactConfirmation(lastUserText, exactConfirmationTokens)) {
    hits.push({ rule: "exact_confirmation", kind: "set", complexity: "simple" });
  }

  // Formal logic: a configured keyword anywhere in the conversation pins
  // reasoning regardless of how low the weighted score was.
  if (containsAny(fullText, ov.formal_logic_keywords)) {
    hits.push({ rule: "formal_logic", kind: "set", complexity: "reasoning" });
  }

  // Low-cost automation: scheduled monitor probes with an explicit no-reply
  // contract should not be raised by ambient tool/file-path or long-history
  // signals. True window fit is enforced later by the capability filter.
  if (isLowCostAutomationPrompt(lastUserText, cfg)) {
    hits.push({ rule: "low_cost_automation", kind: "set", complexity: "simple" });
  }

  // Cheap-model low-risk current turn: a client explicitly requested a cheap
  // model for a short read/check/status turn, but the transcript may carry a very
  // large history and many tools. Scope the signal to the current user turn and
  // require the requested model + low-risk marker so generic long-context work is
  // not silently down-routed.
  if (isCheapModelLowRiskTurn(req, lastUserText, cfg)) {
    hits.push({ rule: "cheap_model_low_risk", kind: "set", complexity: "simple" });
  }

  // Short-message shortcut: a tiny last user message with NO complex structural
  // signal (no code block / stack trace / over-long body) is trivially simple.
  if (isShortAndSimple(lastUserText, ov.short_message_max_chars, cfg)) {
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

function isExactConfirmation(text: string, tokens: string[]): boolean {
  const normalized = normalizeUtterance(text);
  if (normalized.length === 0) return false;
  return tokens.some((t) => normalizeUtterance(t) === normalized);
}

function isShortAndSimple(text: string, maxChars: number, cfg: ClassifierRulesConfig): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= maxChars) return false;
  // A complex structural or classifier signal disqualifies the shortcut even when short.
  if (detectCodeBlock(text) > 0) return false;
  if (detectStackTrace(text) > 0) return false;
  if (containsClassifierSignal(trimmed, cfg)) return false;
  return true;
}

function isCheapModelLowRiskTurn(
  req: OverrideInput,
  text: string,
  cfg: ClassifierRulesConfig,
): boolean {
  const cheap = cfg.overrides.cheap_model_low_risk;
  if (cheap.requested_model_markers.length === 0 || cheap.low_risk_markers.length === 0) {
    return false;
  }
  if (!modelMatches(req.requested_model, cheap.requested_model_markers)) return false;
  if (isJsonResponseFormat(req.response_format)) return false;
  if (hasImageAttachment(req.attachments)) return false;

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > cheap.current_turn_max_chars) return false;
  if (detectCodeBlock(trimmed) > 0) return false;
  if (detectStackTrace(trimmed) > 0) return false;
  if (containsAny(trimmed, cheap.blocked_markers)) return false;
  return containsAny(trimmed, cheap.low_risk_markers);
}

function modelMatches(model: string, markers: string[]): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return markers.some((marker) => {
    const m = marker.trim().toLowerCase();
    if (m.length === 0) return false;
    if (m.includes("*")) return globToRegExp(m).test(normalized);
    return normalized === m;
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u");
}

// The short-message disqualifier must see BOTH the English signal dimensions and
// their international (*_intl_kw) counterparts — otherwise a short Chinese analysis/
// security/diagnostic prompt ("分析这个系统的根因") is wrongly force-pinned `simple`
// because the English lists never match it. The shared keywordMatcher matches CJK as
// a substring, so these now fire mid-text. task_keywords.security carries its own
// Simplified entries; the *_intl_kw dimensions cover analysis/security/diagnostic.
function containsClassifierSignal(text: string, cfg: ClassifierRulesConfig): boolean {
  const signalKeywords = [
    ...keywordsForDimension(cfg, "analysis_kw"),
    ...keywordsForDimension(cfg, "analysis_intl_kw"),
    ...keywordsForDimension(cfg, "security_kw"),
    ...keywordsForDimension(cfg, "security_intl_kw"),
    ...keywordsForDimension(cfg, "diagnostic_short_kw"),
    ...keywordsForDimension(cfg, "diagnostic_short_intl_kw"),
    ...(cfg.task_keywords.security ?? []),
  ];
  return matchesAnyKeyword(text, signalKeywords);
}

function keywordsForDimension(cfg: ClassifierRulesConfig, name: string): string[] {
  return cfg.dimensions[name]?.keywords ?? [];
}

function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => kw.length > 0 && keywordMatcher(kw).test(text));
}

function containsAny(text: string, keywords: string[]): boolean {
  if (text.trim().length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.some((kw) => kw.length > 0 && haystack.includes(kw.toLowerCase()));
}

function isJsonResponseFormat(rf: OverrideInput["response_format"]): boolean {
  if (!isRecord(rf)) return false;
  const t = rf.type;
  return typeof t === "string" && (t === "json_object" || t === "json_schema");
}

function hasImageAttachment(attachments: OverrideInput["attachments"]): boolean {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  for (const att of attachments) {
    if (!isRecord(att)) return true;
    const t = att.type;
    if (typeof t !== "string") return true;
    if (t === "image" || t === "image_url" || t.startsWith("image")) return true;
  }
  return false;
}

function normalizeUtterance(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
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
