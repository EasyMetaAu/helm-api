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
    showKey = true,
  }: {
    items: RequestListItem[];
    detailHref: (traceId: string) => string;
    onKeyFilter?: (keyId: string) => void;
    keyHref?: (keyId: string) => string;
    showKey?: boolean;
  } = $props();

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
        return 'badge-fallback';
      default: // default
        return 'badge-neutral';
    }
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
{/snippet}

<div class="table-wrap">
  <table class="table-base">
    <thead class="table-head">
      <tr>
        <th class="px-3 py-2" title={$t('The unique trace ID recorded for this request.')}
          >{$t('Request ID')}</th
        >
        <th class="px-3 py-2" title={$t('When the gateway received the request.')}>{$t('Time')}</th>
        {#if showKey}
          <th
            class="px-3 py-2"
            title={$t('The API key that authenticated the client, shown by prefix only.')}
            >{$t('Key')}</th
          >
        {/if}
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
        <th
          class="px-3 py-2"
          title={$t(
            'Generation throughput: output tokens per second. Only measured for streamed responses.',
          )}>{$t('TPS')}</th
        >
        <th class="px-3 py-2" title={$t('Token usage: input / output, with cached input tokens.')}
          >{$t('Tokens')}</th
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
      {#each items as r (r.trace_id)}
        <!-- The whole row links to the detail page; the request-id cell keeps a real
             <a> for keyboard / open-in-new-tab. -->
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
          {#if showKey}
            <td class="px-3 py-2">
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
          <td class="px-3 py-2 text-ink-body">{r.requested_model ?? '—'}</td>
          <td class="px-3 py-2 text-ink-body">{r.task_type || '—'}</td>
          <td class="px-3 py-2 text-ink-body">{r.complexity || '—'}</td>
          <td class="px-3 py-2">
            <span data-testid="decided-by" class={decidedByClass(r.decided_by)}>{r.decided_by}</span
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
          <td data-testid="cell-tps" class="px-3 py-2 font-mono text-ink-body"
            >{formatTps(r.tps)}</td
          >
          <td class="px-3 py-2"><TokensCell usage={r.usage} /></td>
          <td class="px-3 py-2 font-mono text-ink-body">{formatUsd(r.cost_usd)}</td>
          <td
            class="px-3 py-2 {r.error_class ? 'text-red-600' : 'text-ink-muted'}"
            title={r.error_class ?? undefined}
            >{r.error_class ? $t(attemptCodeLabel(r.error_class)) : '—'}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
</div>
