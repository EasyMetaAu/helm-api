<script lang="ts">
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page as pageStore } from "$app/stores";
  import { t } from "$lib/i18n";
  import {
    formatUsd,
    formatTimestamp,
    formatDurationMs,
    formatTps,
  } from "$lib/format";
  import { paginationItems } from "$lib/pagination";
  import { ApiError } from "$lib/api/client";
  import {
    getMe,
    getRequestByTrace,
    getRequests,
    type DecidedBy,
    type PortalRequestRow,
  } from "$lib/api/portal";
  import RangeFilter from "$lib/components/RangeFilter.svelte";
  import RefreshControl from "$lib/components/RefreshControl.svelte";
  import TokensCell from "$lib/components/TokensCell.svelte";
  import { toTokenUsageView } from "$lib/api/requests";
  import {
    DEFAULT_FILTERS,
    filtersToSearch,
    PAGE_SIZE_OPTIONS,
    parseFilters,
    requestDetailHref,
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
  let lane = $state("");
  let decidedBy = $state<DecidedBy | "">("");
  let session = $state("");
  let allowedLanes = $state<string[] | null>(null);
  let trace = $state("");
  let findingTrace = $state(false);
  let traceError = $state("");
  let pageSize = $state(DEFAULT_FILTERS.pageSize);
  let customStart = $state("");
  let customEnd = $state("");
  let rows = $state<PortalRequestRow[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state("");
  let latestLoad = 0;
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
    const loadId = ++latestLoad;
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
        lane: filters.lane,
        decided_by: filters.decidedBy,
        session: filters.session,
      });
      if (loadId !== latestLoad) return;
      rows = r.items;
      total = r.total;
      page = r.page;
      pageSize = r.page_size;
    } catch (e) {
      if (loadId !== latestLoad) return;
      const code = e instanceof ApiError ? e.code : undefined;
      error =
        code === "invalid_session"
          ? $t("Session names and IDs must be 256 characters or fewer.")
          : code === "session_filter_too_broad"
            ? $t("This name matches too many sessions. Enter the session ID.")
            : $t("Could not load requests.");
    } finally {
      if (loadId === latestLoad) loading = false;
    }
  }

  $effect(() => {
    let active = true;
    void getMe().then(
      (me) => {
        if (active) allowedLanes = me.allowed_lanes;
      },
      () => {
        if (active) allowedLanes = null;
      },
    );
    return () => {
      active = false;
    };
  });

  $effect(() => {
    const filters = parseFilters($pageStore.url.searchParams);
    activeFilters = filters;
    range = filters.range;
    status = filters.status ?? "";
    model = filters.model ?? "";
    lane = filters.lane ?? "";
    decidedBy = filters.decidedBy ?? "";
    session = filters.session ?? "";
    page = filters.page;
    pageSize = filters.pageSize;
    customStart = filters.startDate ?? "";
    customEnd = filters.endDate ?? "";
    void load(filters);
  });

  function currentFilters(page: number): RequestsFilters {
    return {
      range,
      startDate: customStart || undefined,
      endDate: customEnd || undefined,
      status: status || undefined,
      model: model.trim() || undefined,
      lane: lane.trim() || undefined,
      decidedBy: decidedBy || undefined,
      session: session || undefined,
      pageSize,
      page,
    };
  }

  function go(next: Partial<RequestsFilters> = {}): void {
    const filters = { ...currentFilters(1), ...next };
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
    lane = "";
    decidedBy = "";
    session = "";
    customStart = "";
    customEnd = "";
    pageSize = DEFAULT_FILTERS.pageSize;
    go();
  }

  function pageHref(n: number): string {
    const search = filtersToSearch(currentFilters(n));
    return search ? `?${search}` : "?";
  }

  function detailHref(requestId: string): string {
    const listPath = `${base}/requests`;
    return requestDetailHref(
      listPath,
      requestId,
      listPath + $pageStore.url.search,
    );
  }

  function onRowClick(event: MouseEvent, requestId: string): void {
    if ((event.target as HTMLElement).closest("a, button")) return;
    void goto(detailHref(requestId));
  }

  async function findByTrace(): Promise<void> {
    if (!trace || findingTrace) return;
    findingTrace = true;
    traceError = "";
    try {
      const result = await getRequestByTrace(trace);
      await goto(detailHref(result.data.request_id));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      traceError =
        status === 404
          ? $t("No request found for this trace ID.")
          : status === 409
            ? $t(
                "More than one request has this trace ID. Open the request from the list.",
              )
            : $t("Could not look up this trace ID.");
    } finally {
      findingTrace = false;
    }
  }

  const decidedByClass: Record<DecidedBy, string> = {
    rules: "badge-rules",
    eval: "badge-eval",
    default: "badge-neutral",
    fallback: "badge-classifier-fallback",
  };

  function outcomeLabel(outcome: PortalRequestRow["stream_outcome"]): string {
    if (outcome === "client_aborted") return $t("client aborted");
    if (outcome === "truncated") return $t("truncated");
    if (outcome === "incomplete") return $t("incomplete");
    if (outcome === "failed") return $t("failed");
    return "";
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

<!-- One compact toolbar (same shape as the admin request list): filters on the
     left, open-by-trace on the right. Controls carry aria-labels instead of
     stacked captions so the row stays one line on a laptop. -->
<div class="mb-4 flex flex-col gap-2">
  <div class="flex flex-wrap items-center gap-2">
    <form
      class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      {#if allowedLanes === null}
        <input
          data-testid="filter-lane"
          class="input w-full sm:w-40"
          type="search"
          autocomplete="off"
          aria-label={$t("Lane")}
          placeholder={$t("Lane")}
          bind:value={lane}
        />
      {:else}
        <select
          data-testid="filter-lane"
          class="select w-full sm:w-40"
          aria-label={$t("Lane")}
          bind:value={lane}
          onchange={() => go()}
        >
          <option value="">{$t("All lanes")}</option>
          {#each allowedLanes as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      {/if}
      <input
        data-testid="filter-model"
        class="input w-full sm:w-52"
        type="search"
        autocomplete="off"
        aria-label={$t("Model or lane")}
        bind:value={model}
        placeholder={$t("Search model or lane")}
      />
      <input
        data-testid="filter-session"
        class="input w-full sm:w-48"
        type="search"
        autocomplete="off"
        aria-label={$t("Session")}
        bind:value={session}
        maxlength={256}
        placeholder={$t("Session name or ID")}
      />
      <select
        data-testid="filter-status"
        class="select w-full sm:w-32"
        aria-label={$t("Status")}
        bind:value={status}
        onchange={() => go()}
      >
        <option value="">{$t("All statuses")}</option>
        <option value="ok">{$t("ok")}</option>
        <option value="error">{$t("error")}</option>
      </select>
      <select
        data-testid="filter-decided-by"
        class="select w-full sm:w-36"
        aria-label={$t("Decided by")}
        bind:value={decidedBy}
        onchange={() => go()}
      >
        <option value="">{$t("Any decision")}</option>
        <option value="rules">{$t("rules")}</option>
        <option value="eval">{$t("eval")}</option>
        <option value="default">{$t("default")}</option>
        <option value="fallback">{$t("fallback")}</option>
      </select>
      <button type="submit" class="btn-secondary">{$t("Apply")}</button>
      <button
        type="button"
        data-testid="filter-reset"
        class="btn-secondary"
        onclick={reset}
      >
        {$t("Reset")}
      </button>
    </form>
    <form
      class="flex w-full items-center gap-2 sm:w-auto"
      onsubmit={(event) => {
        event.preventDefault();
        void findByTrace();
      }}
    >
      <input
        class="input w-full sm:w-56"
        type="search"
        autocomplete="off"
        aria-label={$t("Find by trace ID")}
        placeholder={$t("Open by trace ID")}
        bind:value={trace}
        disabled={findingTrace}
      />
      <button
        type="submit"
        data-testid="find-by-trace"
        class="btn-secondary"
        disabled={!trace || findingTrace}
      >
        {findingTrace ? $t("Loading…") : $t("Find")}
      </button>
    </form>
  </div>
  {#if traceError}
    <p class="alert-error" role="alert">{traceError}</p>
  {/if}
</div>

{#if error}
  <p class="alert-error">{error}</p>
{:else}
  <div class="flex flex-col gap-3">
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
      <div class="cards-table-frame dense">
        <table class="cards-table">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2">{$t("Time")}</th>
              <th class="px-3 py-2">{$t("Result")}</th>
              <th class="px-3 py-2">{$t("Model")}</th>
              <th class="px-3 py-2">{$t("Routing")}</th>
              <th class="px-3 py-2">{$t("Tokens")}</th>
              <th class="px-3 py-2">{$t("Cost")}</th>
              <th class="px-3 py-2">{$t("Performance")}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.request_id)}
              {@const sessionLabel = row.session_label ?? row.session_ref}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <tr
                data-testid="request-row"
                class="cursor-pointer"
                onclick={(event) => onRowClick(event, row.request_id)}
              >
                <td data-label={$t("Time")} class="px-3 py-2 text-ink-body">
                  <a
                    data-testid="request-detail-link"
                    class="link-inline block whitespace-nowrap text-ink-strong table-mode:max-w-[7.5rem] table-mode:whitespace-normal"
                    href={detailHref(row.request_id)}
                    title={row.request_id}
                  >
                    {formatTimestamp(new Date(row.created_at).toISOString())}
                  </a>
                </td>
                <td data-label={$t("Result")} class="px-3 py-2">
                  <div data-testid="cell-result" class="leading-tight">
                    {#if row.partial}
                      <span class="badge-neutral">{$t("partial")}</span>
                      <div class="mt-1 text-xs text-amber-700">
                        {outcomeLabel(row.stream_outcome)}
                      </div>
                    {:else if row.status === "error"}
                      <span class="badge-error">{$t("error")}</span>
                    {:else}
                      <span class="badge-ok">{$t("ok")}</span>
                    {/if}
                  </div>
                </td>
                <td data-label={$t("Model")} class="px-3 py-2">
                  <div data-testid="cell-model" class="leading-tight">
                    <div
                      class="max-w-[16rem] truncate font-mono text-ink-strong"
                      title={row.served_model ?? undefined}
                    >
                      {row.served_model ?? "—"}
                    </div>
                    {#if row.serving_provider || sessionLabel || row.fallback_count > 0}
                      <div
                        data-testid="cell-serving"
                        class="mt-1 text-xs leading-tight"
                      >
                        <div class="flex flex-wrap items-center gap-1.5">
                          {#if row.serving_provider}
                            <span
                              class="max-w-[12rem] truncate font-mono text-ink-body"
                              title={row.serving_provider}
                              >{row.serving_provider}</span
                            >
                          {/if}
                          {#if sessionLabel}
                            <span
                              class="max-w-[12rem] truncate font-mono text-xs text-ink-muted"
                              title={sessionLabel}>{sessionLabel}</span
                            >
                          {/if}
                          {#if row.fallback_count > 0}
                            <span
                              class="badge-fallback"
                              title={$t("Fallback attempts")}
                            >
                              {$t("Fallbacks: {count}", {
                                count: row.fallback_count,
                              })}
                            </span>
                          {/if}
                        </div>
                      </div>
                    {/if}
                  </div>
                </td>
                <td data-label={$t("Routing")} class="px-3 py-2">
                  <div data-testid="cell-routing" class="leading-tight">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="badge-neutral">{row.lane || "—"}</span>
                      {#if row.decided_by}
                        <span
                          data-testid="decided-by"
                          class={decidedByClass[row.decided_by]}
                          title={$t("Decided by")}
                        >
                          {$t(row.decided_by)}
                        </span>
                      {/if}
                    </div>
                  </div>
                </td>
                <td data-label={$t("Tokens")} class="px-3 py-2">
                  <TokensCell usage={toTokenUsageView(row.usage)} />
                </td>
                <td
                  data-label={$t("Cost")}
                  class="px-3 py-2 font-mono text-ink-body"
                >
                  {formatUsd(row.cost_usd)}
                </td>
                <td data-label={$t("Performance")} class="px-3 py-2">
                  <div
                    data-testid="cell-performance"
                    class="font-mono text-xs leading-tight"
                  >
                    <div>{formatDurationMs(row.latency_ms)}</div>
                    <div data-testid="cell-tps" class="text-ink-muted">
                      {formatTps(row.tps, (value) =>
                        $t("{value} tokens/s", { value }),
                      )}
                    </div>
                  </div>
                </td>
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
          <nav
            class="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-start"
            aria-label={$t("Pagination")}
          >
            <button
              type="button"
              class="btn-secondary"
              disabled={page <= 1}
              onclick={() => go({ page: page - 1 })}>{$t("Previous")}</button
            >
            <!-- Numbered pages need room; phones rely on Previous/Next and the
                 "Page x of y" text. -->
            <div class="hidden items-center gap-1 sm:flex">
              {#each pageItems as item, i (item === "ellipsis" ? `e${i}` : item)}
                {#if item === "ellipsis"}
                  <span class="px-2 text-ink-muted" aria-hidden="true">…</span>
                {:else if item === page}
                  <span
                    aria-current="page"
                    class="inline-flex h-11 min-w-11 md:h-9 md:min-w-9 items-center justify-center rounded border border-slate-800 bg-slate-800 px-2 text-sm font-medium text-white"
                    >{item}</span
                  >
                {:else}
                  <a
                    data-sveltekit-noscroll
                    href={pageHref(item)}
                    class="inline-flex h-11 min-w-11 md:h-9 md:min-w-9 cursor-pointer items-center justify-center rounded border border-slate-300 px-2 text-sm text-ink-body transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                    >{item}</a
                  >
                {/if}
              {/each}
            </div>
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
