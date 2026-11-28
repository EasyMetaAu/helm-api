import type {
  AttemptErrorDetail,
  ServingAccountView,
} from "$lib/api/request-trail.js";

export function accountPseudonym(
  value: string,
  label: (id: string) => string,
): string {
  return /^acct_[a-f0-9]{24}$/.test(value) ? label(value.slice(5, 13)) : value;
}

export function servingAccountLabel(
  account: ServingAccountView,
  label: (id: string) => string,
): string {
  const pseudonym = accountPseudonym(account.account, label);
  if (pseudonym !== account.account) return pseudonym;
  return account.kind === "api_key" ? (account.label ?? "—") : account.account;
}

export function isCodexCreditPromoRestriction(
  detail: AttemptErrorDetail | null,
): boolean {
  const raw = detail?.provider_raw;
  if (raw === null || typeof raw !== "object") return false;
  const error = (raw as Record<string, unknown>).error;
  return (
    error !== null &&
    typeof error === "object" &&
    (error as Record<string, unknown>).code ===
      "codex_byok_restricted_by_api_credit_promo"
  );
}
