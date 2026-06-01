// Account credit quotas / billing (Issue #37). Framework-agnostic (principle 1):
// pure gate logic + ledger debit + the Store port lives in core; only the
// middleware/route glue is in apps/gateway. The gate is fail-CLOSED (store-read
// error propagates → reject); the ledger debit is called inside a fail-OPEN
// envelope (a debit failure is logged, never 5xx's a served request).
export { type CreditGateDeps, createCreditGate } from "./gate.js";
export { type DebitForDecisionInput, debitForDecision } from "./ledger.js";
export type {
  CreditCheckResult,
  CreditConfig,
  CreditProbe,
  OverQuotaBehavior,
} from "./types.js";
