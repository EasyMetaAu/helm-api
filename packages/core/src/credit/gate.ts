import type { CreditStore } from "../store/ports.js";
import type { CreditCheckResult, CreditConfig, CreditProbe } from "./types.js";

export interface CreditGateDeps {
  config: CreditConfig;
  store: Pick<CreditStore, "getBalance">;
}

const ALLOWED: CreditCheckResult = {
  allowed: true,
  limitedBy: null,
  alert: false,
  balance: null,
  quota: null,
};

// Resolve the effective quota after the account row has been read. The account
// row is authoritative; the probe value exists for tests/legacy callers only.
// 0 is a real value (explicitly unlimited), NOT "inherit".
function resolveQuota(
  config: CreditConfig,
  account: { quota: number | null } | null,
  probe: CreditProbe,
): number {
  return account?.quota ?? probe.quota ?? config.defaultQuotaUsd;
}

// Build the pre-request credit gate. core-only: pure logic + a Store port, no web
// framework (principle 1). FAIL-CLOSED boundary — a getBalance error PROPAGATES
// (the middleware turns it into a 5xx), never a silent "unlimited" pass. The gate
// does a PURE BALANCE SIGN CHECK (D5): balance > 0 ⇒ serve; balance ≤ 0 ⇒ over
// quota. It does NOT pre-estimate the request's cost (unlike the limiter's TPM
// pre-debit) — a single in-flight request may push the balance slightly negative,
// settled post-served by the ledger. Zero-touch fast path only when credits are
// disabled or identity is absent; otherwise the account row is read so
// account.credit_quota_usd can override the default. When over quota: "reject" ⇒
// !allowed; "alert" ⇒ allowed + alert flag (soft, balance may go negative).
export function createCreditGate(deps: CreditGateDeps): {
  check(probe: CreditProbe): Promise<CreditCheckResult>;
} {
  const { config, store } = deps;

  async function check(probe: CreditProbe): Promise<CreditCheckResult> {
    // Master switch off, or no identity to meter → zero-touch (no store read).
    if (!config.enabled || probe.accountId === null) return ALLOWED;

    // Read the live balance before resolving quota: account.credit_quota_usd is
    // the authoritative override (including 0 = unlimited).
    const account = await store.getBalance(probe.accountId);
    const quota = resolveQuota(config, account, probe);
    if (quota <= 0) return ALLOWED;

    // A missing account row is treated as a zero balance under the resolved quota
    // (provisioned lazily on first debit) — never a crash, never implicit credit.
    const balance = account?.balance ?? 0;
    const disabled = account?.disabled ?? false;

    const overQuota = disabled || balance <= 0;
    if (!overQuota) {
      return { allowed: true, limitedBy: null, alert: false, balance, quota };
    }

    // Over quota. alert mode serves the request but flags it (soft); reject mode
    // is a hard stop. A disabled account is always a hard stop regardless of mode.
    if (config.overQuotaBehavior === "alert" && !disabled) {
      return { allowed: true, limitedBy: null, alert: true, balance, quota };
    }
    return { allowed: false, limitedBy: "credit", alert: false, balance, quota };
  }

  return { check };
}
