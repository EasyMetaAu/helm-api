import type { DecisionRecord } from "@helm/shared";
import type { CreditMovementResult, CreditStore } from "../store/ports.js";

export interface DebitForDecisionInput {
  decision: DecisionRecord;
  accountId: string;
  apiKeyId: string;
  nowMs: number;
}

// Post-served ledger debit (Issue #37, fail-OPEN side). Charges an account for a
// SERVED request using the SAME `cost_breakdown.total_usd` already computed by the
// telemetry pipeline (resolveCostUsd, billed-over-estimate) — NEVER recomputes the
// cost (D6: single source of truth). A null total_usd means "not measured"
// (pricing unknown, distinct from a measured 0): per D4 we debit 0 and flag
// cost_measured=false so under-billed requests are auditable later — we NEVER
// block or skip a served request over a null cost (that would break the fail-open
// envelope this runs inside). The caller wraps this in a try/catch so a store
// failure is logged, never 5xx's a request that already completed.
export async function debitForDecision(
  store: Pick<CreditStore, "debit">,
  input: DebitForDecisionInput,
): Promise<CreditMovementResult> {
  const total = input.decision.cost_breakdown.total_usd;
  const measured = total !== null;
  const amount = measured ? total : 0;
  // Signed: a debit lowers the balance. Normalize a 0 cost to +0 (avoid -0 from
  // negation) so a measured/unknown zero reads cleanly in the ledger.
  const signedAmount = amount === 0 ? 0 : -amount;

  return store.debit({
    accountId: input.accountId,
    requestId: input.decision.request_id,
    apiKeyId: input.apiKeyId, // key_id only (principle 7)
    amountUsd: signedAmount,
    kind: "debit",
    costMeasured: measured,
    nowMs: input.nowMs,
  });
}
