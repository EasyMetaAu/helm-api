<script lang="ts">
  import { untrack } from 'svelte';
  import { base } from '$app/paths';
  import { listRequests, type RequestListItem } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Request debug list (docs/07 列表). READ-ONLY consumer of /admin/api/* — every
  // column is a field the backend recorded; nothing is recomputed (原则1). 原则7:
  // the key is shown by display prefix only, never plaintext. 原则5: `decided_by`
  // (classification stage) is shown distinctly from `fallback_count` (execution
  // stage).
  let { data }: { data: { items: RequestListItem[]; nextCursor?: string } } = $props();

  let items = $state<RequestListItem[]>(untrack(() => data.items));
  let nextCursor = $state<string | undefined>(untrack(() => data.nextCursor));
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Distinct label styling per classification-stage decision layer (原则5).
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

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    loading = true;
    error = null;
    try {
      const res = await listRequests({ cursor: nextCursor });
      items = [...items, ...res.items];
      nextCursor = res.nextCursor;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to load more requests');
    } finally {
      loading = false;
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

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if items.length === 0}
    <div data-testid="requests-empty" class="empty-state">
      <p class="font-medium text-ink-body">{$t('No requests recorded yet.')}</p>
      <p class="mt-1 text-ink-muted">
        {$t('Once clients send traffic through the gateway, every routing decision shows up here.')}
      </p>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="table-base">
        <thead class="table-head">
          <tr>
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
            <th class="px-3 py-2"><span class="sr-only">{$t('Details')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each items as r (r.trace_id)}
            <tr data-testid="request-row" class="table-row">
              <td class="px-3 py-2 text-ink-body">{r.ts || '—'}</td>
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
              <td class="px-3 py-2 font-mono text-ink-body">${r.cost_usd.toFixed(4)}</td>
              <td class="px-3 py-2 {r.error_class ? 'text-red-600' : 'text-ink-muted'}"
                >{r.error_class ?? '—'}</td
              >
              <td class="px-3 py-2">
                <a class="link-inline" href={`${base}/requests/${r.trace_id}`}>{$t('view')}</a>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if nextCursor}
    <div class="flex justify-center">
      <button type="button" class="btn-secondary" disabled={loading} onclick={loadMore}
        >{loading ? $t('Loading…') : $t('Load more')}</button
      >
    </div>
  {/if}
</section>
