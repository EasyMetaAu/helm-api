import type { AttemptErrorDetail, ServingAccountView } from '$lib/api/requests.js';

export function servingAccountLabel(account: ServingAccountView): string {
  return account.kind === 'api_key' ? (account.label ?? '—') : account.account;
}

export function isCodexCreditPromoRestriction(detail: AttemptErrorDetail | null): boolean {
  const raw = detail?.provider_raw;
  if (raw === null || typeof raw !== 'object') return false;
  const error = (raw as Record<string, unknown>).error;
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as Record<string, unknown>).code === 'codex_byok_restricted_by_api_credit_promo'
  );
}
