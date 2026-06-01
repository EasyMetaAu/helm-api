// Admin Accounts API client (Issue #37). Pure consumer of the gateway's
// /admin/api/accounts surface (CLAUDE.md Principle 1) — imports NO core logic. The
// gateway is the single source of truth: balances live on the account row, spend
// is summed from the authoritative append-only credit_ledger. No key material is
// ever returned (principle 7).

export interface AccountView {
  account_id: string;
  name: string | null;
  credit_balance_usd: number;
  credit_quota_usd: number | null; // null = inherit default / 0 = unlimited
  disabled: boolean;
  created_at: number;
}

export interface SpendView {
  account_id: string;
  from: number;
  to: number;
  spend_usd: number;
}

const BASE = '/admin/api/accounts';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`accounts api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// GET /accounts -> the account list with live balances.
export async function listAccounts(): Promise<AccountView[]> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  return asJson<AccountView[]>(res);
}

// GET /accounts/:id/spend?from=&to= -> the summed spend over the window.
export async function getSpend(accountId: string, from: number, to: number): Promise<SpendView> {
  const url = `${BASE}/${encodeURIComponent(accountId)}/spend?from=${from}&to=${to}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return asJson<SpendView>(res);
}

// POST /accounts/:id/topup { amount_usd } -> apply a topup (positive) or manual
// adjustment (negative). Returns the new balance.
export async function topupAccount(
  accountId: string,
  amountUsd: number,
): Promise<{ account_id: string; balance_after_usd: number }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(accountId)}/topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount_usd: amountUsd }),
  });
  return asJson<{ account_id: string; balance_after_usd: number }>(res);
}
