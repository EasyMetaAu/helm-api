<script lang="ts">
  import { base } from '$app/paths';
  import type { RequestListItem } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  type Stats = {
    total: number;
    ok: number;
    errors: number;
    successRate: number | null;
    avgLatency: number | null;
    totalCost: number;
  };

  let { data }: { data: { items: RequestListItem[]; stats: Stats } } = $props();

  const stats = $derived(data.stats);
  const recent = $derived(data.items.slice(0, 6));

  function decidedByClass(d: RequestListItem['decided_by']): string {
    switch (d) {
      case 'rules':
        return 'bg-sky-100 text-sky-700';
      case 'eval':
        return 'bg-violet-100 text-violet-700';
      case 'fallback':
        return 'bg-amber-100 text-amber-800';
      default:
        return 'bg-slate-200 text-slate-600';
    }
  }

  const cards = [
    { seg: 'requests', label: 'Requests', desc: 'Inspect every routing decision' },
    { seg: 'lanes', label: 'Lanes', desc: 'Primary → fallback chains' },
    { seg: 'policies', label: 'Policies', desc: 'Server-side routing rules' },
    { seg: 'classifier', label: 'Classifier', desc: 'Rules & small-model eval' },
    { seg: 'keys', label: 'API Keys', desc: 'Issue & revoke credentials' },
  ];
</script>

<div class="w-full px-4 py-6 md:px-8 md:py-8">
  <header class="mb-6">
    <h2 class="text-xl font-semibold tracking-tight text-slate-900">{$t('Overview')}</h2>
    <p class="mt-1 text-sm text-slate-500">
      {$t('Live routing activity across the gateway. Figures cover the most recent requests.')}
    </p>
  </header>

  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Requests')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{stats.total}</div>
    </div>
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Success rate')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {stats.successRate === null ? '—' : `${stats.successRate}%`}
      </div>
      <div class="mt-0.5 text-xs text-slate-400">
        {$t('Errors: {count}', { count: stats.errors })}
      </div>
    </div>
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Avg latency')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {stats.avgLatency === null ? '—' : `${stats.avgLatency}ms`}
      </div>
    </div>
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Spend')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">${stats.totalCost.toFixed(4)}</div>
    </div>
  </div>

  <!-- Recent requests -->
  <section class="mt-8">
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold text-slate-900">{$t('Recent requests')}</h3>
      <a class="text-sm font-medium text-indigo-600 hover:text-indigo-700" href={`${base}/requests`}>
        {$t('View all')} →
      </a>
    </div>

    {#if recent.length === 0}
      <div
        class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500"
      >
        {$t('No requests recorded yet. Point a client at the gateway to see routing activity here.')}
      </div>
    {:else}
      <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-4 py-2.5 font-medium">{$t('Requested')}</th>
              <th class="px-4 py-2.5 font-medium">{$t('Decided by')}</th>
              <th class="px-4 py-2.5 font-medium">{$t('Lane')}</th>
              <th class="px-4 py-2.5 font-medium">{$t('Final model')}</th>
              <th class="px-4 py-2.5 font-medium">{$t('Status')}</th>
              <th class="px-4 py-2.5 text-right font-medium">{$t('Latency')}</th>
              <th class="px-4 py-2.5 text-right font-medium">{$t('Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {#each recent as r (r.trace_id)}
              <tr class="border-t border-slate-50 hover:bg-slate-50/70">
                <td class="px-4 py-2.5 text-slate-700">{r.requested_model ?? '—'}</td>
                <td class="px-4 py-2.5">
                  <span
                    class="rounded px-2 py-0.5 text-xs font-medium {decidedByClass(r.decided_by)}"
                    >{r.decided_by}</span
                  >
                </td>
                <td class="px-4 py-2.5 text-slate-700">{r.lane || '—'}</td>
                <td class="px-4 py-2.5 font-mono text-xs text-slate-600">{r.final_model ?? '—'}</td>
                <td class="px-4 py-2.5">
                  {#if r.status === 'error'}
                    <span class="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                      >error</span
                    >
                  {:else}
                    <span
                      class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                      >ok</span
                    >
                  {/if}
                </td>
                <td class="px-4 py-2.5 text-right text-slate-500">{r.latency_ms}ms</td>
                <td class="px-4 py-2.5 text-right font-mono text-slate-600"
                  >${r.cost_usd.toFixed(4)}</td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- Quick links -->
  <section class="mt-8">
    <h3 class="mb-3 text-sm font-semibold text-slate-900">{$t('Manage')}</h3>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each cards as c (c.seg)}
        <a
          href={`${base}/${c.seg}`}
          class="group flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-indigo-200 hover:bg-indigo-50/40"
        >
          <div>
            <div class="text-sm font-semibold text-slate-900">{$t(c.label)}</div>
            <div class="mt-0.5 text-xs text-slate-500">{$t(c.desc)}</div>
          </div>
          <span class="text-slate-300 transition-colors group-hover:text-indigo-500">→</span>
        </a>
      {/each}
    </div>
  </section>
</div>
