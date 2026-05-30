import {
  type CascadeResult,
  type Classification,
  type ClassifierInput,
  type Complexity,
  classifyCascade,
  createEvalCache,
  type EvalCache,
  type EvalModelRequest,
  type EvalModelResponse,
  type LanesConfig,
  resolveLane as resolveLaneCore,
  runEvalCached,
  scoreRequest,
} from "@helm/core";
import type { ClassifierConfig, ClassifierRulesConfig, InternalRequest } from "@helm/shared";

// gateway.classify — the COMPOSITION ROOT that wires the framework-agnostic
// three-layer cascade (classifier.cascade) into the routing orchestrator. The
// cascade itself is pure/injected (CLAUDE.md principle 1); this module supplies
// the concrete Layer-1 rule engine, the Layer-2 eval client (a real network call
// to the internal small-model alias via the provider), the eval cache, and the
// lane resolver — and adapts the cascade's `CascadeResult` to routeRequest's
// `Classification` contract.
//
// eval is OFF by default (principle 4); the only knob is `evalEnabled`, threaded
// per-request from the chat route. An eval failure/timeout NEVER 5xx's — the
// client fails open and the cascade pins `balanced` with a precise
// `fallback_reason` (principle 3, 5). Logs carry only safe fields — never the
// prompt or model text (principle 7).

// classifier complexity (simple|standard|complex|reasoning) -> routing
// complexity (simple|medium|complex). Shared with server.ts's catalog mapping.
function mapComplexity(c: Complexity): Classification["complexity"] {
  switch (c) {
    case "standard":
      return "medium";
    case "reasoning":
      return "complex";
    case "complex":
      return "complex";
    default:
      return "simple";
  }
}

// Cheap prompt-token estimate (~4 chars/token) for the Layer-1 context gate.
function approxTokens(req: InternalRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
  }
  return Math.ceil(chars / 4);
}

// True when no message carries any non-whitespace text — a genuinely
// unclassifiable request. Detected HERE so the cascade's Layer-1 still commits to
// a lane; the orchestrator's classifySafe degrades an empty prompt to `balanced`.
function hasNoTextContent(req: InternalRequest): boolean {
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string" && content.trim().length > 0) return false;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string" && part.trim().length > 0) return false;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string" &&
          (part as { text: string }).text.trim().length > 0
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

// Project the request onto the cache-key/eval ClassifierInput subset.
function toClassifierInput(req: InternalRequest): ClassifierInput {
  return {
    messages: req.messages,
    tools: req.tools,
    response_format: req.response_format,
    attachments: req.attachments,
  };
}

// The Layer-2 eval prompt: a single deterministic instruction asking the small
// model to judge complexity/task_type/confidence as strict JSON. The user's last
// message is the only content; no system payload is logged (principle 7).
function buildEvalPrompt(req: InternalRequest): EvalModelRequest["messages"] {
  let lastUser = "";
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i];
    if (m && m.role === "user") {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") lastUser = content;
      break;
    }
  }
  return [
    {
      role: "system",
      content:
        "Classify the request. Reply with ONLY strict JSON " +
        '{"complexity":"simple|standard|complex|reasoning",' +
        '"task_type":"chat|coding|math|writing|extraction|tool_use|vision|web|data",' +
        '"confidence":0..1}.',
    },
    { role: "user", content: lastUser },
  ];
}

export interface ProviderForEval {
  chatCompletion(
    req: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

export interface ClassifyAdapterDeps {
  classifierConfig: ClassifierConfig;
  lanes: LanesConfig;
  /** Provider used to invoke the internal eval small-model (same upstream, eval
   *  alias). Only its non-stream `chatCompletion` is used. */
  provider: ProviderForEval;
  now: () => number;
  /** Structured log sink (safe fields only). */
  log: (level: string, msg: string, fields: Record<string, unknown>) => void;
}

// Per-request classify overrides (composition-root concern; defaults come from
// config). `rulesThreshold` is an e2e-only knob (HELM_E2E) to force Layer-1
// uncertainty so the cascade reaches Layer-2 eval — the deterministic Layer-1
// sigmoid never dips below 0.5, so the only way to exercise eval in a black-box
// test is to raise the gate. Production never sets these.
export interface ClassifyOverrides {
  evalEnabled?: boolean;
  rulesThreshold?: number;
}

// The classify function the orchestrator consumes, plus per-request overrides.
export type ClassifyFn = (
  req: InternalRequest,
  overrides?: ClassifyOverrides,
) => Promise<Classification>;

/**
 * Build the eval-aware classify adapter. Holds ONE process-local eval cache
 * (content-hash keyed, TTL+LRU) shared across requests — identical prompts
 * collapse onto a single eval call (the cache-hit invariant). Never throws.
 */
export function buildClassifyAdapter(deps: ClassifyAdapterDeps): ClassifyFn {
  const { classifierConfig, lanes, provider, now, log } = deps;
  const evalCfg = classifierConfig.eval;
  const cache: EvalCache = createEvalCache({
    ttlSec: evalCfg.cache.ttl_sec,
    maxEntries: evalCfg.cache.max_entries,
  });

  // Map a cascade lane resolution through the REAL routing lane-resolver so the
  // cascade's internal `lane` field is consistent (routeRequest re-resolves from
  // complexity/task_type, but we keep the cascade honest).
  const resolveLane = (complexity: Complexity, taskType: string): string => {
    const decision = resolveLaneCore({
      classification: {
        task_type: taskType,
        complexity: mapComplexity(complexity),
        decided_by: "eval",
        constraints: {},
      },
      policy: { matched_policy_id: null, use_lane: null, reason: "eval cascade" },
      lanes,
    });
    return decision.selected_lane;
  };

  // The internal small-model invoker: a non-streaming chat completion to the eval
  // alias. Honors the AbortSignal so an eval timeout reclaims the connection.
  const invokeModel = async (
    modelReq: EvalModelRequest,
    signal: AbortSignal,
  ): Promise<EvalModelResponse> => {
    const res = await provider.chatCompletion(
      {
        model: modelReq.model,
        messages: modelReq.messages,
        temperature: modelReq.temperature,
        stream: modelReq.stream,
        max_tokens: modelReq.max_tokens,
      },
      { signal },
    );
    // Extract the assistant text from an OpenAI-shaped completion (defensive).
    const choices = (res as { choices?: unknown }).choices;
    let text = "";
    if (Array.isArray(choices) && choices[0]) {
      const msg = (choices[0] as { message?: { content?: unknown } }).message;
      if (msg && typeof msg.content === "string") text = msg.content;
    }
    return { text };
  };

  const rulesCfg: ClassifierRulesConfig = classifierConfig.rules;

  return async (req: InternalRequest, overrides?: ClassifyOverrides): Promise<Classification> => {
    // Genuinely contentless request → throw so classifySafe degrades to balanced.
    if (hasNoTextContent(req)) {
      throw new Error("classifier: no classifiable text content");
    }

    const input = toClassifierInput(req);
    const tokens = approxTokens(req);
    // Per-request eval enablement: default to config, override from the route.
    const enabled = overrides?.evalEnabled ?? evalCfg.enabled;
    // Per-request rules threshold (e2e-only): default to config. The cascade
    // gates Layer-1 → Layer-2 on `config.rules.confidence_threshold`.
    const threshold = overrides?.rulesThreshold ?? classifierConfig.rules.confidence_threshold;
    const cfg: ClassifierConfig = {
      ...classifierConfig,
      rules: { ...classifierConfig.rules, confidence_threshold: threshold },
      eval: { ...evalCfg, enabled },
    };

    const result: CascadeResult = await classifyCascade(input, {
      runRules: () => {
        const r = scoreRequest(req, { cfg: rulesCfg, approxTokens: tokens });
        return { complexity: r.complexity, task_type: r.task_type, confidence: r.confidence };
      },
      runEvalCached: (cacheInput) =>
        runEvalCached(cacheInput, {
          config: evalCfg,
          invokeModel,
          buildPrompt: () => buildEvalPrompt(req),
          now,
          log: (e) =>
            log("info", "eval.call", {
              model: e.model,
              latency_ms: e.latency_ms,
              decided: e.decided,
              reason: e.reason,
            }),
          cache,
          nowMs: now(),
        }),
      resolveLane: (complexity, taskType) => resolveLane(complexity, taskType),
      config: cfg,
    });

    // Adapt the cascade result to the orchestrator Classification. decided_by is
    // carried verbatim ("rules" | "eval" | "fallback"); the orchestrator's
    // resolver lands on the same lane (fallback -> balanced, others via
    // complexity/task). eval_cache_hit/fallback_reason flow into the record.
    return {
      task_type: result.task_type,
      complexity: mapComplexity(result.complexity),
      confidence: result.confidence,
      decided_by: result.decided_by,
      eval_cache_hit: result.eval_used ? result.eval_cache_hit : null,
      fallback_reason: result.fallback_reason ?? null,
      constraints: {
        needs_json: req.response_format !== null,
        needs_tools: Array.isArray(req.tools) && req.tools.length > 0,
        needs_vision: Array.isArray(req.attachments) && req.attachments.length > 0,
      },
      explanation: [],
    };
  };
}
