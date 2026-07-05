<script lang="ts">
  import { goto } from '$app/navigation';
  import type { RequestListItem } from '$lib/api/requests.js';
  import { attemptCodeLabel } from '$lib/format/attempt-codes.js';
  import { formatTimestamp, formatTps, formatUsd } from '$lib/format.js';
  import { t } from '$lib/i18n';
  import TokensCell from './TokensCell.svelte';

  // Shared request-list table (docs/07 columns). Renders the FULL decision trail so
  // the dashboard preview and the per-key list match the canonical /requests view —
  // one place to add a column, not three (the drift that lost Task/Complexity/
  // Fallbacks/TPS/Error on the other two). Read-only projection: every cell is a
  // field the backend recorded, nothing recomputed (Principle 1); the key shows by
  // prefix only (Principle 7); `decided_by` (classification) stays distinct from
  // `fallback_count` (execution) (Principle 5).
  //
  // Per-caller knobs: `detailHref` builds the row link (the `from`/Back target
  // differs per page). The Key cell filters by key two ways: `onKeyFilter` makes it
  // an in-page filter <button> (the /requests list updates its own querystring),
  // `keyHref` makes it an <a> linking to the filtered list (the dashboard, which has
  // no in-page filter) — pass one or the other. The Key column is dropped on a page
  // already scoped to a single key (`showKey={false}`).
  let {
    items,
    detailHref,
    onKeyFilter,
    keyHref,
    showKey,
    variant = 'full',
  }: {
    items: RequestListItem[];
    detailHref: (traceId: string) => string;
    onKeyFilter?: (keyId: string) => void;
    keyHref?: (keyId: string) => string;
    showKey?: boolean;
    variant?: 'recent' | 'full' | 'key';
  } = $props();

  const visibleKey = $derived(showKey ?? variant !== 'key');
  const visibleRequestId = $derived(variant === 'full');

  // Navigate when the row is clicked, EXCEPT when the click originates on an inner
  // control (the request-id <a> and the key-filter <button> handle their own click).
  function onRowClick(event: MouseEvent, traceId: string): void {
    if ((event.target as HTMLElement).closest('a, button')) return;
    void goto(detailHref(traceId));
  }

  function formatTs(ts: string): string {
    return formatTimestamp(ts) || '—';
  }

  // Distinct label styling per classification-stage decision layer (Principle 5).
  function decidedByClass(d: RequestListItem['decided_by']): string {
    switch (d) {
      case 'rules':
        return 'badge-rules';
      case 'eval':
        return 'badge-eval';
      case 'fallback':
        return 'badge-classifier-fallback';
      default: // default
        return 'badge-neutral';
    }
  }

  function accountTitle(account: RequestListItem['serving_account']): string | undefined {
    return account ? `${account.provider_id}/${account.account}` : undefined;
  }

  function requestedModel(r: RequestListItem): string | null {
    if (!r.requested_model) return null;
    if (r.requested_model === 'auto') return null;
    if (r.status !== 'error' && r.requested_model === r.final_model) return null;
    return r.requested_model;
  }

  function servedModel(r: RequestListItem): string {
    if (r.status === 'error') return $t('not served');
    return r.final_model ?? '—';
  }

  function servingProvider(r: RequestListItem): string {
    if (r.status === 'error' && !r.served_provider) return $t('not served');
    return r.served_provider ?? '—';
  }
</script>

<!-- Key cell contents (name + prefix subtitle, or bare prefix). Shared between the
     clickable filter button and the non-clickable label. -->
{#snippet keyLabel(r: RequestListItem)}
  {#if r.key_name}
    <span class="text-ink-strong" title={r.key_prefix}>{r.key_name}</span>
    <code class="block font-mono text-xs text-ink-muted">{r.key_prefix}</code>
  {:else}
    <code class="font-mono text-ink-strong">{r.key_prefix}</code>
  {/if}
  <span aria-hidden="true"> </span>
{/snippet}

{#snippet timeCell(r: RequestListItem)}
  {#if visibleRequestId}
    {formatTs(r.ts)}
  {:else}
    <a
      data-testid="request-detail-link"
      class="link-inline font-mono text-ink-strong"
      href={detailHref(r.trace_id)}
      title={r.trace_id}
    >
      {formatTs(r.ts)}
    </a>
  {/if}
{/snippet}

{#snippet resultCell(r: RequestListItem)}
  <div data-testid="cell-result" class="leading-tight">
    {#if r.status === 'error'}
      <span class="badge-error">{$t('error')}</span>
      {#if r.error_class}
        <div class="mt-1 max-w-[12rem] truncate text-xs text-red-600" title={r.error_class}>
          {$t(attemptCodeLabel(r.error_class))}
        </div>
      {/if}
    {:else}
      <span class="badge-ok">{$t('ok')}</span>
    {/if}
  </div>
{/snippet}

{#snippet modelCell(r: RequestListItem)}
  <div data-testid="cell-model" class="leading-tight">
    <div
      class="max-w-[16rem] truncate font-mono text-ink-strong"
      title={r.final_model ?? undefined}
    >
      {servedModel(r)}
    </div>
    {#if requestedModel(r)}
      <div
        class="mt-1 max-w-[16rem] truncate font-mono text-xs text-ink-muted"
        title={r.requested_model ?? undefined}
      >
        {$t('requested:')}
        {r.requested_model}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet routingCell(r: RequestListItem)}
  <div data-testid="cell-routing" class="leading-tight">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="badge-neutral">{r.lane || '—'}</span>
      <span
        data-testid="decided-by"
        class={decidedByClass(r.decided_by)}
        title={$t('Classification-stage decision source')}
      >
        {r.decided_by}
      </span>
    </div>
    <div class="mt-1 text-xs text-ink-muted">
      {r.task_type || '—'}{#if r.complexity}
        · {r.complexity}{/if}
    </div>
  </div>
{/snippet}

{#snippet servingCell(r: RequestListItem)}
  <div data-testid="cell-serving" class="leading-tight">
    <div class="flex flex-wrap items-center gap-1.5">
      <span
        class="max-w-[12rem] truncate font-mono text-ink-body"
        title={accountTitle(r.serving_account) ?? r.served_provider ?? undefined}
      >
        {servingProvider(r)}
      </span>
      {#if r.fallback_count > 0}
        <span class="badge-fallback" title={$t('Execution fallback count')}>
          {$t('exec +{n}', { n: r.fallback_count })}
        </span>
      {/if}
    </div>
    {#if r.serving_account}
      <div
        class="mt-1 max-w-[12rem] truncate font-mono text-xs text-ink-muted"
        title={accountTitle(r.serving_account)}
      >
        {r.serving_account.account}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet performanceCell(r: RequestListItem)}
  <div data-testid="cell-performance" class="font-mono text-xs leading-tight">
    <div>{r.latency_ms}ms</div>
    <div data-testid="cell-tps" class="text-ink-muted">{formatTps(r.tps)}</div>
  </div>
{/snippet}

<div class="cards-table-frame">
  <table class="cards-table">
    <thead class="table-head">
      <tr>
        <th class="px-3 py-2" title={$t('When the gateway received the request.')}>{$t('Time')}</th>
        <th
          class="px-3 py-2"
          title={$t('Whether the request succeeded, with the final error class when it failed.')}
          >{$t('Result')}</th
        >
        {#if visibleKey}
          <th
            class="px-3 py-2"
            title={$t('The API key that authenticated the client, shown by prefix only.')}
            >{$t('Key')}</th
          >
        {/if}
        <th
          class="px-3 py-2"
          title={$t('The model that served the request, with the requested model when different.')}
          >{$t('Model')}</th
        >
        <th
          class="px-3 py-2"
          title={$t('Classification result: lane, decision source, task, and complexity.')}
          >{$t('Routing')}</th
        >
        <th class="px-3 py-2" title={$t('Provider, account, and execution fallback count.')}
          >{$t('Serving')}</th
        >
        <th class="px-3 py-2" title={$t('Estimated cost of the request in US dollars.')}
          >{$t('Cost')}</th
        >
        <th class="px-3 py-2" title={$t('Token usage: input / output, with cached input tokens.')}
          >{$t('Tokens')}</th
        >
        <th class="px-3 py-2" title={$t('End-to-end latency and streamed generation throughput.')}
          >{$t('Performance')}</th
        >
        {#if visibleRequestId}
          <th class="px-3 py-2" title={$t('The unique trace ID recorded for this request.')}
            >{$t('Request ID')}</th
          >
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each items as r (r.trace_id)}
        <!-- The whole row links to the detail page; full view keeps the request-id
             <a>, while compact views keep a real detail <a> in the time cell. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <tr
          data-testid="request-row"
          class="cursor-pointer"
          onclick={(e) => onRowClick(e, r.trace_id)}
        >
          <td data-label={$t('Time')} class="px-3 py-2 text-ink-body">
            {@render timeCell(r)}
          </td>
          <td data-label={$t('Result')} class="px-3 py-2">
            {@render resultCell(r)}
          </td>
          {#if visibleKey}
            <td data-label={$t('Key')} class="px-3 py-2">
              {#if r.key_id && onKeyFilter}
                <!-- In-page filter (the /requests list): a <button> updates the
                     querystring; onRowClick lets it handle the click, not the row. -->
                <button
                  type="button"
                  data-testid="key-filter"
                  class="block text-left hover:underline"
                  title={$t('Filter by this key')}
                  onclick={() => onKeyFilter(r.key_id!)}
                >
                  {@render keyLabel(r)}
                </button>
              {:else if r.key_id && keyHref}
                <!-- Cross-page: link to the full requests list filtered by this key
                     (the dashboard has no in-page filter). A real <a> → open-in-new-tab. -->
                <a
                  data-testid="key-filter"
                  class="block text-left hover:underline"
                  title={$t('Filter by this key')}
                  href={keyHref(r.key_id)}
                >
                  {@render keyLabel(r)}
                </a>
              {:else}
                {@render keyLabel(r)}
              {/if}
            </td>
          {/if}
          <td data-label={$t('Model')} class="px-3 py-2">
            {@render modelCell(r)}
          </td>
          <td data-label={$t('Routing')} class="px-3 py-2">
            {@render routingCell(r)}
          </td>
          <td data-label={$t('Serving')} class="px-3 py-2">
            {@render servingCell(r)}
          </td>
          <td data-label={$t('Cost')} class="px-3 py-2 font-mono text-ink-body">
            {formatUsd(r.cost_usd)}
          </td>
          <td data-label={$t('Tokens')} class="px-3 py-2"><TokensCell usage={r.usage} /></td>
          <td data-label={$t('Performance')} class="px-3 py-2">
            {@render performanceCell(r)}
          </td>
          {#if visibleRequestId}
            <td data-label={$t('Request ID')} class="px-3 py-2">
              <a
                data-testid="request-detail-link"
                class="link-inline block max-w-[7rem] truncate font-mono text-ink-strong lg:max-w-none"
                href={detailHref(r.trace_id)}
                title={r.trace_id}>{r.trace_id}</a
              >
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
