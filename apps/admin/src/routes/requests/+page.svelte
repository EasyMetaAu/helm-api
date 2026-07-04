<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import type { RequestListItem } from '$lib/api/requests.js';
  import RangeFilter from '$lib/components/RangeFilter.svelte';
  import RefreshControl from '$lib/components/RefreshControl.svelte';
  import RequestsTable from '$lib/components/RequestsTable.svelte';
  import { paginationItems } from '$lib/pagination.js';
  import {
    DEFAULT_FILTERS,
    filtersToSearch,
    PAGE_SIZE_OPTIONS,
    type RangeKey,
    type RequestsFilters,
    todayLocalDate,
  } from '$lib/requests-filters.js';
  import { t } from '$lib/i18n';

  // Request debug list (docs/07 list). READ-ONLY consumer of /admin/api/* — every
  // column is a field the backend recorded; nothing is recomputed (Principle 1). Principle 7:
  // the key is shown by display prefix only, never plaintext. Principle 5: `decided_by`
  // (classification stage) is shown distinctly from `fallback_count` (execution
  // stage). Filters + pagination live in the URL (the loader re-reads them), so the
  // view is a thin projection of the current querystring.
  let {
    data,
  }: {
    data: {
      items: RequestListItem[];
      total: number;
      page: number;
      pageSize: number;
      filters: RequestsFilters;
    };
  } = $props();

  // Control state, seeded from the loaded filters and re-synced after every
  // navigation (filter change / pager / Reset / back-button) so the inputs always
  // mirror the URL truth. Empty string = "no filter" for the selects/inputs.
  let range = $state<RangeKey>(untrack(() => data.filters.range));
  let status = $state<'' | RequestListItem['status']>(untrack(() => data.filters.status ?? ''));
  let decidedBy = $state<'' | RequestListItem['decided_by']>(
    untrack(() => data.filters.decidedBy ?? ''),
  );
  let lane = $state(untrack(() => data.filters.lane ?? ''));
  let model = $state(untrack(() => data.filters.model ?? ''));
  let pageSize = $state(untrack(() => data.filters.pageSize));
  // Custom calendar-day window (From/To). The active window lives in the URL
  // (?start=&end=) and OVERRIDES the preset; these mirror it, re-synced below.
  let customStart = $state(untrack(() => data.filters.startDate) ?? '');
  let customEnd = $state(untrack(() => data.filters.endDate) ?? '');
  // Future days have no data → cap both pickers at the viewer's local today.
  const today = todayLocalDate();

  $effect(() => {
    const f = data.filters;
    range = f.range;
    status = f.status ?? '';
    decidedBy = f.decidedBy ?? '';
    lane = f.lane ?? '';
    model = f.model ?? '';
    pageSize = f.pageSize;
    customStart = f.startDate ?? '';
    customEnd = f.endDate ?? '';
  });

  const customActive = $derived(Boolean(data.filters.startDate && data.filters.endDate));

  const totalPages = $derived(Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))));
  // The number/ellipsis row for the pager (first + last + a window around current).
  const pageItems = $derived(paginationItems(data.page, totalPages));

  // Navigate to the same route with the updated querystring. Changing any filter
  // resets to page 1 (default); the pager passes an explicit `page` to override.
  // The loader re-runs on the URL change and refetches that filtered page.
  function go(next: Partial<RequestsFilters> = {}): void {
    const f: RequestsFilters = {
      range,
      startDate: customStart || undefined,
      endDate: customEnd || undefined,
      status: status || undefined,
      decidedBy: decidedBy || undefined,
      lane: lane.trim() || undefined,
      model: model.trim() || undefined,
      // The key scope has no input control — it persists across other filter
      // changes and is only changed by clicking a row's key or clearing the chip
      // (`next` overrides). Reset passes `keyId: undefined` to drop it.
      keyId: data.filters.keyId,
      pageSize,
      page: 1,
      ...next,
    };
    const search = filtersToSearch(f);
    void goto(search ? `?${search}` : '?', { keepFocus: true, noScroll: true });
  }

  // Picking a preset clears any custom range (the preset wins). Applying a custom
  // range needs both ends; clearing drops back to the preset. All reset to page 1.
  function selectRange(next: RangeKey): void {
    range = next;
    customStart = '';
    customEnd = '';
    go();
  }
  function applyCustom(): void {
    if (!customStart || !customEnd) return;
    go();
  }
  function clearCustom(): void {
    customStart = '';
    customEnd = '';
    go();
  }

  // Real href for a page-number link: the current filter set with the target page.
  // Rendering the numbers as <a> (not buttons) gives a native pointer cursor +
  // middle-click / open-in-new-tab; SvelteKit still navigates client-side, and
  // data-sveltekit-noscroll keeps the scroll position like the Prev/Next buttons.
  function pageHref(n: number): string {
    const search = filtersToSearch({
      range,
      startDate: customStart || undefined,
      endDate: customEnd || undefined,
      status: status || undefined,
      decidedBy: decidedBy || undefined,
      lane: lane.trim() || undefined,
      model: model.trim() || undefined,
      keyId: data.filters.keyId,
      pageSize,
      page: n,
    });
    return search ? `?${search}` : '?';
  }

  function reset(): void {
    range = DEFAULT_FILTERS.range;
    status = '';
    decidedBy = '';
    lane = '';
    model = '';
    customStart = '';
    customEnd = '';
    go({ keyId: undefined });
  }

  // Label for the active key-filter chip: the recognizable key name/prefix from
  // the first matching row, falling back to a truncated id when the filtered
  // window has no rows to read it from.
  const keyFilterLabel = $derived(
    data.items[0]?.key_name ||
      data.items[0]?.key_prefix ||
      (data.filters.keyId ? `${data.filters.keyId.slice(0, 12)}…` : ''),
  );

  // Detail route for a row. The whole row is clickable (below); we also keep a
  // real <a> on the request-id cell so middle-click / open-in-new-tab / keyboard
  // still work, and the row click is a mouse convenience on top. We carry the
  // CURRENT list URL (filters + page) as `from` so the detail page's Back link
  // returns here exactly as it was — survives reload / new-tab (the state is in
  // the URL, not history).
  function detailHref(traceId: string): string {
    const search = filtersToSearch(data.filters);
    const from = `${base}/requests${search ? `?${search}` : ''}`;
    return `${base}/requests/${traceId}?from=${encodeURIComponent(from)}`;
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Requests')}</h1>
      <p class="section-desc">
        {$t(
          'Routing trail for each request — classification layer, lane, served model, fallbacks, cost and errors. Keys are shown by prefix only.',
        )}
      </p>
    </div>
    <!-- Refresh now + auto-refresh cadence. Re-runs the loader (invalidateAll),
         which re-reads the URL filters and refetches the current page. -->
    <div class="shrink-0">
      <RefreshControl onRefresh={() => invalidateAll()} />
    </div>
  </header>

  <!-- Date-range window: presets (the shared RangeFilter — identical to the
       dashboard) OR a custom From/To day range. The active control applies
       immediately and resets to page 1; a valid custom range dims + overrides the
       presets. -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
    <div class:opacity-50={customActive}>
      <RangeFilter value={range} onChange={selectRange} />
    </div>
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col text-xs text-ink-muted">
        {$t('From')}
        <input
          type="date"
          class="input mt-0.5"
          bind:value={customStart}
          max={customEnd && customEnd < today ? customEnd : today}
        />
      </label>
      <label class="flex flex-col text-xs text-ink-muted">
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

  <!-- Filter bar. Selects apply immediately; the lane/model text inputs apply on
       Enter (form submit). Changing any filter resets to page 1. -->
  <form
    class="card flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end"
    onsubmit={(e) => {
      e.preventDefault();
      go();
    }}
  >
    <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {$t('Status')}
      <select data-testid="filter-status" class="select" bind:value={status} onchange={() => go()}>
        <option value="">{$t('All')}</option>
        <option value="ok">{$t('ok')}</option>
        <option value="error">{$t('error')}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {$t('Decided by')}
      <select
        data-testid="filter-decided-by"
        class="select"
        bind:value={decidedBy}
        onchange={() => go()}
      >
        <option value="">{$t('All')}</option>
        <option value="rules">{$t('rules')}</option>
        <option value="eval">{$t('eval')}</option>
        <option value="default">{$t('default')}</option>
        <option value="fallback">{$t('fallback')}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {$t('Lane')}
      <input
        data-testid="filter-lane"
        class="input"
        type="text"
        bind:value={lane}
        placeholder={$t('e.g. premium')}
      />
    </label>

    <label class="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {$t('Model')}
      <input
        data-testid="filter-model"
        class="input"
        type="text"
        bind:value={model}
        placeholder={$t('Search model')}
      />
    </label>

    <div class="flex items-center gap-2">
      <button type="submit" class="btn-secondary">{$t('Apply')}</button>
      <button type="button" data-testid="filter-reset" class="btn-secondary" onclick={reset}
        >{$t('Reset')}</button
      >
    </div>
  </form>

  <!-- Active API-key scope (set by clicking a row's key, or arriving from a key's
       "view more" link). Shown as a removable chip since it has no input control. -->
  {#if data.filters.keyId}
    <div data-testid="key-filter-chip" class="flex items-center gap-2 text-sm">
      <span class="text-ink-muted">{$t('Filtered by key')}:</span>
      <span
        class="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-0.5 font-medium text-ink-strong"
      >
        {keyFilterLabel}
        <button
          type="button"
          data-testid="key-filter-clear"
          class="text-ink-muted hover:text-ink-strong"
          aria-label={$t('Clear')}
          onclick={() => go({ keyId: undefined })}>&times;</button
        >
      </span>
    </div>
  {/if}

  <div class="card flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
    <span class="text-xs font-medium uppercase tracking-wide text-ink-muted"
      >{$t('Decided by')}</span
    >
    <span class="flex items-center gap-2 text-xs text-ink-body">
      <span class="badge-rules">{$t('rules')}</span>
      {$t('Layer-1 deterministic rules chose the lane.')}
    </span>
    <span class="flex items-center gap-2 text-xs text-ink-body">
      <span class="badge-eval">{$t('eval')}</span>
      {$t('Layer-2 small-model evaluation chose the lane.')}
    </span>
    <span class="flex items-center gap-2 text-xs text-ink-body">
      <span class="badge-fallback">{$t('fallback')}</span>
      {$t('Classification failed safely and fell back to balanced.')}
    </span>
  </div>

  {#if data.items.length === 0}
    <div data-testid="requests-empty" class="empty-state">
      <p class="font-medium text-ink-body">{$t('No requests match these filters.')}</p>
      <p class="mt-1 text-ink-muted">
        {$t('Try widening the date range or clearing filters.')}
      </p>
    </div>
  {:else}
    <RequestsTable items={data.items} {detailHref} onKeyFilter={(keyId) => go({ keyId })} />

    <!-- Pagination footer: rows-per-page on the left, numbered pages + Prev/Next on
         the right. `total` reflects the active filters so the counts stay consistent
         with the rows shown. Page numbers are real <a> links (native pointer cursor /
         open-in-new-tab); Prev/Next stay buttons for their disabled states. -->
    <div
      class="flex flex-col gap-3 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label class="flex items-center gap-2">
          {$t('Rows per page')}
          <select
            data-testid="pager-page-size"
            class="select w-auto cursor-pointer"
            bind:value={pageSize}
            onchange={() => go()}
          >
            {#each PAGE_SIZE_OPTIONS as n (n)}
              <option value={n}>{n}</option>
            {/each}
          </select>
        </label>
        <span data-testid="pager-status">
          {$t('Page {page} of {pages}', { page: data.page, pages: totalPages })} ·
          {$t('{total} requests', { total: data.total })}
        </span>
      </div>

      <nav class="flex items-center gap-1" aria-label={$t('Pagination')}>
        <button
          type="button"
          data-testid="pager-prev"
          class="btn-secondary"
          disabled={data.page <= 1}
          onclick={() => go({ page: data.page - 1 })}>{$t('Previous')}</button
        >
        {#each pageItems as item, i (item === 'ellipsis' ? `e${i}` : item)}
          {#if item === 'ellipsis'}
            <span class="px-2 text-ink-muted" aria-hidden="true">…</span>
          {:else if item === data.page}
            <span
              data-testid="pager-page-current"
              aria-current="page"
              class="inline-flex h-9 min-w-9 items-center justify-center rounded border border-slate-800 bg-slate-800 px-2 text-sm font-medium text-white"
              >{item}</span
            >
          {:else}
            <a
              data-testid="pager-page"
              data-sveltekit-noscroll
              href={pageHref(item)}
              class="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded border border-slate-300 px-2 text-sm text-ink-body transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              >{item}</a
            >
          {/if}
        {/each}
        <button
          type="button"
          data-testid="pager-next"
          class="btn-secondary"
          disabled={data.page >= totalPages}
          onclick={() => go({ page: data.page + 1 })}>{$t('Next')}</button
        >
      </nav>
    </div>
  {/if}
</section>
