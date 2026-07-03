import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { isLowCostAutomationPrompt } from "./automation-signals.js";
import { lastUserMessageText } from "./message-text.js";
import { detectCodeBlock, detectFilePath, detectStackTrace, detectUrl } from "./signals.js";

// Task-type detection — orthogonal to complexity tiers (this module produces NO
// rawScore and reads none). It fuses three independent evidence paths, borrowing
// Manifest's "dimension→category mapping + tool-name prefix + structural signal"
// approach (docs/03 §Layer-1 task detection, research-notes §Manifest):
//   1. keyword sets       — DATA in cfg.task_keywords
//   2. tool-name prefixes — DATA in cfg.tool_prefixes (browser_/code_/sql_…)
//   3. structural signals — CODE here (shared regexes from ./signals.ts)
// Scores accumulate per task; the highest score that clears its activation
// threshold wins, else we fall back to `chat` (safe default, fail-open spirit —
// CLAUDE.md principle 3). The `web` activation is deliberately raised (default
// 3.0) so a single weak signal (one lone URL) cannot false-trigger it.
// Pure function (CLAUDE.md principle 4): zero I/O, no clock, no randomness.
//
// CURRENT-TURN SCOPING: the text evidence (keyword paths 1 + 3) reads ONLY the
// last user message, NOT the concatenated history. A constant system/developer
// prompt describes an agent's standing capabilities ("you can edit files, run
// bash"), not THIS request's task — scoring it would classify every message to a
// coding agent (even "thanks") as coding. This mirrors the language guard's
// "current turn only" rule (engine.ts §5.5: "historical keyword hits … are not
// evidence that Layer-1 understood this prompt"). Tool names (path 2) stay full —
// they are a legitimate per-request capability signal, not history. Low-cost
// monitor/cron probes are the narrow exception: their tool surface and MONITOR.md
// path are ambient automation context, so explicit current-turn task keywords must
// carry the classification instead.

export type TaskType =
  | "chat"
  | "coding"
  | "math"
  | "writing"
  | "extraction"
  | "tool_use"
  | "vision"
  | "web"
  | "data"
  | "security";

export interface TaskScore {
  task: TaskType;
  score: number;
  reasons: string[];
}

export interface TaskDetectResult {
  task_type: TaskType; // highest score that clears its threshold, else `chat`.
  scores: TaskScore[]; // all candidates with score > 0 (for explanation).
}

type DetectInput = Pick<InternalRequest, "messages" | "tools" | "response_format" | "attachments">;

// Evidence weights. Keywords and prefixes are config; these per-signal weights
// are the fusion code's tuning knobs (kept here, not in cfg, by task scope).
const KEYWORD_WEIGHT = 1.0; // per matched keyword
const TOOL_PREFIX_WEIGHT = 2.0; // a matching tool prefix is strong evidence
const STRUCTURAL_WEIGHT = 1.0; // a present structural signal
const DEFAULT_ACTIVATION = 1.0;

// Exported as the single source of truth for the closed task vocabulary so the
// policy cross-reference guard (policy-crossref.test.ts) can assert every
// policies.yaml match.task_type is one the classifier can actually emit.
export const ALL_TASKS: TaskType[] = [
  "chat",
  "coding",
  "math",
  "writing",
  "extraction",
  "tool_use",
  "vision",
  "web",
  "data",
  "security",
];

export function detectTask(req: DetectInput, cfg: ClassifierRulesConfig): TaskDetectResult {
  // Text evidence is scoped to the CURRENT user turn (see header). Tool names are
  // request-wide (a capability signal, not history) and read from req.tools below.
  const text = lastUserMessageText(req.messages);
  const lowCostAutomation = isLowCostAutomationPrompt(text, cfg);
  const toolNames = extractToolNames(req.tools);

  // Accumulate score + reasons per task. Lazily created on first hit.
  const acc = new Map<TaskType, TaskScore>();
  const bump = (task: TaskType, amount: number, reason: string): void => {
    const cur = acc.get(task) ?? { task, score: 0, reasons: [] };
    cur.score += amount;
    cur.reasons.push(reason);
    acc.set(task, cur);
  };

  // ── path 1: keyword sets (DATA) ──────────────────────────────────────────
  const haystack = text.toLowerCase();
  for (const [task, keywords] of Object.entries(cfg.task_keywords)) {
    if (!isTaskType(task)) continue;
    for (const kw of keywords) {
      if (kw.length === 0) continue;
      if (haystack.includes(kw.toLowerCase())) {
        bump(task, KEYWORD_WEIGHT, `keyword:${kw}`);
      }
    }
  }

  // ── path 2: tool-name prefixes (DATA) ────────────────────────────────────
  if (!lowCostAutomation) {
    for (const [task, prefixes] of Object.entries(cfg.tool_prefixes)) {
      if (!isTaskType(task)) continue;
      for (const prefix of prefixes) {
        if (prefix.length === 0) continue;
        for (const name of toolNames) {
          if (name.startsWith(prefix)) {
            bump(task, TOOL_PREFIX_WEIGHT, `tool_prefix:${prefix}`);
          }
        }
      }
    }
  }

  // ── path 3: structural signals (CODE — shared regexes) ───────────────────
  if (detectCodeBlock(text) > 0) bump("coding", STRUCTURAL_WEIGHT, "code_block");
  if (detectStackTrace(text) > 0) bump("coding", STRUCTURAL_WEIGHT, "stack_trace");
  if (!lowCostAutomation && detectFilePath(text) > 0) {
    bump("coding", STRUCTURAL_WEIGHT, "file_path");
  }
  if (detectUrl(text) > 0) bump("web", STRUCTURAL_WEIGHT, "url");
  if (hasImageAttachment(req.attachments)) bump("vision", STRUCTURAL_WEIGHT, "image_attachment");
  if (isJsonResponseFormat(req.response_format)) {
    bump("extraction", STRUCTURAL_WEIGHT, "json_response_format");
  }

  // ── fuse: pick the highest score that clears its activation threshold ─────
  // Tie-break is EXPLICIT and stable so an exact-score tie can never silently
  // demote a gated task by config (Map insertion) order. Among activated
  // candidates we order by, in turn:
  //   1. score                    desc — the primary signal;
  //   2. margin (score-activation) desc — clearing a higher bar by more wins;
  //   3. a fixed task priority         — last-resort deterministic seed-ordering
  //      (gated/high-risk tasks like `security` rank first so a true tie keeps
  //      them rather than dropping to an alphabetically/insertion-earlier peer).
  const scores = [...acc.values()];
  const activated = scores.filter((s) => s.score >= activationFor(s.task, cfg));
  let best: TaskScore | undefined;
  for (const s of activated) {
    if (best === undefined || tieBreakBetter(s, best, cfg)) best = s;
  }

  return {
    task_type: best?.task ?? "chat",
    scores,
  };
}

// Fixed, deterministic last-resort priority over the closed task vocabulary —
// only consulted when score AND margin are exactly equal. `security` (and other
// gated/high-consequence tasks) rank first so a true tie resolves toward the
// safer classification rather than whichever key the config happened to list
// earlier. Earlier in this list = higher priority.
const TASK_TIE_PRIORITY: TaskType[] = [
  "security",
  "coding",
  "math",
  "data",
  "extraction",
  "vision",
  "web",
  "tool_use",
  "writing",
  "chat",
];

function tiePriority(task: TaskType): number {
  const i = TASK_TIE_PRIORITY.indexOf(task);
  return i === -1 ? TASK_TIE_PRIORITY.length : i;
}

/** True iff candidate `a` should beat the current `best` under the stable
 *  (score desc, margin desc, fixed-priority) ordering. */
function tieBreakBetter(a: TaskScore, best: TaskScore, cfg: ClassifierRulesConfig): boolean {
  if (a.score !== best.score) return a.score > best.score;
  const marginA = a.score - activationFor(a.task, cfg);
  const marginBest = best.score - activationFor(best.task, cfg);
  if (marginA !== marginBest) return marginA > marginBest;
  return tiePriority(a.task) < tiePriority(best.task);
}

function activationFor(task: TaskType, cfg: ClassifierRulesConfig): number {
  const v = cfg.task_activation[task];
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_ACTIVATION;
}

function isTaskType(s: string): s is TaskType {
  return (ALL_TASKS as string[]).includes(s);
}

// ── input extraction (robust to MVP's open message/tool shapes) ─────────────

// Tool name lives at tools[].function.name (OpenAI shape) or tools[].name. The
// MVP keeps `tools` an open array, so every access is defensive: malformed /
// missing entries are simply skipped (no throw — task spec boundary).
function extractToolNames(tools: DetectInput["tools"]): string[] {
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

function hasImageAttachment(attachments: DetectInput["attachments"]): boolean {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  // Any attachment with no explicit non-image type counts as image-ish; an
  // explicit image type always counts. Defensive against open attachment shape.
  for (const att of attachments) {
    if (!isRecord(att)) return true; // bare/unknown attachment — treat as visual
    const t = att.type;
    if (typeof t !== "string") return true;
    if (t === "image" || t === "image_url" || t.startsWith("image")) return true;
  }
  return false;
}

function isJsonResponseFormat(rf: DetectInput["response_format"]): boolean {
  if (!isRecord(rf)) return false;
  const t = rf.type;
  return typeof t === "string" && (t === "json_object" || t === "json_schema");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
