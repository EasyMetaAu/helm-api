// Per-key usage budgets (docs/06). Pure logic + Store port, framework-agnostic
// (principle 1). The pre-route gate is fail-CLOSED (a peek error propagates); the
// post-served settle is fail-OPEN (the caller swallows store failures). Exceeding
// a budget DEGRADES the request to a cheaper lane by default (keep serving), or
// REJECTS (429) per the key's over_budget_behavior.
export {
  activeDims,
  type BudgetGateDeps,
  type BudgetProbe,
  createBudgetGate,
  windowMsFor,
} from "./gate.js";
export { type SettleBudgetDeps, settleBudget } from "./settle.js";
export type {
  BudgetCaps,
  BudgetCheckResult,
  BudgetConfig,
  BudgetUsage,
  OverBudgetBehavior,
} from "./types.js";
