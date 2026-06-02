import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import {
  detectCodeBlock,
  detectFilePath,
  detectMathNotation,
  detectStackTrace,
  detectTable,
  detectUrl,
  lengthSignal,
  normalize,
} from "./signals.js";

// Layer-1 dimension scorer — maps one request to a single `rawScore` plus the
// per-dimension hit detail. Per CLAUDE.md principle 4 this is a PURE function:
// same input => same output, zero I/O, no clock, no randomness. Keywords and
// weights are DATA (classifier.yaml); structural-signal regexes are CODE here.
// This task produces ONLY rawScore + hits — no tiers, no task detection.

// Single hit detail. Enters `explanation` for the decision record.
export interface DimensionHit {
  dimension: string; // dimension name, e.g. "reasoning_kw" / "has_code_block"
  weight: number; // weight from config (sign = direction)
  signal: number; // raw signal strength in [0,1]
  contribution: number; // weight * signal — summed into rawScore
}

export interface DimensionScore {
  rawScore: number; // Σ contribution
  hits: DimensionHit[]; // only dimensions with signal > 0
}

// Structural-dimension names whose signal comes from code, not keywords. The
// weight still lives in config; here we only decide the [0,1] signal. Dimensions
// absent from config are skipped (the scorer is robust to a config subset).
const STRUCTURAL_DETECTORS: Record<string, (ctx: ReqContext) => number> = {
  has_code_block: (c) => detectCodeBlock(c.text),
  has_url: (c) => detectUrl(c.text),
  has_stack: (c) => detectStackTrace(c.text),
  has_file_path: (c) => detectFilePath(c.text),
  has_math_notation: (c) => detectMathNotation(c.text),
  has_table: (c) => detectTable(c.text),
  has_attachment: (c) => (c.hasAttachment ? 1 : 0),
  has_json_format: (c) => (c.hasJsonFormat ? 1 : 0),
  has_tools: (c) => (c.toolCount > 0 ? 1 : 0),
  tool_count: (c) => normalize(c.toolCount, 8),
  turn_count: (c) => normalize(c.turnCount, 12),
  msg_length: (c) => lengthSignal(c.text),
};

interface ReqContext {
  text: string;
  turnCount: number;
  toolCount: number;
  hasAttachment: boolean;
  hasJsonFormat: boolean;
}

type ScoreInput = Pick<
  InternalRequest,
  "messages" | "tools" | "response_format" | "attachments" | "max_tokens"
>;

export function scoreDimensions(req: ScoreInput, cfg: ClassifierRulesConfig): DimensionScore {
  const ctx = buildContext(req);
  const hits: DimensionHit[] = [];
  let rawScore = 0;

  for (const [name, dim] of Object.entries(cfg.dimensions)) {
    const signal =
      dim.keywords.length > 0
        ? keywordSignal(ctx.text, dim.keywords)
        : (STRUCTURAL_DETECTORS[name]?.(ctx) ?? 0);

    if (signal <= 0) continue;

    const contribution = dim.weight * signal;
    hits.push({ dimension: name, weight: dim.weight, signal, contribution });
    rawScore += contribution;
  }

  return { rawScore, hits };
}

// ── context assembly ──────────────────────────────────────────────────────────

function buildContext(req: ScoreInput): ReqContext {
  const text = extractText(req.messages);
  return {
    text,
    turnCount: req.messages.length,
    toolCount: Array.isArray(req.tools) ? req.tools.length : 0,
    hasAttachment: Array.isArray(req.attachments) && req.attachments.length > 0,
    hasJsonFormat: isJsonResponseFormat(req.response_format),
  };
}

// Flatten message content into a single string for keyword/structural matching.
// Reads only string-shaped content (and string `text` parts of array content);
// never performs any network/IO. Non-string parts are ignored.
function extractText(messages: ScoreInput["messages"]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    collectStrings(msg.content, parts);
  }
  return parts.join("\n");
}

function collectStrings(content: unknown, out: string[]): void {
  if (typeof content === "string") {
    out.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        out.push(part);
      } else if (isRecord(part) && typeof part.text === "string") {
        out.push(part.text);
      }
    }
  }
}

function isJsonResponseFormat(rf: ScoreInput["response_format"]): boolean {
  if (!isRecord(rf)) return false;
  const t = rf.type;
  return typeof t === "string" && (t === "json_object" || t === "json_schema");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ── keyword signal ────────────────────────────────────────────────────────────

// Case-insensitive, WORD/TOKEN-boundary aware match; signal = normalized hit
// count over keywords. We do NOT lowercase the original text for storage — the
// `i` flag folds case locally without mutating the source for any other use.
//
// Boundaries are enforced ONLY on a keyword edge that is itself a word char
// (alnum/underscore). This is what stops a naive `includes` from firing "hi"
// inside "t·hi·s" or "ok" inside "lo·ok"/"bo·ok" (a real regression: those
// false hits silently poisoned the rawScore of unrelated prompts). Keywords
// that contain spaces ("step by step") or END in punctuation ("cve-", meant to
// match "cve-2021") keep matching, because the non-word edge gets NO boundary.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD = /[\p{L}\p{N}_]/u; // unicode letter/number/underscore
// CJK scripts (Han / Hiragana / Katakana / Hangul) write words WITHOUT spaces, so a
// CJK edge char would NEVER satisfy the word-boundary lookaround below — "分析" inside
// "请分析这个" is flanked by other \p{L} chars, so both lookarounds fail and the keyword
// becomes permanently unmatchable. CJK edges therefore match as plain substrings (their
// "words" are 1–3 meaningful chars, so the naive-substring false-hit risk that boundaries
// guard against for Latin does not apply). This is what makes config-level CJK keyword
// lists possible at all (see implementation-notes: classifier.multilingual-guard).
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const needsBoundary = (ch: string): boolean => WORD.test(ch) && !CJK.test(ch);
const keywordMatcherCache = new Map<string, RegExp>();
function keywordMatcher(kw: string): RegExp {
  let re = keywordMatcherCache.get(kw);
  if (re === undefined) {
    const left = needsBoundary(kw[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
    const right = needsBoundary(kw[kw.length - 1] ?? "") ? "(?![\\p{L}\\p{N}_])" : "";
    re = new RegExp(left + escapeRegExp(kw) + right, "iu");
    keywordMatcherCache.set(kw, re);
  }
  return re;
}

function keywordSignal(text: string, keywords: string[]): number {
  if (text.trim().length === 0) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    if (keywordMatcher(kw).test(text)) hits += 1;
  }
  if (hits === 0) return 0;
  // Saturating: 1 keyword ~ moderate, multiple keywords approach full signal.
  return Math.min(1, hits / Math.max(1, Math.ceil(keywords.length / 2)));
}

// Structural-signal detectors (detectCodeBlock / detectUrl / …) and the
// normalize/lengthSignal helpers live in ./signals.ts — shared with taskdetect
// so the two paths never drift apart with duplicate regexes.
