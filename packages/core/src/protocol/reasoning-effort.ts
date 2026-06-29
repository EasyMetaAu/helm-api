import type { TargetProviderProtocol } from "@helm/shared";
import { reasoningEffortToThinkingConfig } from "./gemini/gemini-transformer.js";
import type { IRReasoningEffort } from "./ir.js";

// —— Lane-FORCED reasoning effort → upstream wire mapping ————————————————————————
// When a lane pins `reasoning_effort` (config-as-code), the router overwrites the
// request's effort and the gateway must apply it to the OUTBOUND wire across all
// four protocols. The TRANSLATED path reuses each protocol's existing reasoning
// out-mapping (it just forwards req.reasoning_effort). This module covers the
// NATIVE-PASSTHROUGH path (rewrite the verbatim body's reasoning field) and the one
// mapping helm lacked: reasoning_effort → Anthropic extended `thinking`.
//
// Pure + framework-free (CLAUDE.md principle 1); single-unit-testable (principle 4).

// Anthropic extended-thinking budget per effort tier. Anthropic requires
// `budget_tokens >= 1024`; `none` (and anything unrecognized) disables thinking.
// Monotonically increasing; the top tiers sit at a safe ceiling across models.
const ANTHROPIC_THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
};

// Output headroom added ON TOP of the thinking budget so `max_tokens` always
// exceeds `budget_tokens` (Anthropic 400s otherwise — max_tokens counts thinking).
const ANTHROPIC_OUTPUT_HEADROOM = 8192;

export interface AnthropicThinking {
  type: "enabled";
  budget_tokens: number;
}

export type ForcedReasoningSkipReason = "forced_tool_choice";

export interface ApplyForcedReasoningResult {
  body: Record<string, unknown>;
  mutated: boolean;
  skippedReason?: ForcedReasoningSkipReason;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function anthropicToolChoiceForcesUse(body: Record<string, unknown>): boolean {
  const toolChoice = body.tool_choice;
  return (
    toolChoice === "any" ||
    (isRecord(toolChoice) && (toolChoice.type === "any" || toolChoice.type === "tool"))
  );
}

function stripAnthropicThinkingForForcedToolChoice(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  mutated: boolean;
} {
  if (body.thinking === undefined) return { body, mutated: false };
  const next = { ...body };
  delete next.thinking;
  delete next.context_management;
  return { body: next, mutated: true };
}

/** effort → Anthropic thinking block; `none`/unrecognized → undefined (disabled). */
export function reasoningEffortToAnthropicThinking(effort: string): AnthropicThinking | undefined {
  const budget = ANTHROPIC_THINKING_BUDGET[effort];
  if (budget === undefined) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

/**
 * Apply a forced reasoning effort to an Anthropic-shaped body (returns a new body).
 * Extended thinking imposes constraints we MUST satisfy when WE inject it (the client
 * didn't ask for it): `max_tokens > budget_tokens`, `temperature` must be 1, and
 * `top_p`/`top_k` must be unset. `none` removes any client thinking and leaves the
 * sampling params untouched. Used by BOTH the translated and passthrough Anthropic
 * paths so they behave identically.
 */
export function applyForcedAnthropicThinking(
  body: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  const next = { ...body };
  const thinking = reasoningEffortToAnthropicThinking(effort);
  if (thinking === undefined) {
    delete next.thinking; // force "none": disable thinking, keep sampling as-is.
    return next;
  }
  next.thinking = thinking;
  const currentMax = typeof next.max_tokens === "number" ? next.max_tokens : 0;
  next.max_tokens = Math.max(currentMax, thinking.budget_tokens + ANTHROPIC_OUTPUT_HEADROOM);
  next.temperature = 1; // extended thinking requires temperature=1 and no top_p/top_k.
  delete next.top_p;
  delete next.top_k;
  return next;
}

/**
 * Rewrite a NATIVE passthrough body's reasoning field to a forced effort, protocol-
 * aware. Only the three passthrough-eligible wires are handled — `openai_chat` is the
 * lingua franca and never passes through (so it's a no-op here; its forced effort is
 * applied on the translated path via req.reasoning_effort). Returns a new body and a
 * `mutated` flag for the carrier mutation ledger.
 */
export function applyForcedReasoningToNativeBody(
  body: Record<string, unknown>,
  protocol: TargetProviderProtocol,
  effort: string,
): ApplyForcedReasoningResult {
  switch (protocol) {
    case "gemini": {
      const tc = reasoningEffortToThinkingConfig(effort as IRReasoningEffort);
      if (tc === undefined) return { body, mutated: false };
      const prev =
        typeof body.generationConfig === "object" && body.generationConfig !== null
          ? (body.generationConfig as Record<string, unknown>)
          : {};
      // Replace thinkingConfig WHOLESALE (drop any client thinkingLevel) but keep the
      // rest of generationConfig (responseMimeType, schema, sampling, …).
      return {
        body: { ...body, generationConfig: { ...prev, thinkingConfig: tc } },
        mutated: true,
      };
    }
    case "openai_responses": {
      const next = { ...body };
      if (effort === "none") delete next.reasoning;
      else next.reasoning = { effort };
      return { body: next, mutated: true };
    }
    case "anthropic_messages": {
      if (effort !== "none" && anthropicToolChoiceForcesUse(body)) {
        const stripped = stripAnthropicThinkingForForcedToolChoice(body);
        return { ...stripped, skippedReason: "forced_tool_choice" };
      }
      return { body: applyForcedAnthropicThinking(body, effort), mutated: true };
    }
    default:
      return { body, mutated: false }; // openai_chat: never passes through.
  }
}
