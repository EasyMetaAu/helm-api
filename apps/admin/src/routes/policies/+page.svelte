<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { type Policy, savePolicies, TASK_TYPE_OPTIONS } from '$lib/api/policies.js';
  import PolicyRow from '$lib/components/PolicyRow.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  // The page owns the ORDERED working list — order IS the match priority
  // (docs/04 first-match). It contains NO matching logic (Principle 1/Principle 5): it only
  // edits/reorders the list and writes the whole set back via the API client.
  let { data }: { data: { policies: Policy[]; lanes?: string[] } } = $props();

  let policies = $state<Policy[]>(untrack(() => data.policies.map((p) => ({ ...p }))));
  // Lane names for the action dropdowns. Falls back to the well-known set when
  // the load didn't supply them (the gateway is the source of truth on save).
  const lanes = untrack(() => data.lanes ?? ['economy', 'balanced', 'premium', 'coding']);

  let error = $state<string | null>(null);
  let saving = $state(false);
  let saved = $state(false);

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

  async function addRow(): Promise<void> {
    // New rule defaults to a concrete action so it is never a silent no-op
    // (server requires at least one of use_lane/max_lane). Appended LAST so it
    // gets the lowest priority (first-match order) and can't shadow existing rules.
    policies = [...policies, { match: { task_type: TASK_TYPE_OPTIONS[0] }, use_lane: lanes[0] }];
    // The new row appends to the end of a potentially long list, so the click can
    // land below the fold and look like a no-op. Scroll it into view for
    // immediate feedback.
    await tick();
    const rows = document.querySelectorAll('[data-testid="policy-row"]');
    rows[rows.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Whole-set PUT (preserves priority order; avoids per-item patch losing it).
  // On failure: fail-closed — surface the error, keep the current working list.
  async function handleSave(): Promise<void> {
    error = null;
    saved = false;
    saving = true;
    try {
      const result = await savePolicies(policies);
      policies = result.map((p) => ({ ...p }));
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to save policies');
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Policies')}</h1>
      <p class="section-desc">
        {$t(
          'Server-side routing rules. Each is a condition → action (force or cap a lane). Policies override task lanes but never the execution fallback chain.',
        )}
      </p>
    </div>
    <p class="card text-sm text-ink-body" data-testid="first-match-explainer">
      {$t('Rules are evaluated top to bottom; the')}
      <strong>{$t('first matching')}</strong>
      {$t(
        'rule wins (first-match). Order is the priority — drag a rule up to give it precedence. Rules apply in plain order, not by any weighting.',
      )}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if policies.length === 0}
    <div class="empty-state" data-testid="policies-empty">
      <p class="font-medium text-ink-body">{$t('No policies yet')}</p>
      <p class="mt-1 text-sm text-ink-muted">
        {$t(
          'Without a policy, requests are routed only by their task lane. Add a policy to force or cap a lane for matching requests.',
        )}
      </p>
    </div>
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

  <div
    class="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-border bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
  >
    <button type="button" class="btn-secondary" onclick={addRow}>{$t('Add policy')}</button>
    <div class="flex items-center gap-3">
      {#if saved}
        <span class="badge-ok" data-testid="policies-saved" role="status">{$t('Saved')}</span>
      {/if}
      <button type="button" class="btn-primary" onclick={handleSave} disabled={saving}
        >{$t('Save policies')}</button
      >
    </div>
  </div>
</section>
