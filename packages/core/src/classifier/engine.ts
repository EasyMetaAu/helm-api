import type { ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { type DimensionScore, scoreDimensions } from "./dimensions.js";
import { applyMomentum, type MomentumDeps, recordMomentum } from "./momentum.js";
import { applyOverrides, evaluateOverrides } from "./overrides.js";
import { nonLatinRatio } from "./signals.js";
import { detectTask, type TaskType } from "./taskdetect.js";
import { type Complexity, classifyTier } from "./tiers.js";

// Layer-1 rule engine — the SINGLE entry point that composes the deterministic
// sub-functions (dimensions → momentum → tiers → overrides → taskdetect) into
// one full classification output aligned with @helm/shared
// ClassifierDecisionSchema. Per docs/03 §classification cascade this is Layer 1:
// always-on, zero-cost, zero-latency, deterministic. It performs ZERO I/O beyond
// the injected momentum soft-state (CLAUDE.md principle 4) — no eval, no catalog,
// no provider. When confidence < threshold it only MARKS `uncertain` so the
// (separate) cascade orchestrator may enter Layer 2; this task never runs eval.
//
// Fail-open (CLAUDE.md principle 3): every sub-step is wrapped so a degenerate
// input yields a SAFE default (standard / chat, low confidence) instead of
// throwing — the upper cascade then degrades to `balanced`, never a 5xx.
// `decided_by` is fixed to "rules" here; "eval"/"default" are written by the
// cascade orchestrator (principle 5: the two fallback mechanisms stay separate).

// docs/03 constraint bitmap — derived capability requirements for routing.
export interface Constraints {
  needs_tools: boolean; // tools non-empty
  needs_json: boolean; // response_format is JSON
  needs_vision: boolean; // image attachment / vision signal
  long_context: boolean; // approxTokens over threshold
  low_latency: boolean; // short message / heartbeat inferred
  low_cost: boolean; // simple tier / heartbeat → prefer cheap
}

export type ExplanationSource = "dimension" | "override" | "task" | "momentum";

export interface ExplanationEntry {
  source: ExplanationSource;
  detail: string;
  weight?: number;
}

export interface ClassificationResult {
  complexity: Complexity;
  task_type: TaskType;
  confidence: number;
  uncertain: boolean; // true → cascade MAY enter Layer-2 eval (separate task)
  decided_by: "rules"; // always "rules" here; eval/default written upstream
  constraints: Constraints;
  explanation: ExplanationEntry[];
}

export interface ScoreRequestDeps {
  cfg: ClassifierRulesConfig;
  momentum?: MomentumDeps; // optional; absent → momentum not applied
  approxTokens: number; // upstream-estimated context token count
}

// Pure orchestration (aside from the injected momentum soft-state): same input +
// same deps (same momentum snapshot) → same output.
export function scoreRequest(req: InternalRequest, deps: ScoreRequestDeps): ClassificationResult {
  const { cfg, approxTokens } = deps;
  const explanation: ExplanationEntry[] = [];

  // ── 1. dimension scoring ──────────────────────────────────────────────────
  const dim = safe(() => scoreDimensions(req, cfg), { rawScore: 0, hits: [] });
  for (const hit of dim.hits) {
    explanation.push({
      source: "dimension",
      detail: hit.dimension,
      weight: hit.contribution,
    });
  }

  // ── 2. momentum (optional soft-state) ─────────────────────────────────────
  const sessionKey = req.metadata?.conversation_id ?? null;
  const messageChars = lastUserMessageChars(req.messages);
  let adjustedRawScore = dim.rawScore;
  let momentumApplied = false;
  if (deps.momentum) {
    const mom = safe(
      () =>
        applyMomentum(
          { sessionKey, rawScore: dim.rawScore, messageChars },
          deps.momentum as MomentumDeps,
        ),
      { adjustedRawScore: dim.rawScore, momentumApplied: false, historyWeight: 0 },
    );
    adjustedRawScore = mom.adjustedRawScore;
    momentumApplied = mom.momentumApplied;
    if (mom.momentumApplied) {
      explanation.push({
        source: "momentum",
        detail: `history pull-back (w=${round(mom.historyWeight)})`,
        weight: mom.historyWeight,
      });
    }
  }

  // ── 3. tier gate ──────────────────────────────────────────────────────────
  const tier = safe(() => classifyTier(adjustedRawScore, cfg), {
    complexity: "standard" as Complexity,
    confidence: 0,
    uncertain: true,
    nearestBoundaryDistance: 0,
  });
  const baseComplexity = tier.complexity;

  // ── 4. overrides (set pins / floor raises over the weighted tier) ─────────
  // Momentum is the designated mechanism to stop "a single short message
  // dragging classification off-course" (docs/03 §momentum). When momentum
  // actually fired, the weak `short_message` SHORTCUT must not re-pin `simple`
  // and undo it — so the engine drops that one hit. The high-certainty `set`
  // signals (heartbeat exact-token / formal_logic) are precise and still win.
  // See implementation-notes (engine: momentum suppresses short_message).
  const rawOverrideHits = safe(() => evaluateOverrides(req, cfg, approxTokens), []);
  const overrideHits = momentumApplied
    ? rawOverrideHits.filter((h) => h.rule !== "short_message")
    : rawOverrideHits;
  const complexity = safe(() => applyOverrides(baseComplexity, overrideHits), baseComplexity);
  for (const hit of overrideHits) {
    explanation.push({
      source: "override",
      detail: `${hit.rule}:${hit.kind}→${hit.complexity}`,
    });
  }

  // ── 5. task detection ─────────────────────────────────────────────────────
  const task = safe(() => detectTask(req, cfg), { task_type: "chat" as TaskType, scores: [] });
  explanation.push({ source: "task", detail: task.task_type });

  // ── 5.5 language-coverage guard ───────────────────────────────────────────
  // The keyword lists are ENGLISH-ONLY (CLAUDE.md: Layer-1 is the English fast
  // path). A predominantly non-Latin prompt therefore cannot be scored by them, so
  // a high-confidence keyword verdict on it would be a lie. Force `uncertain` so the
  // cascade escalates to the (multilingual) Layer-2 eval — or, with eval OFF, lands
  // `balanced` deterministically rather than by luck of where the structural-only
  // rawScore fell. Suppressed when (a) the message is trivially short (already pinned
  // `simple` by the short_message override) or (b) a CONTENT-TYPE structural signal
  // gave real, language-agnostic grip (code block / stack / table / attachment / …).
  // Ambient signals (msg_length / turn_count) fire on every request and are NOT grip.
  let confidence = tier.confidence;
  let uncertain = tier.uncertain;
  if (safe(() => languageGuardTrips(req, cfg, dim.hits), false)) {
    confidence = 0;
    uncertain = true;
    explanation.push({ source: "override", detail: "low_keyword_coverage" });
  }

  // ── 6. derive constraints ─────────────────────────────────────────────────
  const constraints = deriveConstraints(req, approxTokens, cfg, complexity, overrideHits);

  // ── 7. momentum write-back (record THIS turn's final tier) ────────────────
  if (deps.momentum) {
    safe(() => {
      recordMomentum(
        sessionKey,
        { complexity, rawScore: adjustedRawScore, at: 0 /* restamped */ },
        deps.momentum as MomentumDeps,
      );
      return null;
    }, null);
  }

  return {
    complexity,
    task_type: task.task_type,
    confidence,
    uncertain,
    decided_by: "rules",
    constraints,
    explanation,
  };
}

// Ambient structural dimensions fire on (almost) every request, so they are NOT
// evidence that the keyword classifier actually understood the prompt — they must
// not suppress the language guard. Every OTHER positive-contribution dimension hit
// (keyword match or a content-type structural signal) IS real grip.
const AMBIENT_DIMENSIONS = new Set(["msg_length", "turn_count"]);

// True when Layer-1's English keyword lists have no purchase on a non-Latin prompt
// and nothing else gave it real grip — see step 5.5. Pure: reads only its inputs.
function languageGuardTrips(
  req: InternalRequest,
  cfg: ClassifierRulesConfig,
  hits: DimensionScore["hits"],
): boolean {
  // Robust to a config SUBSET (dimensions.ts contract): an absent `language` block
  // (or an older parsed config) simply disables the guard rather than throwing.
  const lang = cfg.language;
  if (!lang?.non_latin_uncertain) return false;
  const text = lastUserMessageText(req.messages).trim();
  // Trivially short prompts are pinned `simple` by the short_message override; do
  // not escalate them. Reuse the same char threshold so the two stay consistent.
  if (text.length <= cfg.overrides.short_message_max_chars) return false;
  if (nonLatinRatio(text) < lang.non_latin_min_ratio) return false;
  // Any positive, non-ambient hit (keyword or content-type structural) = real grip.
  const hasGrip = hits.some((h) => h.contribution > 0 && !AMBIENT_DIMENSIONS.has(h.dimension));
  return !hasGrip;
}

// ── constraint derivation ──────────────────────────────────────────────────

function deriveConstraints(
  req: InternalRequest,
  approxTokens: number,
  cfg: ClassifierRulesConfig,
  complexity: Complexity,
  overrideHits: ReturnType<typeof evaluateOverrides>,
): Constraints {
  const needs_tools = Array.isArray(req.tools) && req.tools.length > 0;
  const needs_json = isJsonResponseFormat(req.response_format);
  const needs_vision = hasImageAttachment(req.attachments);
  const long_context = approxTokens > cfg.overrides.long_context_token_threshold;
  // A heartbeat or short-message shortcut signals a latency-sensitive, cheap
  // request: prefer fast & cheap. `simple` tier also reads as low-cost.
  const heartbeatOrShort = overrideHits.some(
    (h) => h.rule === "heartbeat" || h.rule === "short_message",
  );
  const low_latency = heartbeatOrShort;
  const low_cost = heartbeatOrShort || complexity === "simple";

  return {
    needs_tools,
    needs_json,
    needs_vision,
    long_context,
    low_latency,
    low_cost,
  };
}

// ── helpers (defensive, fail-open) ─────────────────────────────────────────

// Run a sub-step; if it throws, swallow and return the safe fallback. Layer-1
// must never let a classification error bubble into a 5xx (principle 3).
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function lastUserMessageText(messages: InternalRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user") {
      return contentToString(msg.content);
    }
  }
  return "";
}

function lastUserMessageChars(messages: InternalRequest["messages"]): number {
  return lastUserMessageText(messages).trim().length;
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

function isJsonResponseFormat(rf: InternalRequest["response_format"]): boolean {
  if (!isRecord(rf)) return false;
  const t = rf.type;
  return typeof t === "string" && (t === "json_object" || t === "json_schema");
}

function hasImageAttachment(attachments: InternalRequest["attachments"]): boolean {
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
