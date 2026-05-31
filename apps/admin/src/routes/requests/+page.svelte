<script lang="ts">
  import { untrack } from 'svelte';
  import { base } from '$app/paths';
  import { listRequests, type RequestListItem } from '$lib/api/requests.js';

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
        return 'bg-sky-100 text-sky-700';
      case 'eval':
        return 'bg-violet-100 text-violet-700';
      case 'fallback':
        return 'bg-amber-100 text-amber-800';
      default: // default
        return 'bg-slate-200 text-slate-600';
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
      error = e instanceof Error ? e.message : 'Failed to load more requests';
    } finally {
      loading = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header>
    <h1 class="text-2xl font-semibold text-slate-900">Requests</h1>
    <p class="text-sm text-slate-500">
      Routing trail for each request — classification layer, lane, final model, fallbacks, cost and
      errors. Keys are shown by prefix only.
    </p>
  </header>

  {#if error}
    <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  {/if}

  {#if items.length === 0}
    <div
      data-testid="requests-empty"
      class="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500"
    >
      No requests recorded yet.
    </div>
  {:else}
    <div class="overflow-x-auto rounded-lg border border-slate-200">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-3 py-2">Time</th>
            <th class="px-3 py-2">Key</th>
            <th class="px-3 py-2">Requested</th>
            <th class="px-3 py-2">Task</th>
            <th class="px-3 py-2">Complexity</th>
            <th class="px-3 py-2">Decided by</th>
            <th class="px-3 py-2">Lane</th>
            <th class="px-3 py-2">Final model</th>
            <th class="px-3 py-2">Fallbacks</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Latency</th>
            <th class="px-3 py-2">Cost</th>
            <th class="px-3 py-2">Error</th>
          </tr>
        </thead>
        <tbody>
          {#each items as r (r.trace_id)}
            <tr data-testid="request-row" class="border-t border-slate-100 hover:bg-slate-50">
              <td class="px-3 py-2 text-slate-600">{r.ts || '—'}</td>
              <td class="px-3 py-2">
                <code class="font-mono text-slate-800">{r.key_prefix}</code>
              </td>
              <td class="px-3 py-2 text-slate-700">{r.requested_model ?? '—'}</td>
              <td class="px-3 py-2 text-slate-700">{r.task_type || '—'}</td>
              <td class="px-3 py-2 text-slate-700">{r.complexity || '—'}</td>
              <td class="px-3 py-2">
                <span
                  data-testid="decided-by"
                  class="rounded px-2 py-0.5 text-xs font-medium {decidedByClass(r.decided_by)}"
                  >{r.decided_by}</span
                >
              </td>
              <td class="px-3 py-2 text-slate-700">{r.lane || '—'}</td>
              <td class="px-3 py-2 text-slate-700">{r.final_model ?? '—'}</td>
              <td class="px-3 py-2 text-slate-700">{r.fallback_count}</td>
              <td class="px-3 py-2">
                {#if r.status === 'error'}
                  <span class="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                    >error</span
                  >
                {:else}
                  <span
                    class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                    >ok</span
                  >
                {/if}
              </td>
              <td class="px-3 py-2 text-slate-600">{r.latency_ms}ms</td>
              <td class="px-3 py-2 font-mono text-slate-700">${r.cost_usd.toFixed(4)}</td>
              <td class="px-3 py-2 text-red-600">{r.error_class ?? '—'}</td>
              <td class="px-3 py-2">
                <a class="text-sky-600 hover:underline" href={`${base}/requests/${r.trace_id}`}
                  >view</a
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if nextCursor}
    <div class="flex justify-center">
      <button
        type="button"
        class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        disabled={loading}
        onclick={loadMore}>{loading ? 'Loading…' : 'Load more'}</button
      >
    </div>
  {/if}
</section>
