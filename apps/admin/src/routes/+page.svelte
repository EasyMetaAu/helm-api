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
        return 'badge-rules';
      case 'eval':
        return 'badge-eval';
      case 'fallback':
        return 'badge-fallback';
      default:
        return 'badge-neutral';
    }
  }

  const cards = [
    {
      seg: 'requests',
      label: 'Requests',
      desc: 'See the full decision trail for every request the gateway handled.',
    },
    {
      seg: 'lanes',
      label: 'Lanes',
      desc: 'Set the primary model and fallback chain for each quality and cost tier.',
    },
    {
      seg: 'policies',
      label: 'Policies',
      desc: 'Add match rules that force a lane or cap the highest lane a request may use.',
    },
    {
      seg: 'classifier',
      label: 'Classifier',
      desc: 'Tune how requests are sorted into lanes, by rules or optional small-model eval.',
    },
    {
      seg: 'keys',
      label: 'API Keys',
      desc: 'Issue and revoke client keys, and cap the top lane each key may reach.',
    },
  ];
</script>

<div class="w-full px-4 py-6 md:px-8 md:py-8">
  <header class="mb-6">
    <h1 class="page-title">{$t('Overview')}</h1>
    <p class="section-desc mt-1">
      {$t(
        'A live snapshot of how the gateway is routing requests right now, plus shortcuts to manage it.',
      )}
    </p>
  </header>

  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Requests')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{stats.total}</div>
    </div>
    <div class="card">
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
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Avg latency')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {stats.avgLatency === null ? '—' : `${stats.avgLatency}ms`}
      </div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Spend')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">${stats.totalCost.toFixed(4)}</div>
    </div>
  </div>

  <!-- Recent requests -->
  <section class="mt-8">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="section-header">{$t('Recent requests')}</h2>
      <a class="link-inline text-sm font-medium" href={`${base}/requests`}>
        {$t('View all')} →
      </a>
    </div>
    <p class="section-desc mb-3">
      {$t('The latest requests and how the gateway picked a lane for each one.')}
    </p>

    <!-- Legend explaining how the lane was decided -->
    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
      <span class="font-medium text-slate-600">{$t('Decided by:')}</span>
      <span class="inline-flex items-center gap-1.5">
        <span class="badge-rules">{$t('rules')}</span>
        <span>{$t('deterministic Layer-1 rules')}</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="badge-eval">{$t('eval')}</span>
        <span>{$t('small-model Layer-2 evaluation')}</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="badge-fallback">{$t('fallback')}</span>
        <span>{$t('defaulted to the balanced lane')}</span>
      </span>
    </div>

    {#if recent.length === 0}
      <div class="empty-state">
        {$t(
          'No requests recorded yet. Point a client at the gateway to see routing activity here.',
        )}
      </div>
    {:else}
      <div class="table-wrap">
        <table class="table-base">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2 font-medium">{$t('Requested')}</th>
              <th class="px-3 py-2 font-medium">{$t('Decided by')}</th>
              <th class="px-3 py-2 font-medium">{$t('Lane')}</th>
              <th class="px-3 py-2 font-medium">{$t('Final model')}</th>
              <th class="px-3 py-2 font-medium">{$t('Status')}</th>
              <th class="px-3 py-2 text-right font-medium">{$t('Latency')}</th>
              <th class="px-3 py-2 text-right font-medium">{$t('Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {#each recent as r (r.trace_id)}
              <tr class="table-row">
                <td class="px-3 py-2 text-slate-700">{r.requested_model ?? '—'}</td>
                <td class="px-3 py-2">
                  <span
                    class={decidedByClass(r.decided_by)}
                    title={r.decided_by === 'rules'
                      ? $t('Chosen by deterministic Layer-1 rules.')
                      : r.decided_by === 'eval'
                        ? $t('Chosen by the Layer-2 small-model evaluator.')
                        : r.decided_by === 'fallback'
                          ? $t('No rule matched, so it defaulted to the balanced lane.')
                          : ''}>{r.decided_by}</span
                  >
                </td>
                <td class="px-3 py-2 text-slate-700">{r.lane || '—'}</td>
                <td class="px-3 py-2 font-mono text-xs text-slate-600">{r.final_model ?? '—'}</td>
                <td class="px-3 py-2">
                  {#if r.status === 'error'}
                    <span class="badge-error">{$t('error')}</span>
                  {:else}
                    <span class="badge-ok">{$t('ok')}</span>
                  {/if}
                </td>
                <td class="px-3 py-2 text-right text-slate-500">{r.latency_ms}ms</td>
                <td class="px-3 py-2 text-right font-mono text-slate-600"
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
    <h2 class="section-header mb-1">{$t('Manage')}</h2>
    <p class="section-desc mb-3">
      {$t('Jump into the settings that control how the gateway routes traffic.')}
    </p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each cards as c (c.seg)}
        <a
          href={`${base}/${c.seg}`}
          class="card group flex items-center justify-between transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          <div>
            <div class="text-sm font-semibold text-slate-900">{$t(c.label)}</div>
            <div class="mt-0.5 text-xs text-slate-500">{$t(c.desc)}</div>
          </div>
          <span class="text-slate-300 transition-colors group-hover:text-sky-500">→</span>
        </a>
      {/each}
    </div>
  </section>
</div>
