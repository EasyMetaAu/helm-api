<script lang="ts">
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page as pageStore } from "$app/stores";
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens, formatTimestamp } from "$lib/format";
  import { paginationItems } from "$lib/pagination";
  import { getRequests, type PortalRequestRow } from "$lib/api/portal";
  import RangeFilter from "$lib/components/RangeFilter.svelte";
  import RefreshControl from "$lib/components/RefreshControl.svelte";
  import {
    DEFAULT_FILTERS,
    filtersToSearch,
    PAGE_SIZE_OPTIONS,
    parseFilters,
    resolveCustomDayWindow,
    resolveWindow,
    todayLocalDate,
    type RangeKey,
    type RequestsFilters,
  } from "$lib/requests-filters";

  let page = $state(1);
  let range = $state<RangeKey>(DEFAULT_FILTERS.range);
  let status = $state<"" | "ok" | "error">("");
  let model = $state("");
  let pageSize = $state(DEFAULT_FILTERS.pageSize);
  let customStart = $state("");
  let customEnd = $state("");
  let rows = $state<PortalRequestRow[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state("");
  let activeFilters = $state<RequestsFilters>(DEFAULT_FILTERS);

  const today = todayLocalDate();
  const customActive = $derived(
    Boolean(activeFilters.startDate && activeFilters.endDate),
  );
  const totalPages = $derived(
    Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
  );
  const pageItems = $derived(paginationItems(page, totalPages));

  async function load(filters: RequestsFilters = activeFilters) {
    loading = true;
    error = "";
    const custom =
      filters.startDate && filters.endDate
        ? resolveCustomDayWindow(filters.startDate, filters.endDate)
        : null;
    const { start, end } = custom ?? resolveWindow(filters.range, Date.now());
    try {
      const r = await getRequests({
        page: filters.page,
        pageSize: filters.pageSize,
        start,
        end,
        status: filters.status,
        model: filters.model,
      });
      rows = r.items;
      total = r.total;
      page = r.page;
      pageSize = r.page_size;
    } catch (e) {
      error = e instanceof Error ? e.message : $t("load failed");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const filters = parseFilters($pageStore.url.searchParams);
    activeFilters = filters;
    range = filters.range;
    status = filters.status ?? "";
    model = filters.model ?? "";
    page = filters.page;
    pageSize = filters.pageSize;
    customStart = filters.startDate ?? "";
    customEnd = filters.endDate ?? "";
    void load(filters);
  });

  function go(next: Partial<RequestsFilters> = {}): void {
    const filters: RequestsFilters = {
      range,
      startDate: customStart || undefined,
      endDate: customEnd || undefined,
      status: status || undefined,
      model: model.trim() || undefined,
      pageSize,
      page: 1,
      ...next,
    };
    const search = filtersToSearch(filters);
    void goto(search ? `?${search}` : "?", {
      keepFocus: true,
      noScroll: true,
      replaceState: true,
    });
  }

  function selectRange(next: RangeKey): void {
    range = next;
    customStart = "";
    customEnd = "";
    go();
  }

  function applyCustom(): void {
    if (!customStart || !customEnd) return;
    go();
  }

  function clearCustom(): void {
    customStart = "";
    customEnd = "";
    go();
  }

  function reset(): void {
    range = DEFAULT_FILTERS.range;
    status = "";
    model = "";
    customStart = "";
    customEnd = "";
    pageSize = DEFAULT_FILTERS.pageSize;
    go();
  }

  function pageHref(n: number): string {
    const search = filtersToSearch({
      range,
      startDate: customStart || undefined,
      endDate: customEnd || undefined,
      status: status || undefined,
      model: model.trim() || undefined,
      pageSize,
      page: n,
    });
    return search ? `?${search}` : "?";
  }

  function detailHref(traceId: string): string {
    return `${base}/requests/${traceId}`;
  }
</script>

<header
  class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
>
  <div class="min-w-0">
    <h1 class="page-title">{$t("Requests")}</h1>
    <p class="section-desc mt-1">
      {$t("Your requests, filtered by time, status, model, or lane.")}
    </p>
  </div>
  <div class="shrink-0">
    <RefreshControl onRefresh={() => load()} />
  </div>
</header>

<div
  class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"
>
  <div class:opacity-50={customActive}>
    <RangeFilter value={range} onChange={selectRange} />
  </div>
  <div class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col text-xs text-ink-muted">
      {$t("From")}
      <input
        type="date"
        class="input mt-0.5"
        bind:value={customStart}
        max={customEnd && customEnd < today ? customEnd : today}
      />
    </label>
    <label class="flex flex-col text-xs text-ink-muted">
      {$t("To")}
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
      onclick={applyCustom}>{$t("Apply")}</button
    >
    {#if customActive}
      <button type="button" class="btn-secondary" onclick={clearCustom}
        >{$t("Clear")}</button
      >
    {/if}
  </div>
</div>

<form
  class="card mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,1fr)_minmax(9rem,.45fr)_auto] lg:items-end"
  onsubmit={(e) => {
    e.preventDefault();
    go();
  }}
>
  <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
    {$t("Model or lane")}
    <input
      data-testid="filter-model"
      class="input"
      type="search"
      autocomplete="off"
      bind:value={model}
      placeholder={$t("Search model or lane")}
    />
  </label>
  <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
    {$t("Status")}
    <select
      data-testid="filter-status"
      class="select"
      bind:value={status}
      onchange={() => go()}
    >
      <option value="">{$t("All")}</option>
      <option value="ok">{$t("ok")}</option>
      <option value="error">{$t("error")}</option>
    </select>
  </label>
  <div class="flex items-center gap-2 sm:col-span-2 lg:col-span-1">
    <button type="submit" class="btn-secondary">{$t("Apply")}</button>
    <button
      type="button"
      data-testid="filter-reset"
      class="btn-secondary"
      onclick={reset}
    >
      {$t("Reset")}
    </button>
  </div>
</form>

{#if error}
  <p class="alert-error">{error}</p>
{:else}
  <div class="card flex flex-col gap-3">
    {#if loading}
      <p class="section-desc">{$t("Loading…")}</p>
    {:else if rows.length === 0}
      <div data-testid="requests-empty" class="empty-state">
        <p class="font-medium text-ink-body">
          {$t("No requests match these filters.")}
        </p>
        <p class="mt-1 text-ink-muted">
          {$t("Try widening the date range or clearing filters.")}
        </p>
      </div>
    {:else}
      <div class="table-wrap">
        <table class="table-base">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2 text-left">{$t("Time")}</th>
              <th class="px-3 py-2 text-left">{$t("Model")}</th>
              <th class="px-3 py-2 text-left">{$t("Lane")}</th>
              <th class="px-3 py-2 text-left">{$t("Status")}</th>
              <th class="px-3 py-2 text-right">{$t("Latency")}</th>
              <th class="px-3 py-2 text-right">{$t("Tokens")}</th>
              <th class="px-3 py-2 text-right">{$t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.request_id)}
              <tr
                class="table-row cursor-pointer hover:bg-canvas"
                onclick={() => goto(detailHref(row.request_id))}
              >
                <td class="px-3 py-2">
                  <a class="link-inline" href={detailHref(row.request_id)}>
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
                <td class="px-3 py-2 text-right">{row.latency_ms}ms</td>
                <td class="px-3 py-2 text-right"
                  >{formatTokens(row.usage?.completion_tokens ?? null)}</td
                >
                <td class="px-3 py-2 text-right">{formatUsd(row.cost_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div
        class="flex flex-col gap-3 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label class="flex items-center gap-2">
            {$t("Rows per page")}
            <select
              class="select w-auto cursor-pointer"
              bind:value={pageSize}
              onchange={() => go()}
            >
              {#each PAGE_SIZE_OPTIONS as n (n)}
                <option value={n}>{n}</option>
              {/each}
            </select>
          </label>
          <span>
            {$t("Page {page} of {pages}", { page, pages: totalPages })} ·
            {$t("{total} requests", { total })}
          </span>
        </div>

        {#if totalPages > 1}
          <nav class="flex items-center gap-1" aria-label={$t("Pagination")}>
            <button
              type="button"
              class="btn-secondary"
              disabled={page <= 1}
              onclick={() => go({ page: page - 1 })}>{$t("Previous")}</button
            >
            {#each pageItems as item, i (item === "ellipsis" ? `e${i}` : item)}
              {#if item === "ellipsis"}
                <span class="px-2 text-ink-muted" aria-hidden="true">…</span>
              {:else if item === page}
                <span
                  aria-current="page"
                  class="inline-flex h-9 min-w-9 items-center justify-center rounded border border-slate-800 bg-slate-800 px-2 text-sm font-medium text-white"
                  >{item}</span
                >
              {:else}
                <a
                  data-sveltekit-noscroll
                  href={pageHref(item)}
                  class="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded border border-slate-300 px-2 text-sm text-ink-body transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  >{item}</a
                >
              {/if}
            {/each}
            <button
              type="button"
              class="btn-secondary"
              disabled={page >= totalPages}
              onclick={() => go({ page: page + 1 })}>{$t("Next")}</button
            >
          </nav>
        {/if}
      </div>
    {/if}
  </div>
{/if}
