import { type AccountView, listAccounts } from '$lib/api/accounts.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the account list with live balances. On failure resolve to an
// error state rather than throwing — the page must never white-screen (DoD).
export const load: PageLoad = async (): Promise<{
  accounts: AccountView[] | null;
  loadError?: string;
}> => {
  try {
    return { accounts: await listAccounts() };
  } catch (e) {
    return {
      accounts: null,
      loadError: e instanceof Error ? e.message : 'Failed to load accounts',
    };
  }
};
