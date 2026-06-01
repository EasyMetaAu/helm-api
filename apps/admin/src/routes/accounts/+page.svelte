<script lang="ts">
  import { untrack } from 'svelte';
  import { type AccountView, listAccounts, topupAccount } from '$lib/api/accounts.js';
  import { t } from '$lib/i18n';

  // Accounts — account credit balances + operator top-up (Issue #37). Pure
  // consumer (Principle 1): the gateway owns balances + the authoritative ledger.
  let { data }: { data: { accounts: AccountView[] | null; loadError?: string } } = $props();

  let accounts = $state<AccountView[]>(untrack(() => data.accounts ?? []));
  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let busyId = $state<string | null>(null);
  // Per-account topup amount entry (keyed by account_id).
  let topupAmount = $state<Record<string, number>>({});

  async function refresh(): Promise<void> {
    try {
      accounts = await listAccounts();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to load accounts');
    }
  }

  async function handleTopup(accountId: string): Promise<void> {
    const amount = topupAmount[accountId];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return;
    error = null;
    busyId = accountId;
    try {
      await topupAccount(accountId, amount);
      topupAmount[accountId] = 0;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to top up');
    } finally {
      busyId = null;
    }
  }

  function fmtUsd(n: number): string {
    return `$${n.toFixed(4)}`;
  }
  function fmtQuota(q: number | null): string {
    if (q === null) return $t('Default');
    if (q === 0) return $t('Unlimited');
    return fmtUsd(q);
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <h1 class="page-title">{$t('Accounts')}</h1>
    <p class="section-desc">
      {$t('Account credit balances. Top up or adjust an account here.')}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
  {/if}

  {#if data.accounts}
    <div class="card overflow-x-auto">
      <table class="w-full text-sm" data-testid="accounts-table">
        <thead>
          <tr class="text-left text-slate-500">
            <th class="px-2 py-2">{$t('Account')}</th>
            <th class="px-2 py-2">{$t('Balance')}</th>
            <th class="px-2 py-2">{$t('Quota')}</th>
            <th class="px-2 py-2">{$t('Top up / adjust (USD)')}</th>
          </tr>
        </thead>
        <tbody>
          {#each accounts as acct (acct.account_id)}
            <tr class="border-t border-slate-100" data-testid="account-row">
              <td class="px-2 py-2 font-mono">{acct.account_id}</td>
              <td class="px-2 py-2" data-testid="account-balance">{fmtUsd(acct.credit_balance_usd)}</td>
              <td class="px-2 py-2">{fmtQuota(acct.credit_quota_usd)}</td>
              <td class="px-2 py-2">
                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    class="input-sm w-28"
                    data-testid="topup-amount"
                    bind:value={topupAmount[acct.account_id]}
                  />
                  <button
                    class="btn-secondary"
                    data-testid="topup-button"
                    disabled={busyId === acct.account_id}
                    onclick={() => handleTopup(acct.account_id)}
                  >
                    {$t('Apply')}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
