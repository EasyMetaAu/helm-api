<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import type { RequestListItem } from '$lib/api/requests.js';
  import RangeFilter from '$lib/components/RangeFilter.svelte';
  import { formatUsd } from '$lib/format.js';
  import { paginationItems } from '$lib/pagination.js';
  import {
    DEFAULT_FILTERS,
    filtersToSearch,
    PAGE_SIZE_OPTIONS,
    type RangeKey,
    type RequestsFilters,
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

  $effect(() => {
    const f = data.filters;
    range = f.range;
    status = f.status ?? '';
    decidedBy = f.decidedBy ?? '';
    lane = f.lane ?? '';
    model = f.model ?? '';
    pageSize = f.pageSize;
  });

  const totalPages = $derived(Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))));
  // The number/ellipsis row for the pager (first + last + a window around current).
  const pageItems = $derived(paginationItems(data.page, totalPages));

  // Navigate to the same route with the updated querystring. Changing any filter
  // resets to page 1 (default); the pager passes an explicit `page` to override.
  // The loader re-runs on the URL change and refetches that filtered page.
  function go(next: Partial<RequestsFilters> = {}): void {
    const f: RequestsFilters = {
      range,
      status: status || undefined,
      decidedBy: decidedBy || undefined,
      lane: lane.trim() || undefined,
      model: model.trim() || undefined,
      pageSize,
      page: 1,
      ...next,
    };
    const search = filtersToSearch(f);
    void goto(search ? `?${search}` : '?', { keepFocus: true, noScroll: true });
  }

  // Real href for a page-number link: the current filter set with the target page.
  // Rendering the numbers as <a> (not buttons) gives a native pointer cursor +
  // middle-click / open-in-new-tab; SvelteKit still navigates client-side, and
  // data-sveltekit-noscroll keeps the scroll position like the Prev/Next buttons.
  function pageHref(n: number): string {
    const search = filtersToSearch({
      range,
      status: status || undefined,
      decidedBy: decidedBy || undefined,
      lane: lane.trim() || undefined,
      model: model.trim() || undefined,
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
    go();
  }

  // Detail route for a row. The whole row is clickable (below); we also keep a
  // real <a> on the request-id cell so middle-click / open-in-new-tab / keyboard
  // still work, and the row click is a mouse convenience on top.
  function detailHref(traceId: string): string {
    return `${base}/requests/${traceId}`;
  }

  // Navigate when the row is clicked, EXCEPT when the click originates on the
  // inner request-id link — there the anchor handles its own navigation.
  function onRowClick(event: MouseEvent, traceId: string): void {
    if ((event.target as HTMLElement).closest('a')) return;
    void goto(detailHref(traceId));
  }

  // Recorded time for the "timestamp" column: format the ISO ts for the local locale;
  // '—' when the record carried none (legacy row).
  function formatTs(ts: string): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
  }

  // Distinct label styling per classification-stage decision layer (Principle 5).
  function decidedByClass(d: RequestListItem['decided_by']): string {
    switch (d) {
      case 'rules':
        return 'badge-rules';
      case 'eval':
        return 'badge-eval';
      case 'fallback':
        return 'badge-fallback';
      default: // default
        return 'badge-neutral';
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header>
    <h1 class="page-title">{$t('Requests')}</h1>
    <p class="section-desc">
      {$t(
        'Routing trail for each request — classification layer, lane, served model, fallbacks, cost and errors. Keys are shown by prefix only.',
      )}
    </p>
  </header>

  <!-- Date-range presets, pulled out as a standalone button row (the shared
       RangeFilter — identical to the dashboard window picker). Changing it applies
       immediately and resets to page 1 via go(). -->
  <RangeFilter
    value={range}
    onChange={(next) => {
      range = next;
      go();
    }}
  />

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

  <div class="card flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
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
    <div class="table-wrap">
      <table class="table-base">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2" title={$t('The unique trace ID recorded for this request.')}
              >{$t('Request ID')}</th
            >
            <th class="px-3 py-2" title={$t('When the gateway received the request.')}
              >{$t('Time')}</th
            >
            <th
              class="px-3 py-2"
              title={$t('The API key that authenticated the client, shown by prefix only.')}
              >{$t('Key')}</th
            >
            <th class="px-3 py-2" title={$t('The model the client asked for in its request.')}
              >{$t('Requested model')}</th
            >
            <th
              class="px-3 py-2"
              title={$t('Task type the classifier detected (e.g. coding, json, vision).')}
              >{$t('Task')}</th
            >
            <th
              class="px-3 py-2"
              title={$t('Estimated request difficulty used to pick a quality tier.')}
              >{$t('Complexity')}</th
            >
            <th class="px-3 py-2" title={$t('Which classification layer chose the lane.')}
              >{$t('Decided by')}</th
            >
            <th class="px-3 py-2" title={$t('The quality/cost tier the request was routed to.')}
              >{$t('Lane')}</th
            >
            <th class="px-3 py-2" title={$t('The model that actually handled the request.')}
              >{$t('Served model')}</th
            >
            <th
              class="px-3 py-2"
              title={$t('How many fallback models were tried before one succeeded.')}
              >{$t('Fallbacks')}</th
            >
            <th class="px-3 py-2" title={$t('Whether the request succeeded or returned an error.')}
              >{$t('Status')}</th
            >
            <th class="px-3 py-2" title={$t('End-to-end response time in milliseconds.')}
              >{$t('Latency')}</th
            >
            <th class="px-3 py-2" title={$t('Estimated cost of the request in US dollars.')}
              >{$t('Cost')}</th
            >
            <th class="px-3 py-2" title={$t('The error class, if the request failed.')}
              >{$t('Error')}</th
            >
          </tr>
        </thead>
        <tbody>
          {#each data.items as r (r.trace_id)}
            <!-- The whole row links to the detail page; the request-id cell keeps a
                 real <a> for keyboard / open-in-new-tab. -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <tr
              data-testid="request-row"
              class="table-row cursor-pointer"
              onclick={(e) => onRowClick(e, r.trace_id)}
            >
              <td class="px-3 py-2">
                <a
                  class="link-inline font-mono text-ink-strong"
                  href={detailHref(r.trace_id)}
                  title={r.trace_id}>{r.trace_id}</a
                >
              </td>
              <td class="px-3 py-2 text-ink-body">{formatTs(r.ts)}</td>
              <td class="px-3 py-2">
                <code class="font-mono text-ink-strong">{r.key_prefix}</code>
              </td>
              <td class="px-3 py-2 text-ink-body">{r.requested_model ?? '—'}</td>
              <td class="px-3 py-2 text-ink-body">{r.task_type || '—'}</td>
              <td class="px-3 py-2 text-ink-body">{r.complexity || '—'}</td>
              <td class="px-3 py-2">
                <span data-testid="decided-by" class={decidedByClass(r.decided_by)}
                  >{r.decided_by}</span
                >
              </td>
              <td class="px-3 py-2 text-ink-body">{r.lane || '—'}</td>
              <td class="px-3 py-2 text-ink-body">{r.final_model ?? '—'}</td>
              <td class="px-3 py-2 text-ink-body">{r.fallback_count}</td>
              <td class="px-3 py-2">
                {#if r.status === 'error'}
                  <span class="badge-error">{$t('error')}</span>
                {:else}
                  <span class="badge-ok">{$t('ok')}</span>
                {/if}
              </td>
              <td class="px-3 py-2 font-mono text-ink-body">{r.latency_ms}ms</td>
              <td class="px-3 py-2 font-mono text-ink-body">{formatUsd(r.cost_usd)}</td>
              <td class="px-3 py-2 {r.error_class ? 'text-red-600' : 'text-ink-muted'}"
                >{r.error_class ?? '—'}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

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
