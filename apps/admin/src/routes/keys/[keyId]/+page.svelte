<script lang="ts">
  import { untrack } from 'svelte';
  import { AreaChart, PieChart } from 'layerchart';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import type { ApiKeyView } from '$lib/api/keys.js';
  import type { RequestListItem, RequestsPage } from '$lib/api/requests.js';
  import type { DashboardStats } from '$lib/api/stats.js';
  import RangeFilter from '$lib/components/RangeFilter.svelte';
  import TokensCell from '$lib/components/TokensCell.svelte';
  import { formatTrendTick, trendAxisTicks, type TrendBucket } from '$lib/dashboard-chart.js';
  import {
    durationParts,
    formatCount,
    formatTimestamp,
    formatTokens,
    formatTps,
    formatUsd,
  } from '$lib/format.js';
  import {
    KEY_DETAIL_DEFAULT_RANGE,
    type KeyDetailFilters,
    keyDetailFiltersToSearch,
  } from '$lib/key-detail-filters.js';
  import { paginationItems } from '$lib/pagination.js';
  import type { RangeKey } from '$lib/requests-filters.js';
  import { t } from '$lib/i18n';

  type Stats = {
    total: number;
    ok: number;
    errors: number;
    successRate: number | null;
    avgLatency: number | null;
    avgTps: number | null;
    totalCost: number | null;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };

  let {
    data,
  }: {
    data: {
      key: ApiKeyView;
      keyId: string;
      filters: KeyDetailFilters;
      bucket: TrendBucket;
      stats: Stats;
      agg: DashboardStats;
      requests: RequestsPage;
    };
  } = $props();

  const key = $derived(data.key);
  const stats = $derived(data.stats);

  // ── Filter navigation (URL is the source of truth; loader re-runs) ───────────
  // Custom date inputs mirror the loaded filters, re-synced on navigation so the
  // back button / a shared link populate them.
  let customStart = $state(untrack(() => data.filters.startDate) ?? '');
  let customEnd = $state(untrack(() => data.filters.endDate) ?? '');
  // Re-sync the inputs whenever the loaded filters change (back button / shared
  // link) — the initial value is captured above via untrack; this keeps it live.
  $effect(() => {
    customStart = data.filters.startDate ?? '';
    customEnd = data.filters.endDate ?? '';
  });

  function applyFilters(next: KeyDetailFilters): void {
    const qs = keyDetailFiltersToSearch(next);
    void goto(qs ? `?${qs}` : '?', { keepFocus: true, noScroll: true });
  }
  // Picking a preset clears any custom range and resets to page 1.
  function selectRange(range: RangeKey): void {
    applyFilters({ range, page: 1 });
  }
  // Apply the custom day range (only when both ends are set); resets to page 1.
  function applyCustom(): void {
    if (!customStart || !customEnd) return;
    applyFilters({ range: data.filters.range, startDate: customStart, endDate: customEnd, page: 1 });
  }
  // Drop back to the default preset.
  function clearCustom(): void {
    applyFilters({ range: KEY_DETAIL_DEFAULT_RANGE, page: 1 });
  }
  function gotoPage(page: number): void {
    applyFilters({ ...data.filters, page });
  }

  const customActive = $derived(Boolean(data.filters.startDate && data.filters.endDate));

  // ── Charts (derived from the key-scoped SQL aggregate) ───────────────────────
  type TrendPoint = { date: Date; input: number; output: number; cached: number };
  type ModelSlice = { model: string; tokens: number };

  const trend = $derived<TrendPoint[]>(
    data.agg.series.map((b) => ({
      date: new Date(b.bucketStartMs),
      input: b.promptTokens,
      output: b.completionTokens,
      cached: b.cachedTokens,
    })),
  );
  const trendTicks = $derived(trendAxisTicks(trend));
  const TREND_SERIES = $derived([
    { key: 'input', label: $t('Input tokens'), value: (d: TrendPoint) => d.input, color: 'hsl(217 91% 60%)' },
    { key: 'output', label: $t('Output tokens'), value: (d: TrendPoint) => d.output, color: 'hsl(160 84% 39%)' },
    { key: 'cached', label: $t('Cached tokens'), value: (d: TrendPoint) => d.cached, color: 'hsl(38 92% 50%)' },
  ]);
  const byModel = $derived<ModelSlice[]>(
    data.agg.byModel
      .filter((m) => m.totalTokens > 0)
      .map((m) => ({ model: m.servedModel ?? $t('unknown'), tokens: m.totalTokens })),
  );
  const SLICE_COLORS = [
    'hsl(var(--color-primary))',
    'hsl(var(--color-secondary))',
    'hsl(var(--color-info))',
    'hsl(var(--color-success))',
    'hsl(var(--color-warning))',
    'hsl(var(--color-danger))',
  ];

  function formatTrendAxisValue(value: unknown): string {
    const date = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(date.getTime()) ? String(value ?? '') : formatTrendTick(date, data.bucket);
  }

  // ── Request list (scoped to this key) ────────────────────────────────────────
  const totalPages = $derived(
    Math.max(1, Math.ceil(data.requests.total / data.requests.pageSize)),
  );
  const pages = $derived(paginationItems(data.filters.page, totalPages));

  function detailHref(traceId: string): string {
    return `${base}/requests/${encodeURIComponent(traceId)}`;
  }
  function onRowClick(event: MouseEvent, traceId: string): void {
    if ((event.target as HTMLElement).closest('a')) return;
    void goto(detailHref(traceId));
  }
  function formatTs(ts: string): string {
    return formatTimestamp(ts) || '—';
  }
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

  // ── Config card helpers (mirror the list view's labels) ──────────────────────
  function limitLabel(v: number | null): string {
    if (v === null) return $t('Default');
    return v === 0 ? $t('Unlimited') : formatCount(v);
  }
  function windowText(seconds: number): string {
    const p = durationParts(seconds * 1000);
    if (p.unit === 'dh') return p.h > 0 ? `${p.d}d ${p.h}h` : `${p.d}d`;
    if (p.unit === 'hm') return p.m > 0 ? `${p.h}h ${p.m}m` : `${p.h}h`;
    return `${p.m}m`;
  }
  function budgetParts(k: ApiKeyView): string[] {
    const parts: string[] = [];
    if (k.budget_requests !== null) parts.push(`${formatCount(k.budget_requests)} req`);
    if (k.budget_tokens !== null) parts.push(`${formatTokens(k.budget_tokens)} tok`);
    if (k.budget_spend_usd !== null) parts.push(formatUsd(k.budget_spend_usd));
    if (parts.length > 0 && k.budget_window_seconds !== null) {
      parts.push(windowText(k.budget_window_seconds));
    }
    return parts;
  }
</script>

<div class="w-full px-4 py-6 md:px-8 md:py-8">
  <header class="mb-5">
    <a class="link-inline text-sm" href={`${base}/keys`}>← {$t('API Keys')}</a>
    <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="page-title">{key.name || $t('Unnamed')}</h1>
      <code class="font-mono text-sm text-ink-muted">{key.prefix}</code>
      {#if key.disabled}
        <span class="badge-neutral">{$t('disabled')}</span>
      {:else}
        <span class="badge-ok">{$t('active')}</span>
      {/if}
    </div>
  </header>

  <!-- Key configuration: the per-key caps recorded for this key (prefix only — the
       full key is never stored/shown; Principle 7). -->
  <section class="card mb-6">
    <h2 class="section-header mb-3">{$t('Configuration')}</h2>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3 lg:grid-cols-4">
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Role')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.role}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Allowed lanes')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.allowed_lanes?.join(', ') || $t('No cap')}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Custom model')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.allow_custom_model ? $t('yes') : $t('no')}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Rate limit')}</dt>
        <dd class="mt-0.5 text-ink-body">
          {$t('RPM')}: {limitLabel(key.rate_limit_rpm)} · {$t('TPM')}: {limitLabel(
            key.rate_limit_tpm,
          )}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Concurrency')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.concurrency_limit ?? $t('Unlimited')}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Budget')}</dt>
        <dd class="mt-0.5 text-ink-body">
          {#if budgetParts(key).length > 0}
            {budgetParts(key).join(' · ')}
            ({key.over_budget_behavior === 'reject'
              ? $t('reject')
              : `→ ${key.degrade_lane ?? 'economy'}`})
          {:else}
            {$t('None')}
          {/if}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Memory')}</dt>
        <dd class="mt-0.5 text-ink-body">
          {#if key.memory_mode === 'off'}
            {$t('Off')}
          {:else}
            {key.memory_mode === 'observe' ? $t('Observe') : $t('Inject')}
            {#if key.memory_project_id}
              · {key.memory_project_id}
            {/if}
            <!-- Jump to this key's memory (its account + default project scope) so an
                 operator can browse/curate the facts & reflections it has learned. -->
            <a
              class="link-inline ml-1"
              href={`${base}/memory?key=${encodeURIComponent(data.keyId)}`}>{$t('Manage memory')} →</a
            >
          {/if}
        </dd>
      </div>
    </dl>
  </section>

  <!-- Usage stats. The window is set by a preset (RangeFilter) OR a custom day
       range; the active control re-runs the loader via the URL. -->
  <section class="mb-5">
    <h2 class="section-header mb-3">{$t('Usage')}</h2>
    <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div class:opacity-50={customActive}>
        <RangeFilter value={data.filters.range} onChange={selectRange} />
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col text-xs text-slate-500">
          {$t('From')}
          <input type="date" class="input mt-0.5" bind:value={customStart} max={customEnd || undefined} />
        </label>
        <label class="flex flex-col text-xs text-slate-500">
          {$t('To')}
          <input type="date" class="input mt-0.5" bind:value={customEnd} min={customStart || undefined} />
        </label>
        <button
          type="button"
          class="btn-secondary"
          disabled={!customStart || !customEnd}
          onclick={applyCustom}>{$t('Apply')}</button
        >
        {#if customActive}
          <button type="button" class="btn-secondary" onclick={clearCustom}>{$t('Clear')}</button>
        {/if}
      </div>
    </div>
  </section>

  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Requests')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatCount(stats.total)}</div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Success rate')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {stats.successRate === null ? '—' : `${stats.successRate}%`}
      </div>
      <div class="mt-0.5 text-xs text-slate-400">
        {$t('Errors: {count}', { count: formatCount(stats.errors) })}
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
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Avg TPS')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatTps(stats.avgTps)}</div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Spend')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(stats.totalCost)}</div>
    </div>
  </div>

  <!-- Token stat cards -->
  <div class="mt-3 grid grid-cols-2 gap-3 md:mt-4 lg:grid-cols-4 lg:gap-4">
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Total tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatTokens(stats.totalTokens)}</div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Input tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatTokens(stats.inputTokens)}</div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Output tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.outputTokens)}
      </div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Cached tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.cachedTokens)}
      </div>
    </div>
  </div>

  <!-- Token charts (client-only; SSR off) -->
  <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
    <section class="card lg:col-span-2">
      <h2 class="section-header mb-3">{$t('Token usage over time')}</h2>
      {#if trend.length > 0}
        <div class="h-64">
          <AreaChart
            data={trend}
            x={(d) => d.date}
            series={TREND_SERIES}
            legend
            props={{
              xAxis: { ticks: trendTicks, format: formatTrendAxisValue },
              yAxis: { format: formatTokens },
              tooltip: { item: { format: formatTokens } },
            }}
          />
        </div>
      {:else}
        <div class="empty-state">{$t('No token usage recorded in this window yet.')}</div>
      {/if}
    </section>

    <section class="card">
      <h2 class="section-header mb-3">{$t('Tokens by model')}</h2>
      {#if byModel.length > 0}
        <div class="h-56">
          <PieChart
            data={byModel}
            key={(d: ModelSlice) => d.model}
            value={(d: ModelSlice) => d.tokens}
            innerRadius={-40}
            cRange={SLICE_COLORS}
            props={{ tooltip: { item: { format: formatTokens } } }}
          />
        </div>
        <ul class="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {#each byModel as slice, i (slice.model)}
            <li class="flex items-start gap-1.5 text-xs text-slate-600">
              <span
                class="mt-0.5 size-2.5 shrink-0 rounded-full"
                style:background-color={SLICE_COLORS[i % SLICE_COLORS.length]}
              ></span>
              <span class="max-w-[10rem] break-words leading-tight">{slice.model}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="empty-state">{$t('No token usage recorded in this window yet.')}</div>
      {/if}
    </section>
  </div>

  <!-- This key's requests (scoped) -->
  <section class="mt-8">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="section-header">{$t('Requests')}</h2>
      <span class="text-sm text-slate-400">
        {$t('{count} in window', { count: formatCount(data.requests.total) })}
      </span>
    </div>

    {#if data.requests.items.length === 0}
      <div class="empty-state">{$t('No requests for this key in the selected window.')}</div>
    {:else}
      <div class="table-wrap">
        <table class="table-base">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2 font-medium">{$t('Request ID')}</th>
              <th class="px-3 py-2 font-medium">{$t('Time')}</th>
              <th class="px-3 py-2 font-medium">{$t('Requested model')}</th>
              <th class="px-3 py-2 font-medium">{$t('Decided by')}</th>
              <th class="px-3 py-2 font-medium">{$t('Lane')}</th>
              <th class="px-3 py-2 font-medium">{$t('Served model')}</th>
              <th class="px-3 py-2 font-medium">{$t('Status')}</th>
              <th class="px-3 py-2 font-medium">{$t('Latency')}</th>
              <th class="px-3 py-2 font-medium">{$t('Tokens')}</th>
              <th class="px-3 py-2 font-medium">{$t('Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.requests.items as r (r.trace_id)}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <tr
                data-testid="request-row"
                class="table-row cursor-pointer"
                onclick={(e) => onRowClick(e, r.trace_id)}
              >
                <td class="px-3 py-2">
                  <a
                    class="link-inline block max-w-[7rem] truncate font-mono text-ink-strong lg:max-w-none"
                    href={detailHref(r.trace_id)}
                    title={r.trace_id}>{r.trace_id}</a
                  >
                </td>
                <td class="px-3 py-2 text-ink-body">{formatTs(r.ts)}</td>
                <td class="px-3 py-2 text-ink-body">{r.requested_model ?? '—'}</td>
                <td class="px-3 py-2">
                  <span class={decidedByClass(r.decided_by)}>{r.decided_by}</span>
                </td>
                <td class="px-3 py-2 text-ink-body">{r.lane || '—'}</td>
                <td class="px-3 py-2 font-mono text-xs text-ink-body">{r.final_model ?? '—'}</td>
                <td class="px-3 py-2">
                  {#if r.status === 'error'}
                    <span class="badge-error">{$t('error')}</span>
                  {:else}
                    <span class="badge-ok">{$t('ok')}</span>
                  {/if}
                </td>
                <td class="px-3 py-2 font-mono text-ink-body">{r.latency_ms}ms</td>
                <td class="px-3 py-2"><TokensCell usage={r.usage} /></td>
                <td class="px-3 py-2 font-mono text-ink-body">{formatUsd(r.cost_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if totalPages > 1}
        <nav class="mt-4 flex items-center justify-center gap-1" aria-label={$t('Pagination')}>
          <button
            type="button"
            class="btn-secondary"
            disabled={data.filters.page <= 1}
            onclick={() => gotoPage(data.filters.page - 1)}>{$t('Prev')}</button
          >
          {#each pages as p, i (i)}
            {#if p === 'ellipsis'}
              <span class="px-2 text-slate-400">…</span>
            {:else}
              <button
                type="button"
                class={p === data.filters.page ? 'btn-primary' : 'btn-secondary'}
                aria-current={p === data.filters.page ? 'page' : undefined}
                onclick={() => gotoPage(p)}>{p}</button
              >
            {/if}
          {/each}
          <button
            type="button"
            class="btn-secondary"
            disabled={data.filters.page >= totalPages}
            onclick={() => gotoPage(data.filters.page + 1)}>{$t('Next')}</button
          >
        </nav>
      {/if}
    {/if}
  </section>
</div>
