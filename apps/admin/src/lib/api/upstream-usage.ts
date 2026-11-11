import { OAuthUsagePeriodsSchema, UpstreamProviderUsageSchema } from '@helm/shared';
import { clientTzOffsetMinutes } from '$lib/requests-filters.js';

const BASE = '/admin/api/upstream/provider-usage';
export async function getUpstreamUsage() {
  const response = await fetch(`${BASE}?tzOffsetMinutes=${clientTzOffsetMinutes()}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Upstream usage is unavailable');
  return UpstreamProviderUsageSchema.parse(await response.json());
}
export async function getUpstreamUsagePeriods(provider: string, account: string) {
  const query = new URLSearchParams({
    provider,
    account,
    tzOffsetMinutes: String(clientTzOffsetMinutes()),
  });
  const response = await fetch(`${BASE}/periods?${query}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Upstream usage history is unavailable');
  return OAuthUsagePeriodsSchema.parse(await response.json());
}
