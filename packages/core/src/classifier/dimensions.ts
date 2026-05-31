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

// Case-insensitive substring match; signal = normalized hit count over keywords.
// Per implementation-notes we do NOT lowercase the original text for storage —
// matching folds case locally without mutating the source for any other use.
function keywordSignal(text: string, keywords: string[]): number {
  if (text.trim().length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    if (haystack.includes(kw.toLowerCase())) hits += 1;
  }
  if (hits === 0) return 0;
  // Saturating: 1 keyword ~ moderate, multiple keywords approach full signal.
  return Math.min(1, hits / Math.max(1, Math.ceil(keywords.length / 2)));
}

// Structural-signal detectors (detectCodeBlock / detectUrl / …) and the
// normalize/lengthSignal helpers live in ./signals.ts — shared with taskdetect
// so the two paths never drift apart with duplicate regexes.
