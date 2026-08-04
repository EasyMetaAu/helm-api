import { error } from '@sveltejs/kit';
import { getOAuthQuota, getOAuthUsagePeriods, type OAuthUsagePeriods } from '$lib/api/oauth.js';
import type { OAuthQuotaSnapshot } from '$lib/api/oauth.js';
import { decodeAccountId } from '$lib/oauth-account-id.js';
import type { PageLoad } from './$types.js';

// Account-detail load (SPA): the page is ABOUT one OAuth subscription account, so an
// undecodable :accountId is a 404. The reset-period rollup and the live quota
// snapshot are both SUPPLEMENTARY observability that fail SOFT (empty periods / no
// quota) rather than erroring the page — same fail-open posture as the providers list.

export interface AccountDetailData {
  providerId: string;
  account: string;
  periods: OAuthUsagePeriods;
  // The account's latest quota snapshot (usedPercent / resetsAtMs per window), or
  // null when none is cached. Drives the current-period Used% and reset countdown.
  quota: OAuthQuotaSnapshot | null;
}

export const load: PageLoad = async ({ params }): Promise<AccountDetailData> => {
  const decoded = decodeAccountId(params.accountId);
  if (!decoded) throw error(404, 'Unknown account');
  const { providerId, account } = decoded;

  const [periods, allQuota] = await Promise.all([
    getOAuthUsagePeriods(providerId, account),
    getOAuthQuota(),
  ]);
  const quota =
    allQuota.find((q) => q.providerId === providerId && q.account === account) ?? null;

  return { providerId, account, periods, quota };
};
