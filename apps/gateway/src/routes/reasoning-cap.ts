import {
  ANTHROPIC_THINKING_BUDGET,
  applyForcedAnthropicThinking,
  applyForcedReasoningToNativeBody,
  GEMINI_REASONING_EFFORT_BUDGET,
  IR_REASONING_EFFORTS,
  type IRReasoningEffort,
} from "@helm/core";
import {
  appendMutationList,
  cloneCarrierWithBody,
  type InternalRequest,
  isNativePassthroughCarrier,
  type NativePassthroughCarrier,
} from "@helm/shared";

// —— Per-API-key CEILING on client-requested reasoning effort (cost control) ————————
// A key may cap the highest effort tier it may use. If a CLIENT asks for more, we
// clamp DOWN to the cap before the request leaves the gateway. This is the sibling
// of downgradeClientFastModeIfDisallowed (fast-mode.ts): same shape, same call
// sites, same native-passthrough carrier handling. It mutates BOTH the normalized
// `reasoning_effort` (translated / OpenAI-chat path) and the native passthrough body
// (Anthropic thinking / Gemini thinkingConfig / OpenAI Responses reasoning.effort).
//
// ponytail: lane/policy-FORCED effort is deliberately NOT capped here — force is
// operator config-as-code and runs AFTER this clamp (route-request.ts), so it wins.
// This bounds the CLIENT only. Add a post-force re-clamp only if a real key needs an
// absolute ceiling over operator forcing.

/** Ordinal rank of an effort tier (higher = more effort). -1 for unknown strings. */
function rank(effort: string): number {
  return (IR_REASONING_EFFORTS as readonly string[]).indexOf(effort);
}

/**
 * Does a client-requested effort STRING exceed the cap? An UNKNOWN string (rank -1,
 * e.g. a future/typo tier the request path would normalize to "high") is treated as
 * OVER any cap — never silently under it, which would be a bypass. Equal ranks and
 * genuinely-lower ranks are under the cap.
 */
function effortExceedsCap(effort: string, capRank: number): boolean {
  const r = rank(effort);
  return r < 0 || r > capRank;
}

/**
 * Does a client thinking-BUDGET (Anthropic/Gemini token count) exceed the cap tier's
 * budget? A NEGATIVE budget is a sentinel for "dynamic/unbounded" thinking (Gemini
 * uses -1) — always over cap. Non-finite is treated the same (fail-closed).
 */
function budgetExceedsCap(budget: number, capBudget: number): boolean {
  if (!Number.isFinite(budget)) return true;
  if (budget < 0) return true; // dynamic/unbounded (e.g. Gemini thinkingBudget:-1)
  return budget > capBudget;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Gemini's discrete thinkingLevel enum → the equivalent IR effort tier, so a level
// can be rank-compared against the cap (clamp DOWN only, never raise a lower level).
const GEMINI_THINKING_LEVEL_TO_EFFORT: Record<string, IRReasoningEffort> = {
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

/**
 * Does a Gemini thinkingLevel string exceed the cap? A KNOWN level below/at the cap is
 * under it (leave the client's cheaper choice alone). An UNKNOWN level is over-cap
 * (fail-closed — never a silent bypass).
 */
function thinkingLevelExceedsCap(level: string, capRank: number): boolean {
  const effort = GEMINI_THINKING_LEVEL_TO_EFFORT[level.toUpperCase()];
  if (effort === undefined) return true; // unknown level → fail-closed
  return rank(effort) > capRank;
}

/**
 * Does an Anthropic client `thinking` object exceed the cap? Enabled thinking with a
 * numeric budget over the tier's ceiling is over-cap; an enabled thinking object with
 * NO usable numeric budget (e.g. `{type:"adaptive"}` or a missing/non-finite budget)
 * is ALSO over-cap when the cap constrains thinking — fail-closed so an unbudgeted
 * thinking mode can't slip past. A thinking object whose type is "disabled"/"none"
 * (or absent) is never over-cap.
 */
function anthropicThinkingExceedsCap(
  thinking: Record<string, unknown>,
  cap: IRReasoningEffort,
): boolean {
  const type = typeof thinking.type === "string" ? thinking.type : undefined;
  if (type === "disabled" || type === "none") return false;
  const capBudget = ANTHROPIC_THINKING_BUDGET[cap] ?? 0;
  const budget = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined;
  // No usable numeric budget on an enabled thinking object → treat as over-cap.
  if (budget === undefined) return true;
  return budgetExceedsCap(budget, capBudget);
}

/**
 * Clamp an Anthropic `output_config` object's effort STRING to the cap. Anthropic's
 * outbound path prefers an explicit `output_config.effort` over the derived
 * `reasoning_effort`, so this vector must be capped independently. Returns a new
 * output_config (or undefined for "none" — clears effort) when it changed, else null.
 */
function clampOutputConfigEffort(
  outputConfig: Record<string, unknown>,
  cap: IRReasoningEffort,
  capRank: number,
): Record<string, unknown> | undefined | null {
  const effort = typeof outputConfig.effort === "string" ? outputConfig.effort : undefined;
  if (effort === undefined || !effortExceedsCap(effort, capRank)) return null; // unchanged
  const next = { ...outputConfig };
  if (cap === "none") {
    delete next.effort;
    return next;
  }
  next.effort = cap;
  return next;
}

/** Clamp the native carrier body to `cap` per protocol; undefined if nothing changed. */
function clampNativeBody(
  carrier: NativePassthroughCarrier,
  cap: IRReasoningEffort,
): Record<string, unknown> | undefined {
  const body = carrier.body;
  const capRank = rank(cap);

  switch (carrier.protocol) {
    case "openai_responses": {
      // Client effort is a plain string in reasoning.effort. Clamp on rank (an
      // unknown/future tier counts as over-cap — never a silent bypass).
      const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
      const effort = typeof reasoning?.effort === "string" ? reasoning.effort : undefined;
      if (effort === undefined || !effortExceedsCap(effort, capRank)) return undefined;
      return applyForcedReasoningToNativeBody(body, carrier.protocol, cap).body;
    }
    case "anthropic_messages": {
      // Anthropic client effort rides TWO vectors, both capped:
      //  - thinking.budget_tokens (number) OR an enabled thinking object with no usable
      //    budget (e.g. {type:"adaptive"}) — over-cap, rewritten to the cap tier;
      //  - output_config.effort (string) — the outbound path prefers explicit
      //    output_config over derived effort, so it's clamped independently.
      const thinking = isRecord(body.thinking) ? body.thinking : undefined;
      const thinkingOver = thinking !== undefined && anthropicThinkingExceedsCap(thinking, cap);
      const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
      const clampedOutputConfig =
        outputConfig !== undefined ? clampOutputConfigEffort(outputConfig, cap, capRank) : null;
      if (!thinkingOver && clampedOutputConfig === null) return undefined;
      // applyForcedReasoningToNativeBody sets thinking to the cap tier's budget (or
      // strips it for "none") and repairs max_tokens/temperature. Then overlay the
      // clamped output_config (the writer doesn't touch it).
      let out = thinkingOver
        ? applyForcedReasoningToNativeBody(body, carrier.protocol, cap).body
        : { ...body };
      if (clampedOutputConfig !== null) {
        out = { ...out };
        if (clampedOutputConfig === undefined) delete out.output_config;
        else out.output_config = clampedOutputConfig;
      }
      return out;
    }
    case "gemini": {
      // Client effort rides as generationConfig.thinkingConfig — either a numeric
      // thinkingBudget (incl. -1 = dynamic/unbounded) OR a thinkingLevel string. Both
      // are capped: a budget over the tier OR any thinkingLevel present triggers a
      // wholesale rewrite to the cap tier's thinkingConfig.
      const genConfig = isRecord(body.generationConfig) ? body.generationConfig : undefined;
      const thinkingConfig = isRecord(genConfig?.thinkingConfig)
        ? genConfig.thinkingConfig
        : undefined;
      if (thinkingConfig === undefined) return undefined;
      const budget =
        typeof thinkingConfig.thinkingBudget === "number"
          ? thinkingConfig.thinkingBudget
          : undefined;
      const capBudget = GEMINI_REASONING_EFFORT_BUDGET[cap];
      const budgetOver = budget !== undefined && budgetExceedsCap(budget, capBudget);
      // A thinkingLevel is rank-compared to the cap: only clamp when it EXCEEDS the cap
      // (a client asking for a LOWER level than the cap keeps its cheaper choice — the
      // cap is a ceiling, never a floor). An unknown level is fail-closed (over-cap).
      const levelOver =
        typeof thinkingConfig.thinkingLevel === "string" &&
        thinkingLevelExceedsCap(thinkingConfig.thinkingLevel, capRank);
      if (!budgetOver && !levelOver) return undefined;
      return applyForcedReasoningToNativeBody(body, carrier.protocol, cap).body;
    }
    default:
      return undefined;
  }
}

/**
 * Enforce a key's max reasoning-effort ceiling on a CLIENT request. No cap
 * (undefined/null) => unchanged. Returns a new InternalRequest only when a clamp
 * actually happens (mirrors downgradeClientFastModeIfDisallowed's referential
 * behavior); otherwise returns `req` untouched.
 */
export function clampClientReasoningEffortToKeyMax(
  req: InternalRequest,
  maxEffort: IRReasoningEffort | null | undefined,
): InternalRequest {
  if (maxEffort === null || maxEffort === undefined) return req;
  const capRank = rank(maxEffort);
  if (capRank < 0) return req; // defensive: an unknown cap value caps nothing.
  let next = req;

  // 1) Normalized effort (translated / OpenAI-chat path). An unknown client tier is
  // over-cap (never a silent bypass).
  if (typeof req.reasoning_effort === "string" && effortExceedsCap(req.reasoning_effort, capRank)) {
    next = { ...next, reasoning_effort: maxEffort };
  }

  // 2) IR-level Anthropic `thinking` (translated path). thinkingFromIR forwards an
  // explicit client thinking config VERBATIM ("explicit wins"), so an over-cap thinking
  // config (numeric budget over the tier, OR an enabled mode with no usable budget)
  // must be clamped on the IR field too — the reasoning_effort clamp above misses it.
  // Route through applyForcedAnthropicThinking (same as the native path) so the enabled
  // thinking's constraints are satisfied: max_tokens > budget_tokens, temperature = 1,
  // no top_p/top_k. An Anthropic body violating these is a 400, and the outbound builder
  // forwards temperature/top_p/top_k + BOTH max fields verbatim.
  if (isRecord(next.thinking) && anthropicThinkingExceedsCap(next.thinking, maxEffort)) {
    // applyForcedAnthropicThinking sets thinking to the cap tier's block (or undefined
    // for "none" = disable) and, when enabled, exposes the budget-satisfying max_tokens
    // floor. We feed 0 as the current max purely to READ that floor back.
    const repaired = applyForcedAnthropicThinking(
      { thinking: next.thinking, max_tokens: 0 },
      maxEffort,
    );
    const patched: Partial<InternalRequest> = { thinking: repaired.thinking };
    // The max/sampling repairs only apply when thinking STAYS enabled. For "none" the
    // thinking is stripped entirely, so client max_tokens/sampling are left untouched
    // (seeding a max there — e.g. 0 when the client set none — would itself 400).
    if (repaired.thinking !== undefined && typeof repaired.max_tokens === "number") {
      const floor = repaired.max_tokens; // budget_tokens + output headroom
      // Raise each max field the client SET, independently, only if below the floor —
      // never introduce a field the client omitted, never equalize the two. The provider
      // path prefers max_completion_tokens, so both must individually clear the budget.
      if (next.max_tokens != null && next.max_tokens < floor) patched.max_tokens = floor;
      if (next.max_completion_tokens != null && next.max_completion_tokens < floor) {
        patched.max_completion_tokens = floor;
      }
      // Client set neither → seed max_tokens so the enabled budget is a valid body.
      if (next.max_tokens == null && next.max_completion_tokens == null) {
        patched.max_tokens = floor;
      }
      // Extended thinking forbids top_p/top_k and requires temperature 1.
      patched.temperature = 1;
      patched.top_p = undefined;
      patched.top_k = undefined;
    }
    next = { ...next, ...patched };
  }

  // 2b) IR-level Anthropic `provider_raw.output_config.effort` (translated path). The
  // Anthropic outbound builder PREFERS an explicit output_config over the derived
  // reasoning_effort, so a client output_config.effort above the cap bypasses step 1
  // unless clamped here too.
  if (isRecord(next.provider_raw) && isRecord(next.provider_raw.output_config)) {
    const clamped = clampOutputConfigEffort(next.provider_raw.output_config, maxEffort, capRank);
    if (clamped !== null) {
      const providerRaw = { ...next.provider_raw };
      if (clamped === undefined) delete providerRaw.output_config;
      else providerRaw.output_config = clamped;
      next = { ...next, provider_raw: providerRaw };
    }
  }

  // 3) Native passthrough carrier body (Anthropic / Gemini / Responses).
  const native = next.native_request;
  if (isNativePassthroughCarrier(native)) {
    const clampedBody = clampNativeBody(native, maxEffort);
    if (clampedBody !== undefined) {
      const carrier = cloneCarrierWithBody(native, clampedBody);
      appendMutationList(carrier.mutations, "body_shims_applied", [
        "client_reasoning_effort_capped",
      ]);
      next = { ...next, native_request: carrier };
    }
  }

  return next;
}
