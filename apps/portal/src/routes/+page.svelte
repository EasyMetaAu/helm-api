<script lang="ts">
  import { AreaChart, PieChart, Tooltip } from "layerchart";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page as pageStore } from "$app/stores";
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens, formatTimestamp } from "$lib/format";
  import {
    formatTrendTick,
    pctDelta,
    trendAxisTicks,
  } from "$lib/dashboard-chart";
  import RangeFilter from "$lib/components/RangeFilter.svelte";
  import RefreshControl from "$lib/components/RefreshControl.svelte";
  import {
    DEFAULT_RANGE,
    resolveWindow,
    type RangeKey,
  } from "$lib/requests-filters";
  import {
    getUsage,
    getRequests,
    type UsageStats,
    type PortalRequestRow,
  } from "$lib/api/portal";

  let range = $state<RangeKey>(DEFAULT_RANGE);
  let stats = $state<UsageStats | null>(null);
  let previousStats = $state<UsageStats | null>(null);
  let recent = $state<PortalRequestRow[]>([]);
  let loading = $state(true);
  let error = $state("");

  // Hour buckets read well for a single day; daily buckets for wider windows.
  const bucket = $derived<"hour" | "day">(
    range === "today" || range === "yesterday" ? "hour" : "day",
  );
  // Baseline for the period-over-period delta = the equally-long window immediately
  // before the selected one (yesterday for today, the prior 7 days for 7d, etc).
  const deltaLabel = $derived(
    range === "today"
      ? $t("vs yesterday")
      : range === "yesterday"
        ? $t("vs day before")
        : range === "all"
          ? ""
          : $t("vs previous period"),
  );

  async function load(current: RangeKey = range) {
    loading = true;
    error = "";
    try {
      const tz = -new Date().getTimezoneOffset(); // east-positive minutes
      const now = Date.now();
      const win = resolveWindow(current, now);
      const start = win.start ?? 0;
      const end = win.end ?? now;
      // Previous equal-length window (skip for 'all' — no meaningful baseline).
      const span = end - start;
      const prevWin =
        current === "all" ? null : { start: start - span, end: start };
      const [s, p, r] = await Promise.all([
        getUsage({ bucket, tz, start, end }),
        prevWin
          ? getUsage({ bucket, tz, start: prevWin.start, end: prevWin.end })
          : Promise.resolve(null),
        getRequests({ pageSize: 8, start, end }),
      ]);
      stats = s;
      previousStats = p;
      recent = r.items;
    } catch (e) {
      error = e instanceof Error ? e.message : "load failed";
    } finally {
      loading = false;
    }
  }

  // Re-load whenever the range changes (also drives the initial load).
  $effect(() => {
    void load(range);
  });

  function selectRange(next: RangeKey): void {
    range = next;
  }

  // Trend points for the area chart.
  type TrendPoint = {
    date: Date;
    input: number;
    output: number;
    cost: number | null;
  };
  const trend = $derived<TrendPoint[]>(
    (stats?.series ?? []).map((b) => ({
      date: new Date(b.bucket_start_ms),
      input: b.prompt_tokens,
      output: b.completion_tokens,
      cost: b.cost_usd,
    })),
  );
  const trendTicks = $derived(trendAxisTicks(trend));
  const TREND_SERIES = $derived([
    {
      key: "input",
      label: $t("Input tokens"),
      value: (d: TrendPoint) => d.input,
      color: "hsl(217 91% 60%)",
    },
    {
      key: "output",
      label: $t("Output tokens"),
      value: (d: TrendPoint) => d.output,
      color: "hsl(160 84% 39%)",
    },
  ]);

  type ModelSlice = { model: string; tokens: number; cost: number | null };
  const byModel = $derived<ModelSlice[]>(
    (stats?.by_model ?? [])
      .filter((m) => m.total_tokens > 0)
      .map((m) => ({
        model: m.model ?? $t("unknown"),
        tokens: m.total_tokens,
        cost: m.cost_usd,
      })),
  );
  const SLICE_COLORS = [
    "hsl(var(--color-primary))",
    "hsl(var(--color-secondary))",
    "hsl(var(--color-info))",
    "hsl(var(--color-success))",
    "hsl(var(--color-warning))",
    "hsl(var(--color-danger))",
  ];

  function formatTrendAxisValue(value: unknown): string {
    const date =
      value instanceof Date ? value : new Date(value as string | number);
    return formatTrendTick(date, bucket);
  }

  // Budget: percent used against the cap when there is one (docs/12 §4.3).
  const budget = $derived(stats?.budget ?? null);
  const spent = $derived(stats?.totals.cost_usd ?? 0);
  const spendCap = $derived(budget?.spend_usd ?? null);
  const spendPct = $derived(
    spendCap && spendCap > 0 ? Math.min(100, (spent / spendCap) * 100) : null,
  );

  const successRate = $derived(
    stats && stats.totals.requests > 0
      ? Math.round((stats.totals.ok_count / stats.totals.requests) * 100)
      : null,
  );
  const previousSuccessRate = $derived(
    previousStats && previousStats.totals.requests > 0
      ? Math.round(
          (previousStats.totals.ok_count / previousStats.totals.requests) * 100,
        )
      : null,
  );

  type Delta = { pct: number | null; base: number };
  const deltas = $derived<Record<string, Delta> | null>(
    stats && previousStats
      ? {
          requests: {
            pct: pctDelta(stats.totals.requests, previousStats.totals.requests),
            base: previousStats.totals.requests,
          },
          successRate: {
            pct: pctDelta(successRate ?? 0, previousSuccessRate ?? 0),
            base: previousSuccessRate ?? 0,
          },
          totalTokens: {
            pct: pctDelta(
              stats.totals.total_tokens,
              previousStats.totals.total_tokens,
            ),
            base: previousStats.totals.total_tokens,
          },
          spend: {
            pct: pctDelta(stats.totals.cost_usd, previousStats.totals.cost_usd),
            base: previousStats.totals.cost_usd,
          },
        }
      : null,
  );

  // Smart empty state: zero requests → onboarding, not an empty dashboard (§3).
  const isEmpty = $derived(
    !loading &&
      stats !== null &&
      stats.totals.requests === 0 &&
      recent.length === 0,
  );
</script>

{#snippet deltaBadge(delta: Delta | undefined, fmt: (n: number) => string)}
  {#if delta && delta.pct !== null && deltaLabel}
    <div
      class="mt-0.5 text-xs text-ink-muted"
      title={$t("Previous: {value}", { value: fmt(delta.base) })}
    >
      {delta.pct >= 0 ? "↑" : "↓"}{Math.abs(delta.pct)}% {deltaLabel}
    </div>
  {/if}
{/snippet}

<header
  class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
>
  <h1 class="page-title">{$t("Overview")}</h1>
  <div class="flex flex-wrap items-center gap-3">
    <RangeFilter value={range} onChange={selectRange} />
    <RefreshControl onRefresh={() => load()} />
  </div>
</header>

{#if error}
  <p class="alert-error">{error}</p>
{:else if loading}
  <p class="section-desc">{$t("Loading…")}</p>
{:else if isEmpty}
  <div class="card text-center">
    <h2 class="section-header mb-2">{$t("No requests yet")}</h2>
    <p class="section-desc mb-4">
      {$t(
        "Connect a client to start routing through Helm. Pick your tool to get set up.",
      )}
    </p>
    <a class="btn-primary inline-block" href={`${base}/connect`}
      >{$t("Set up a client")}</a
    >
  </div>
{:else if stats}
  <!-- Stat cards -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
    <div class="card">
      <div class="section-desc">{$t("Requests")}</div>
      <div class="mt-1 text-2xl font-semibold">
        {formatTokens(stats.totals.requests)}
      </div>
      {@render deltaBadge(deltas?.requests, formatTokens)}
    </div>
    <div class="card">
      <div class="section-desc">{$t("Success rate")}</div>
      <div class="mt-1 text-2xl font-semibold">
        {successRate === null ? "—" : `${successRate}%`}
      </div>
      {@render deltaBadge(deltas?.successRate, (n) => `${Math.round(n)}%`)}
    </div>
    <div class="card">
      <div class="section-desc">{$t("Total tokens")}</div>
      <div class="mt-1 text-2xl font-semibold">
        {formatTokens(stats.totals.total_tokens)}
      </div>
      {@render deltaBadge(deltas?.totalTokens, formatTokens)}
    </div>
    <div class="card">
      <div class="section-desc">{$t("Spend")}</div>
      <div class="mt-1 text-2xl font-semibold">{formatUsd(spent)}</div>
      {@render deltaBadge(deltas?.spend, formatUsd)}
    </div>
  </div>

  <!-- Budget -->
  <section class="card mt-4">
    <h2 class="section-header mb-2">{$t("Your budget")}</h2>
    {#if spendCap === null}
      <p class="section-desc">{$t("No spend limit — usage is unlimited.")}</p>
    {:else}
      <div class="flex items-center justify-between text-sm">
        <span>{formatUsd(spent)} {$t("of")} {formatUsd(spendCap)}</span>
        <span class="text-ink-3"
          >{spendPct !== null ? `${Math.round(spendPct)}%` : ""}</span
        >
      </div>
      <div class="progress-track mt-1.5">
        <div class="progress-bar" style:width={`${spendPct ?? 0}%`}></div>
      </div>
      {#if budget?.window_seconds}
        <p class="field-help mt-1.5">
          {$t("Resets every {hours}h. Over budget: {behavior}.", {
            hours: Math.round((budget.window_seconds ?? 0) / 3600),
            behavior: budget?.behavior ?? "",
          })}
        </p>
      {/if}
    {/if}
  </section>

  <!-- Charts -->
  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
    <section class="card lg:col-span-2">
      <h2 class="section-header mb-3">{$t("Token usage over time")}</h2>
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
                  <Tooltip.Item label={$t("Total cost")} valueAlign="right"
                    >{formatUsd(data.cost)}</Tooltip.Item
                  >
                </Tooltip.List>
              </Tooltip.Root>
            </svelte:fragment>
          </AreaChart>
        </div>
      {:else}
        <div class="empty-state">
          {$t("No token usage recorded in this window yet.")}
        </div>
      {/if}
    </section>

    <section class="card">
      <h2 class="section-header mb-3">{$t("Tokens by model")}</h2>
      {#if byModel.length > 0}
        <div class="h-56">
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
                  <Tooltip.Item label={$t("Cost")} valueAlign="right"
                    >{formatUsd(data.cost)}</Tooltip.Item
                  >
                </Tooltip.List>
              </Tooltip.Root>
            </svelte:fragment>
          </PieChart>
        </div>
        <ul class="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {#each byModel as slice, i (i)}
            <li class="flex items-start gap-1.5 text-xs text-ink-2">
              <span
                class="mt-0.5 size-2.5 shrink-0 rounded-full"
                style:background-color={SLICE_COLORS[i % SLICE_COLORS.length]}
              ></span>
              <span class="max-w-[10rem] break-words leading-tight"
                >{slice.model}</span
              >
            </li>
          {/each}
        </ul>
      {:else}
        <div class="empty-state">
          {$t("No token usage recorded in this window yet.")}
        </div>
      {/if}
    </section>
  </div>

  <!-- Recent requests -->
  <section class="card mt-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="section-header">{$t("Recent requests")}</h2>
      <a class="link-inline" href={`${base}/requests`}>{$t("View all")}</a>
    </div>
    {#if recent.length === 0}
      <div class="empty-state">{$t("No requests yet.")}</div>
    {:else}
      <div class="table-wrap">
        <table class="table-base">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2 text-left">{$t("Time")}</th>
              <th class="px-3 py-2 text-left">{$t("Model")}</th>
              <th class="px-3 py-2 text-left">{$t("Lane")}</th>
              <th class="px-3 py-2 text-left">{$t("Status")}</th>
              <th class="px-3 py-2 text-right">{$t("Tokens")}</th>
              <th class="px-3 py-2 text-right">{$t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {#each recent as row (row.request_id)}
              <!-- Whole row is a link to the detail (keyboard: the time cell holds
                   the real focusable <a>; mouse: click anywhere on the row). -->
              <tr
                class="table-row cursor-pointer hover:bg-canvas"
                onclick={() => goto(`${base}/requests/${row.request_id}`)}
              >
                <td class="px-3 py-2">
                  <a
                    class="link-inline"
                    href={`${base}/requests/${row.request_id}`}
                  >
                    {formatTimestamp(new Date(row.created_at).toISOString())}
                  </a>
                </td>
                <td class="px-3 py-2">{row.served_model ?? "—"}</td>
                <td class="px-3 py-2">{row.lane}</td>
                <td class="px-3 py-2">
                  <span
                    class="badge {row.status === 'ok'
                      ? 'badge-ok'
                      : 'badge-error'}">{row.status}</span
                  >
                </td>
                <td class="px-3 py-2 text-right"
                  >{formatTokens(row.usage?.completion_tokens ?? null)}</td
                >
                <td class="px-3 py-2 text-right">{formatUsd(row.cost_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
