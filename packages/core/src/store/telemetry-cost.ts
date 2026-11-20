import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import type { ApplyAsyncMediaCostInput } from "./ports.js";

// Current records carry the canonical eval + completion total. A few operator
// fixtures and legacy callers can still pass an unparsed pre-default record, so
// preserve the historical attempt sum only when cost_breakdown is truly absent.
// An explicit null total stays null: it means the complete cost is unknown.
export function denormalizedDecisionCost(decision: DecisionRecord): number | null {
  const costBreakdown = (
    decision as DecisionRecord & {
      cost_breakdown?: DecisionRecord["cost_breakdown"];
    }
  ).cost_breakdown;
  if (costBreakdown !== undefined) return costBreakdown.total_usd;

  return decision.provider_attempts.reduce<number | null>((sum, attempt) => {
    if (attempt.cost_usd === null) return sum;
    return (sum ?? 0) + attempt.cost_usd;
  }, null);
}

/** A single paid creation can accrue one asynchronously observed provider cost. */
export function withAsyncMediaCost(
  decision: DecisionRecord,
  input: ApplyAsyncMediaCostInput,
): DecisionRecord | null {
  const [attempt] = decision.provider_attempts;
  if (
    decision.request_id !== input.requestId ||
    decision.lane.selected_lane !== input.kind ||
    decision.provider_attempts.length !== 1 ||
    !attempt ||
    attempt.skipped ||
    attempt.alias !== input.providerAlias ||
    attempt.provider_name !== input.providerName ||
    attempt.provider_model !== input.providerModel ||
    (decision.serving_account?.account ?? null) !== input.providerAccount ||
    (decision.serving_account && decision.serving_account.provider_id !== input.providerName) ||
    decision.media_cost !== undefined ||
    decision.cost_breakdown.completion_usd !== null
  )
    return null;
  const { cost, completionTokens } = input;
  const evalUsd = decision.cost_breakdown.eval_usd;
  return DecisionRecordSchema.parse({
    ...decision,
    media_cost: cost,
    provider_attempts: [{ ...attempt, cost_usd: cost.cost_usd }],
    cost_breakdown: {
      eval_usd: evalUsd,
      completion_usd: cost.cost_usd,
      total_usd: cost.cost_usd === null ? null : cost.cost_usd + (evalUsd ?? 0),
    },
    ...(completionTokens === undefined
      ? {}
      : { usage: { ...decision.usage, completion_tokens: completionTokens } }),
  });
}

export function validAsyncMediaCostWindow(input: ApplyAsyncMediaCostInput): boolean {
  return (
    Number.isSafeInteger(input.taskCreatedAt) &&
    input.taskCreatedAt >= 0 &&
    Number.isSafeInteger(input.observedAt) &&
    input.observedAt >= input.taskCreatedAt &&
    input.observedAt <= 8_640_000_000_000_000
  );
}
