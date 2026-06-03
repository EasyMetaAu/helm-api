import { listRequests, type RequestListItem } from '$lib/api/requests.js';
import { parseRange, resolveWindow } from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// Dashboard load (SPA, client-side): read the date-range preset from the URL
// (?range=…, default 24h — a live dashboard cares about recent traffic), resolve
// it to an absolute window in client-local time (the gateway stays
// timezone-agnostic), and pull that window's recent rows to derive at-a-glance
// stats. A wider page (200) makes the sampled stats more representative than the
// 6-row preview; `total` is the real filtered count from the backend. Fail-soft —
// a fresh gateway with no telemetry (or an admin API hiccup) shows an empty
// dashboard rather than an error page. Re-runs on every navigation (range change /
// back-button) since it depends on `url`.
export const load: PageLoad = async ({ url }) => {
  const range = parseRange(url.searchParams.get('range'), '24h');
  const { start, end } = resolveWindow(range, Date.now());

  let items: RequestListItem[] = [];
  let total = 0;
  try {
    const res = await listRequests({ start, end, pageSize: 200 });
    items = res.items;
    total = res.total;
  } catch {
    items = [];
    total = 0;
  }

  const sample = items.length;
  const ok = items.filter((r) => r.status !== 'error').length;
  const errors = sample - ok;
  const successRate = sample === 0 ? null : Math.round((ok / sample) * 100);
  const avgLatency =
    sample === 0 ? null : Math.round(items.reduce((s, r) => s + (r.latency_ms || 0), 0) / sample);
  const totalCost = items.reduce((s, r) => s + (r.cost_usd || 0), 0);

  // `total` = real filtered count (may exceed the 200-row sample); rate/latency/spend
  // are derived from the sample, so they read as a recent-activity snapshot, not an
  // exact all-time aggregate (consistent with the dashboard's at-a-glance intent).
  return { items, range, stats: { total, ok, errors, successRate, avgLatency, totalCost } };
};
