import { listRequests, type RequestListItem } from '$lib/api/requests.js';
import type { PageLoad } from './$types.js';

// Dashboard load (SPA, client-side): pull the most-recent request rows and derive
// at-a-glance stats. Fail-soft — a fresh gateway with no telemetry (or an admin
// API hiccup) shows an empty dashboard rather than an error page.
export const load: PageLoad = async () => {
  let items: RequestListItem[] = [];
  try {
    const res = await listRequests();
    items = res.items;
  } catch {
    items = [];
  }

  const total = items.length;
  const ok = items.filter((r) => r.status !== 'error').length;
  const errors = total - ok;
  const successRate = total === 0 ? null : Math.round((ok / total) * 100);
  const avgLatency =
    total === 0 ? null : Math.round(items.reduce((s, r) => s + (r.latency_ms || 0), 0) / total);
  const totalCost = items.reduce((s, r) => s + (r.cost_usd || 0), 0);

  return { items, stats: { total, ok, errors, successRate, avgLatency, totalCost } };
};
