<script lang="ts">
  // Loading placeholder shown in the content area during a page-to-page navigation
  // that outlasts the layout's grace delay. Pure presentation — no text, no data,
  // no i18n (aria-hidden). The global shell (sidebar + header) stays put, so only
  // this inner region swaps. Three coarse shapes keep the swap from being jarring
  // without per-page bespoke skeletons.
  let { variant = 'list' }: { variant?: 'list' | 'detail' | 'dashboard' } = $props();

  const rows = Array.from({ length: 10 }, (_, i) => i);
  const cards = Array.from({ length: 4 }, (_, i) => i);
</script>

<div class="w-full px-4 py-6 md:px-8" data-testid="page-skeleton" aria-hidden="true">
  <!-- Title block — common to every page -->
  <div class="mb-6 space-y-2">
    <div class="h-6 w-48 animate-pulse rounded bg-slate-200"></div>
    <div class="h-3 w-72 animate-pulse rounded bg-slate-100"></div>
  </div>

  {#if variant === 'dashboard'}
    <div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      {#each cards as i (i)}
        <div class="h-24 animate-pulse rounded-lg bg-slate-100"></div>
      {/each}
    </div>
    <div class="h-72 animate-pulse rounded-lg bg-slate-100"></div>
  {:else if variant === 'detail'}
    <div class="space-y-4">
      {#each cards as i (i)}
        <div class="h-28 animate-pulse rounded-lg bg-slate-100"></div>
      {/each}
    </div>
  {:else}
    <!-- list: filter bar + table rows -->
    <div class="mb-4 flex flex-wrap gap-2">
      {#each cards as i (i)}
        <div class="h-9 w-28 animate-pulse rounded bg-slate-100"></div>
      {/each}
    </div>
    <div class="space-y-2">
      {#each rows as i (i)}
        <div class="h-12 animate-pulse rounded bg-slate-100"></div>
      {/each}
    </div>
  {/if}
</div>
