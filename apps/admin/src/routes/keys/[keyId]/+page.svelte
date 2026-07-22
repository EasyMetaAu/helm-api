<script lang="ts">
  import { untrack } from 'svelte';
  import { AreaChart, PieChart, Tooltip } from 'layerchart';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import type { ApiKeyView } from '$lib/api/keys.js';
  import type { RequestsPage } from '$lib/api/requests.js';
  import type { DashboardStats } from '$lib/api/stats.js';
  import RangeFilter from '$lib/components/RangeFilter.svelte';
  import RequestsTable from '$lib/components/RequestsTable.svelte';
  import { formatTrendTick, trendAxisTicks, type TrendBucket } from '$lib/dashboard-chart.js';
  import {
    durationParts,
    formatCount,
    formatDurationMs,
    formatTokens,
    formatTps,
    formatUsd,
  } from '$lib/format.js';
  import {
    KEY_DETAIL_DEFAULT_RANGE,
    type KeyDetailFilters,
    keyDetailFiltersToSearch,
  } from '$lib/key-detail-filters.js';
  import {
    DEFAULT_PAGE_SIZE,
    type RangeKey,
    filtersToSearch,
    todayLocalDate,
  } from '$lib/requests-filters.js';
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
    cacheHitRate: number | null;
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
  // Future days have no data → cap both pickers at the viewer's local today.
  const today = todayLocalDate();

  function applyFilters(next: KeyDetailFilters): void {
    const qs = keyDetailFiltersToSearch(next);
    void goto(qs ? `?${qs}` : '?', { keepFocus: true, noScroll: true });
  }

  function sessionHref(sessionRef: string): string {
    const search = filtersToSearch({ range: 'all', sessionRef, page: 1, pageSize: DEFAULT_PAGE_SIZE });
    return `${base}/requests?${search}`;
  }
  // Picking a preset clears any custom range and resets to page 1.
  function selectRange(range: RangeKey): void {
    applyFilters({ range, page: 1 });
  }
  // Apply the custom day range (only when both ends are set); resets to page 1.
  function applyCustom(): void {
    if (!customStart || !customEnd) return;
    applyFilters({
      range: data.filters.range,
      startDate: customStart,
      endDate: customEnd,
      page: 1,
    });
  }
  // Drop back to the default preset.
  function clearCustom(): void {
    applyFilters({ range: KEY_DETAIL_DEFAULT_RANGE, page: 1 });
  }
  const customActive = $derived(Boolean(data.filters.startDate && data.filters.endDate));

  // ── Charts (derived from the key-scoped SQL aggregate) ───────────────────────
  type TrendPoint = {
    date: Date;
    input: number;
    output: number;
    cached: number;
    cost: number | null;
  };
  type ModelSlice = { model: string; tokens: number; cost: number | null };

  const trend = $derived<TrendPoint[]>(
    data.agg.series.map((b) => ({
      date: new Date(b.bucketStartMs),
      input: b.promptTokens,
      output: b.completionTokens,
      cached: b.cachedTokens,
      cost: b.costUsd,
    })),
  );
  const trendTicks = $derived(trendAxisTicks(trend));
  const TREND_SERIES = $derived([
    {
      key: 'input',
      label: $t('Input tokens'),
      value: (d: TrendPoint) => d.input,
      color: 'hsl(217 91% 60%)',
    },
    {
      key: 'output',
      label: $t('Output tokens'),
      value: (d: TrendPoint) => d.output,
      color: 'hsl(160 84% 39%)',
    },
    {
      key: 'cached',
      label: $t('Cached tokens'),
      value: (d: TrendPoint) => d.cached,
      color: 'hsl(38 92% 50%)',
    },
  ]);
  const byModel = $derived<ModelSlice[]>(
    data.agg.byModel
      .filter((m) => m.totalTokens > 0)
      .map((m) => ({
        model: m.servedModel ?? $t('unknown'),
        tokens: m.totalTokens,
        cost: m.costUsd,
      })),
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
  // Only the most-recent page is shown here (no in-page pager); a "view all" link
  // hands the current window off to the global requests list, pre-filtered to this
  // key. `hasMore` decides whether that link is worth showing.
  const hasMore = $derived(data.requests.total > data.requests.items.length);
  const viewAllRequestsHref = $derived.by(() => {
    const qs = filtersToSearch({
      range: data.filters.range,
      startDate: data.filters.startDate,
      endDate: data.filters.endDate,
      keyId: data.keyId,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    return `${base}/requests${qs ? `?${qs}` : ''}`;
  });

  // Carry THIS key page (its window/range filters) as `from`, so the request
  // detail's Back link returns here — not to the global requests list.
  function detailHref(traceId: string): string {
    const qs = keyDetailFiltersToSearch(data.filters);
    const from = `${base}/keys/${encodeURIComponent(data.keyId)}${qs ? `?${qs}` : ''}`;
    return `${base}/requests/${encodeURIComponent(traceId)}?from=${encodeURIComponent(from)}`;
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
        <dd class="mt-0.5 text-ink-body">
          {key.allowed_lanes === null
            ? $t('No cap')
            : key.allowed_lanes.length === 0
              ? $t('None')
              : key.allowed_lanes.join(', ')}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Custom model')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.allow_custom_model ? $t('yes') : $t('no')}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-slate-400">{$t('Fast mode')}</dt>
        <dd class="mt-0.5 text-ink-body">{key.allow_fast_mode ? $t('yes') : $t('no')}</dd>
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
          {/if}
          <!-- Jump to this key's memory (its account + default project scope) so an
               operator can browse/curate the facts & reflections it has learned. Shown
               even when memory is OFF: switching observe off doesn't erase what the key
               already learned, and the memory page resolves the scope from the key's
               config (account + memory_project_id) regardless of mode — without this a
               switched-off key has no path to its accumulated memory. -->
          <a class="link-inline ml-1" href={`${base}/memory?key=${encodeURIComponent(data.keyId)}`}
            >{$t('Manage memory')} →</a
          >
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
          <input
            type="date"
            class="input mt-0.5"
            bind:value={customStart}
            max={customEnd && customEnd < today ? customEnd : today}
          />
        </label>
        <label class="flex flex-col text-xs text-slate-500">
          {$t('To')}
          <input
            type="date"
            class="input mt-0.5"
            bind:value={customEnd}
            min={customStart || undefined}
            max={today}
          />
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
        {stats.avgLatency === null ? '—' : formatDurationMs(stats.avgLatency)}
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
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.totalTokens)}
      </div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Input tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.inputTokens)}
      </div>
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
      <!-- Cache hit rate: cached ÷ input tokens (matches the dashboard card).
           Hidden when the window had no input tokens (rate is null). -->
      {#if stats.cacheHitRate !== null}
        <div class="mt-0.5 text-xs text-slate-400">
          {$t('Hit rate: {rate}', { rate: `${stats.cacheHitRate}%` })}
        </div>
      {/if}
    </div>
  </div>

  <!-- Token charts (client-only; SSR off) -->
  <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
    <section class="card lg:col-span-2">
      <h2 class="section-header mb-3">{$t('Token usage over time')}</h2>
      {#if trend.length > 0}
        <div class="h-64">
          <!-- Same rich tooltip as the dashboard: each token series plus the
               bucket's total spend (the default tooltip is tokens-only). -->
          <AreaChart
            data={trend}
            x={(d) => d.date}
            series={TREND_SERIES}
            legend
            props={{
              xAxis: { ticks: trendTicks, format: formatTrendAxisValue },
              yAxis: { format: formatTokens },
            }}
          >
            <svelte:fragment slot="tooltip" let:x>
              <Tooltip.Root let:data>
                <Tooltip.Header value={x(data)} format={formatTrendAxisValue} />
                <Tooltip.List>
                  {#each TREND_SERIES as s (s.key)}
                    <Tooltip.Item
                      label={s.label}
                      value={s.value(data)}
                      color={s.color}
                      format={formatTokens}
                      valueAlign="right"
                    />
                  {/each}
                  <Tooltip.Separator />
                  <Tooltip.Item label={$t('Total cost')} valueAlign="right">
                    {formatUsd(data.cost)}
                  </Tooltip.Item>
                </Tooltip.List>
              </Tooltip.Root>
            </svelte:fragment>
          </AreaChart>
        </div>
      {:else}
        <div class="empty-state">{$t('No token usage recorded in this window yet.')}</div>
      {/if}
    </section>

    <section class="card">
      <h2 class="section-header mb-3">{$t('Tokens by model')}</h2>
      {#if byModel.length > 0}
        <div class="h-56">
          <!-- Slice-hover tooltip shows the model's token total plus its spend —
               same as the dashboard donut (the default tooltip is tokens-only). -->
          <PieChart
            data={byModel}
            key={(d: ModelSlice) => d.model}
            value={(d: ModelSlice) => d.tokens}
            innerRadius={-40}
            cRange={SLICE_COLORS}
          >
            <svelte:fragment slot="tooltip" let:c let:cScale>
              <Tooltip.Root let:data>
                <Tooltip.List>
                  <Tooltip.Item
                    label={data.model}
                    value={data.tokens}
                    color={cScale?.(c(data))}
                    format={formatTokens}
                    valueAlign="right"
                  />
                  <Tooltip.Item label={$t('Cost')} valueAlign="right">
                    {formatUsd(data.cost)}
                  </Tooltip.Item>
                </Tooltip.List>
              </Tooltip.Root>
            </svelte:fragment>
          </PieChart>
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
      <RequestsTable
        items={data.requests.items}
        {detailHref}
        {sessionHref}
        showKey={false}
        variant="key"
      />

      {#if hasMore}
        <!-- Only the most-recent page is shown here. The full current window lives
             in the global requests list, still pre-filtered to this key. -->
        <div class="mt-4 text-sm">
          <a data-testid="view-all-requests" class="link-inline" href={viewAllRequestsHref}
            >{$t('View all requests for this key')} →</a
          >
        </div>
      {/if}
    {/if}
  </section>
</div>
