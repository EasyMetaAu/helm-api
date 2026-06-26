<script lang="ts">
  import { AreaChart, PieChart, Tooltip } from 'layerchart';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import type { RequestListItem } from '$lib/api/requests.js';
  import type { DashboardStats } from '$lib/api/stats.js';
  import RangeFilter from '$lib/components/RangeFilter.svelte';
  import RequestsTable from '$lib/components/RequestsTable.svelte';
  import { formatTrendTick, trendAxisTicks, type TrendBucket } from '$lib/dashboard-chart.js';
  import { formatCount, formatTokens, formatTps, formatUsd } from '$lib/format.js';
  import {
    DEFAULT_PAGE_SIZE,
    filtersToSearch,
    type RangeKey,
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
      items: RequestListItem[];
      range: RangeKey;
      // Active custom calendar-day window (YYYY-MM-DD). Present only when a valid
      // start/end pair is in the URL — it overrides `range`.
      startDate?: string;
      endDate?: string;
      bucket: TrendBucket;
      stats: Stats;
      agg: DashboardStats;
      // Per-card vs-yesterday delta: pct (null = no baseline) + base (yesterday's
      // full-day value, shown in the tooltip). Whole object null unless the TODAY
      // view is active and yesterday had enough traffic to compare against.
      compare: Record<string, { pct: number | null; base: number }> | null;
    };
  } = $props();

  const stats = $derived(data.stats);
  const recent = $derived(data.items.slice(0, 10));

  // The delta baseline differs by view: the TODAY view compares against yesterday,
  // the YESTERDAY view against the day before. Pick the matching badge label (the
  // tooltip baseline label is chosen inline in the snippet below).
  const comparisonLabel = $derived(
    data.range === 'yesterday' ? $t('vs day before yesterday') : $t('vs yesterday'),
  );

  // ── Chart data (derived from the SQL aggregate) ──────────────────────────────
  // Explicit point types so EVERY series/accessor shares one TData — without them
  // each inline `(d: {input})` lambda narrows TData to a different shape and the
  // LayerChart generic can't unify them.
  type TrendPoint = {
    date: Date;
    input: number;
    output: number;
    cached: number;
    cost: number | null;
  };
  type ModelSlice = { model: string; tokens: number; cost: number | null };

  // Trend: each bucket carries a real Date (x axis) + the three token series + the
  // bucket's total spend (tooltip only — not a plotted area). The chart plots
  // input/output/cached as overlaid areas over time.
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

  // By-model: total tokens per served model. Legacy/unstamped rows carry a null
  // model → bucket them under a localized "unknown" label so the slice is honest.
  const byModel = $derived<ModelSlice[]>(
    data.agg.byModel
      .filter((m) => m.totalTokens > 0)
      .map((m) => ({
        model: m.servedModel ?? $t('unknown'),
        tokens: m.totalTokens,
        cost: m.costUsd,
      })),
  );

  // Donut palette — these are LayerChart's own default slice colors, pinned here so
  // we can disable its built-in (absolute, shrink-to-fit) legend and render a clean
  // in-flow legend below the chart that reuses the EXACT same colors. The ordinal
  // colour scale maps domain[i] → range[i] (cycling), so legend item i ↔ slice i.
  const SLICE_COLORS = [
    'hsl(var(--color-primary))',
    'hsl(var(--color-secondary))',
    'hsl(var(--color-info))',
    'hsl(var(--color-success))',
    'hsl(var(--color-warning))',
    'hsl(var(--color-danger))',
  ];

  // The dashboard window lives in the URL (?range=…) so the loader re-fetches and
  // the view is shareable / back-button friendly — 'today' is the default, written
  // as a clean URL (no query) to match the loader's fallback. The button row is the
  // shared RangeFilter (same control as the request-list filter bar).
  const HOME_DEFAULT_RANGE: RangeKey = 'today';

  function selectRange(next: RangeKey): void {
    // A fresh querystring (no start/end) — picking a preset clears any custom range.
    const search = next === HOME_DEFAULT_RANGE ? '' : `range=${next}`;
    void goto(search ? `?${search}` : '?', { keepFocus: true, noScroll: true });
  }

  // Custom calendar-day window (From/To inputs). The active window lives in the URL
  // (?start=&end=) and OVERRIDES the preset; these inputs mirror it, re-synced on
  // navigation so a shared link / back button repopulates them.
  let customStart = $state(untrack(() => data.startDate) ?? '');
  let customEnd = $state(untrack(() => data.endDate) ?? '');
  $effect(() => {
    customStart = data.startDate ?? '';
    customEnd = data.endDate ?? '';
  });
  // Future days have no data → cap both pickers at the viewer's local today.
  const today = todayLocalDate();
  const customActive = $derived(Boolean(data.startDate && data.endDate));

  // Apply the custom day range (only when both ends are set); the loader re-reads
  // ?start=&end= and a valid range wins over the preset. Resets to the clean URL.
  function applyCustom(): void {
    if (!customStart || !customEnd) return;
    const qs = new URLSearchParams({ start: customStart, end: customEnd });
    void goto(`?${qs}`, { keepFocus: true, noScroll: true });
  }
  // Drop the custom range and fall back to the default window.
  function clearCustom(): void {
    void goto('?', { keepFocus: true, noScroll: true });
  }

  // Carry the active window into the full request list so "View all" opens in the
  // same range. Built with the list's own serializer so it matches exactly what the
  // list treats as "clean" — a custom range serializes to ?start=&end= (custom wins).
  const viewAllHref = $derived.by(() => {
    const qs = filtersToSearch({
      range: data.range,
      startDate: data.startDate,
      endDate: data.endDate,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    return `${base}/requests${qs ? `?${qs}` : ''}`;
  });

  // A recent-requests row mirrors the full request list: the whole row links to the
  // detail page, but the Request-ID cell keeps a real <a> so keyboard / middle-click /
  // open-in-new-tab still work (the row click is a mouse convenience on top).
  function detailHref(traceId: string): string {
    return `${base}/requests/${traceId}`;
  }

  // The dashboard has no in-page filter, so a row's Key cell links to the full
  // requests list pre-filtered to that key, carrying the current window so it opens
  // on the same range the dashboard is showing.
  function keyFilterHref(keyId: string): string {
    const qs = filtersToSearch({
      range: data.range,
      startDate: data.startDate,
      endDate: data.endDate,
      keyId,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    return `${base}/requests${qs ? `?${qs}` : ''}`;
  }

  function formatTrendAxisValue(value: unknown): string {
    const date = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(date.getTime()) ? String(value ?? '') : formatTrendTick(date, data.bucket);
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

  <!-- Date-range filter: scopes the stat cards + recent-request preview to a window.
       A preset (RangeFilter) OR a custom From/To day range — the active control
       re-runs the loader via the URL; a valid custom range dims + overrides the
       presets. -->
  <div class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
    <div class:opacity-50={customActive}>
      <RangeFilter value={data.range} onChange={selectRange} />
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

  <!-- Day-over-day delta, shown under a volume card on the TODAY view: today-so-far
       vs yesterday's full day. The tooltip surfaces the baseline (yesterday's value)
       so the % is transparent. null pct / no comparison loaded → renders nothing.
       `fmt` formats the baseline the same way the card formats its headline number. -->
  {#snippet deltaBadge(
    d: { pct: number | null; base: number } | undefined,
    fmt: (n: number) => string,
  )}
    {#if d && d.pct !== null}
      <div
        class="mt-0.5 text-xs text-slate-400"
        title={data.range === 'yesterday'
          ? $t('Day before yesterday: {value}', { value: fmt(d.base) })
          : $t('Yesterday: {value}', { value: fmt(d.base) })}
      >
        {d.pct >= 0 ? '↑' : '↓'}{Math.abs(d.pct)}% {comparisonLabel}
      </div>
    {/if}
  {/snippet}

  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Requests')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatCount(stats.total)}</div>
      {@render deltaBadge(data.compare?.requests, formatCount)}
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
      <div
        class="text-xs font-medium uppercase tracking-wide text-slate-400"
        title={$t(
          'Tokens generated per second (output ÷ generation time), averaged over streamed requests.',
        )}
      >
        {$t('Avg TPS')}
      </div>
      <div data-testid="stat-avg-tps" class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTps(stats.avgTps)}
      </div>
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{$t('Spend')}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(stats.totalCost)}</div>
      {@render deltaBadge(data.compare?.totalCost, formatUsd)}
    </div>
  </div>

  <!-- Token stat cards: Total / Input / Output / Cached — the real SQL aggregate
       over the selected window (not a sampled client-side reduce). -->
  <div class="mt-3 grid grid-cols-2 gap-3 md:mt-4 lg:grid-cols-4 lg:gap-4">
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Total tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.totalTokens)}
      </div>
      {@render deltaBadge(data.compare?.totalTokens, formatTokens)}
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Input tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.inputTokens)}
      </div>
      {@render deltaBadge(data.compare?.inputTokens, formatTokens)}
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Output tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.outputTokens)}
      </div>
      {@render deltaBadge(data.compare?.outputTokens, formatTokens)}
    </div>
    <div class="card">
      <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Cached tokens')}
      </div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">
        {formatTokens(stats.cachedTokens)}
      </div>
      <!-- Cache hit rate: cached ÷ input tokens. Hidden when the window had no input
           tokens (rate is null) so the card never shows a meaningless "—%". -->
      {#if stats.cacheHitRate !== null}
        <div class="mt-0.5 text-xs text-slate-400">
          {$t('Hit rate: {rate}', { rate: `${stats.cacheHitRate}%` })}
        </div>
      {/if}
      {@render deltaBadge(data.compare?.cachedTokens, formatTokens)}
    </div>
  </div>

  <!-- Token charts: usage trend over time + per-served-model breakdown. Both are
       LayerChart (client-only; SSR is off). Each falls back to the empty-state
       placeholder when the window has no token-bearing traffic yet. -->
  <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
    <section class="card lg:col-span-2">
      <h2 class="section-header mb-3">{$t('Token usage over time')}</h2>
      {#if trend.length > 0}
        <div class="h-64">
          <!-- Compact the Y-axis ticks (15M, not 15,000,000) via the shared
               formatTokens; the x-axis already switches hour↔day by bucket
               (formatTrendTick). The tooltip is overridden below to append the
               bucket's total spend, which the default (tokens-only) tooltip omits. -->
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
        <!-- Donut only — its built-in legend is absolutely positioned and wraps
             unpredictably, so we drive the slices with an explicit palette and
             render our own in-flow legend below (see SLICE_COLORS). -->
        <div class="h-56">
          <!-- Slice-hover tooltip shows the model's token total (compacted, 1.2M)
               plus its spend — the default tooltip is tokens-only. -->
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
        <!-- In-flow legend: normal-flow flex-wrap has correct line boxes, so a long
             model name wraps at a hyphen without the dot/label colliding with the
             next row. Item i reuses slice i's colour. -->
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

  <!-- Recent requests -->
  <section class="mt-8">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="section-header">{$t('Recent requests')}</h2>
      <a class="link-inline text-sm font-medium" href={viewAllHref}>
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
      <RequestsTable items={recent} {detailHref} keyHref={keyFilterHref} />
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
