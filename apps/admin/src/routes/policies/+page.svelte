<script lang="ts">
  import { untrack } from 'svelte';
  import { type Policy, savePolicies, TASK_TYPE_OPTIONS } from '$lib/api/policies.js';
  import PolicyRow from '$lib/components/PolicyRow.svelte';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  // The page owns the ORDERED working list — order IS the match priority
  // (docs/04 first-match). It contains NO matching logic (原则1/原则5): it only
  // edits/reorders the list and writes the whole set back via the API client.
  let { data }: { data: { policies: Policy[]; lanes?: string[] } } = $props();

  let policies = $state<Policy[]>(untrack(() => data.policies.map((p) => ({ ...p }))));
  // Lane names for the action dropdowns. Falls back to the well-known set when
  // the load didn't supply them (the gateway is the source of truth on save).
  const lanes = untrack(() => data.lanes ?? ['economy', 'balanced', 'premium', 'coding']);

  let error = $state<string | null>(null);
  let saving = $state(false);

  function updateRow(index: number, next: Policy): void {
    policies = policies.map((p, i) => (i === index ? next : p));
  }

  function removeRow(index: number): void {
    policies = policies.filter((_, i) => i !== index);
  }

  function moveRow(from: number, to: number): void {
    if (to < 0 || to >= policies.length) return;
    const next = [...policies];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    policies = next;
  }

  function addRow(): void {
    // New rule defaults to a concrete action so it is never a silent no-op
    // (server requires at least one of use_lane/max_lane).
    policies = [...policies, { match: { task_type: TASK_TYPE_OPTIONS[0] }, use_lane: lanes[0] }];
  }

  // Whole-set PUT (preserves priority order; avoids per-item patch losing it).
  // On failure: fail-closed — surface the error, keep the current working list.
  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    try {
      const saved = await savePolicies(policies);
      policies = saved.map((p) => ({ ...p }));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save policies';
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header>
    <h1 class="text-2xl font-semibold text-slate-900">Policies</h1>
    <p class="text-sm text-slate-500">
      Server-side routing rules. Each is a condition → action (force or cap a lane). Policies
      override task lanes but never the execution fallback chain.
    </p>
    <p
      class="mt-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
      data-testid="first-match-explainer"
    >
      Rules are evaluated top to bottom; the <strong>first matching</strong> rule wins (first-match).
      Order is the priority — drag a rule up to give it precedence. Rules apply in plain order, not by
      any weighting.
    </p>
  </header>

  {#if error}
    <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  {/if}

  <div class="flex flex-col gap-4">
    {#each policies as policy, i (i)}
      <PolicyRow
        {policy}
        index={i}
        total={policies.length}
        {lanes}
        onchange={(next) => updateRow(i, next)}
        onremove={removeRow}
        onmove={moveRow}
      />
    {/each}
  </div>

  <div class="flex gap-2">
    <button
      type="button"
      class="rounded bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-800"
      onclick={addRow}>Add policy</button
    >
    <button
      type="button"
      class="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      onclick={handleSave}
      disabled={saving}>Save policies</button
    >
  </div>
</section>
