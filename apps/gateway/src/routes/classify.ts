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
  type MomentumStore,
  resolveCostUsd,
  resolveLane as resolveLaneCore,
  runEvalCached,
  scoreRequest,
} from "@helm/core";
import type {
  CatalogEntry,
  ClassifierConfig,
  ClassifierRulesConfig,
  InternalRequest,
} from "@helm/shared";

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
        '"task_type":"chat|coding|math|writing|extraction|tool_use|vision|web|data|security",' +
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
  /** Read the CURRENT classifier config — invoked ONCE per request so an admin
   *  edit (via the RuleStore) hot-applies to routing WITHOUT a restart. The
   *  adapter rebuilds its eval cache whenever the returned config changes, so a
   *  verdict computed under an old config is never served after the change. */
  getClassifierConfig: () => ClassifierConfig;
  lanes: LanesConfig;
  /** Provider used to invoke the internal eval small-model (same upstream, eval
   *  alias). Only its non-stream `chatCompletion` is used. */
  provider: ProviderForEval;
  now: () => number;
  /** Structured log sink (safe fields only). */
  log: (level: string, msg: string, fields: Record<string, unknown>) => void;
  /** Session-momentum soft-state, injected by the composition root (server.ts) as
   *  a process-wide SINGLETON so history persists across requests. The adapter
   *  threads it into Layer-1 `scoreRequest` so momentum reads/writes history keyed
   *  by `metadata.conversation_id` (mapped from `x-session-key`). OPTIONAL and
   *  fail-open (CLAUDE.md principle 3): absent → momentum simply does not apply,
   *  never an error; the engine ALSO no-ops when there is no session key. Only the
   *  store port is supplied here — the clock and config come from the adapter's
   *  own `now`/per-request `rulesCfg`, keeping TTL deterministic and config-driven. */
  momentum?: { store: MomentumStore };
  /** Capability/pricing catalog (modelKey → entry), injected by the composition
   *  root so the eval call's OWN token usage is converted to a USD self-cost
   *  (eval_usd, docs/07) when the upstream does not bill it inline. OPTIONAL and
   *  fail-open (principle 3): absent entry / missing pricing → eval_usd null (not
   *  measured, distinct from a measured 0), NEVER a crash. */
  catalog?: Map<string, CatalogEntry>;
}

// Per-request classify overrides (composition-root concern; defaults come from
// config). `rulesThreshold` is an e2e-only knob (HELM_E2E) to override the
// Layer-1 gate per request. Since classifier.confidence-fix the default 0.45
// threshold already cascades on boundary-hugging prompts, so it is no longer
// REQUIRED to exercise eval — it remains as a test affordance for forcing
// specific gate values. Production never sets these.
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
  const { getClassifierConfig, lanes, provider, now, log, momentum, catalog } = deps;

  // The eval cache is content-hash keyed and shared across requests so identical
  // prompts collapse onto one eval call. But a cached verdict is only valid under
  // the config that produced it — when the admin edits the classifier (eval block,
  // thresholds, weights), a stale verdict must NOT be served. We rebuild the cache
  // whenever the live config's identity changes, keyed by a stable fingerprint so a
  // semantically-equal re-parse (same values, new object) does NOT needlessly drop
  // it. Holds the current cache + the fingerprint it was built for.
  let cache: EvalCache = createEvalCache({ ttlSec: 300, maxEntries: 5000 });
  let cacheFingerprint = "";
  // Sync the cache to a (possibly new) config: rebuild it if the config changed.
  // Returns the eval block of the now-current config.
  const syncCache = (cfg: ClassifierConfig) => {
    const fingerprint = JSON.stringify(cfg);
    if (fingerprint !== cacheFingerprint) {
      cache = createEvalCache({
        ttlSec: cfg.eval.cache.ttl_sec,
        maxEntries: cfg.eval.cache.max_entries,
      });
      cacheFingerprint = fingerprint;
    }
    return cfg.eval;
  };

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
        // Provider-specific passthrough (config.extra_body) FIRST so the locked
        // fields below always win — extra_body can add knobs (e.g. thinking:
        // disabled) but can never override model/temperature/stream/max_tokens.
        ...(modelReq.extra_body ?? {}),
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
    // Eval self-cost (docs/07; SEPARATE from completion cost, principle 5; NEVER
    // a key/payload). resolveCostUsd is the single override-or-preset rule: prefer
    // an upstream-BILLED cost the eval call returned (`usage.cost_usd` / OpenRouter
    // `usage.cost` / top-level `cost_usd`); otherwise convert the eval call's OWN
    // token usage × the catalog pricing for the eval model. Missing both → null
    // (unknown, not a measured 0), no crash.
    const costUsd = resolveCostUsd(catalog?.get(modelReq.model)?.pricing, res);
    return { text, cost_usd: costUsd };
  };

  return async (req: InternalRequest, overrides?: ClassifyOverrides): Promise<Classification> => {
    // Read the LIVE classifier config (the RuleStore-backed value an admin may
    // have just edited) and re-key/rebuild the eval cache if it changed — this is
    // what makes admin edits hot-apply without a restart, while never serving a
    // verdict computed under the previous config (principle 2: config drives
    // behavior; principle 3: fail-open, the cache is an optimization not a source
    // of truth).
    const classifierConfig = getClassifierConfig();
    const evalCfg = syncCache(classifierConfig);
    const rulesCfg: ClassifierRulesConfig = classifierConfig.rules;

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
        // Thread the injected momentum store into Layer-1 so the engine reads/
        // writes session history keyed by metadata.conversation_id. The clock and
        // momentum config come from the adapter's own `now` and the LIVE rulesCfg
        // (TTL/window stay config-driven, principle 2). Absent store → omit deps
        // .momentum so the engine skips momentum entirely (fail-open, principle 3).
        const r = scoreRequest(req, {
          cfg: rulesCfg,
          approxTokens: tokens,
          momentum: momentum ? { store: momentum.store, now, cfg: rulesCfg } : undefined,
        });
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
      // Layer-1 gate confidence, kept even when the eval verdict replaced
      // `confidence` above — the Debug UI shows WHY the cascade escalated.
      rules_confidence: result.rules_confidence,
      decided_by: result.decided_by,
      eval_cache_hit: result.eval_used ? result.eval_cache_hit : null,
      // Layer-2 self-cost, threaded into cost_breakdown.eval_usd (separate from
      // completion cost; docs/07). Non-null only when a fresh eval call billed it.
      eval_usd: result.eval_usd,
      // The eval model id + call latency, surfaced for the Debug UI. The model name
      // lives ONLY here (the cascade is model-agnostic), so stamp it whenever eval
      // actually ran — covering both a decided eval and one that ran then failed open
      // (result.eval_used is true in both). null when eval never ran.
      eval_model: result.eval_used ? evalCfg.model : null,
      eval_latency_ms: result.eval_latency_ms,
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
