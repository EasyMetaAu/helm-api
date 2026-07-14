import type { DecisionRecord } from "@helm/shared";

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
