<script lang="ts">
  import { untrack } from 'svelte';
  import { saveLanes, type Lane } from '$lib/api/lanes.js';
  import type { ModelOption } from '$lib/api/models.js';
  import LaneEditor from '$lib/components/LaneEditor.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  // `models` is the routable-model catalog (alias + exposing accounts) the editor
  // offers as combobox suggestions; it defaults to [] so older callers/tests work.
  let { data }: { data: { lanes: Lane[]; models?: ModelOption[]; defaultLane?: string } } =
    $props();
  const models = $derived(data.models ?? []);
  const defaultLane = untrack(() => data.defaultLane ?? 'balanced');

  // Seed the working list from the loaded data once; thereafter the page owns it.
  let lanes = $state<Lane[]>(untrack(() => data.lanes));
  // Every lane name, so each card can offer the OTHERS as chain targets (a chain
  // element may reference another lane, not just a model). Names are immutable in
  // this editor (saves map by name), so this stays stable across edits.
  const laneNames = $derived(lanes.map((l) => l.name));
  const valid = $derived(
    lanes.some((lane) => lane.name === defaultLane) &&
      lanes.every((lane) => lane.primary.trim().length > 0),
  );
  let error = $state<string | null>(null);
  let saving = $state(false);
  let saved = $state(false);

  function handleChange(next: Lane): void {
    lanes = lanes.map((lane) => (lane.name === next.name ? next : lane));
    saved = false;
  }

  function handleDelete(name: string): void {
    lanes = lanes.filter((lane) => lane.name !== name);
    saved = false;
  }

  // Whole-set PUT: edits, fallback order, and removals commit together.
  async function handleSave(): Promise<void> {
    if (!valid) return;
    error = null;
    saved = false;
    saving = true;
    try {
      lanes = await saveLanes(lanes);
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to save lane');
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header>
    <h1 class="page-title">{$t('Lanes')}</h1>
    <p class="section-desc">
      {$t(
        'A lane is a quality/cost tier (like economy, balanced, or premium). Each lane has one primary model and an ordered fallback chain that is tried when the primary is unavailable.',
      )}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if lanes.length === 0}
    <div class="empty-state">
      {$t('No lanes are configured yet.')}
    </div>
  {:else}
    <div class="flex flex-col gap-4">
      {#each lanes as lane (lane.name)}
        <LaneEditor
          {lane}
          {models}
          {laneNames}
          canDelete={lane.name !== defaultLane}
          onchange={handleChange}
          ondelete={handleDelete}
        />
      {/each}
    </div>
  {/if}

  <div
    class="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
  >
    {#if saved}
      <span class="badge-ok" data-testid="lanes-saved" role="status">{$t('Saved')}</span>
    {/if}
    <button type="button" class="btn-primary" onclick={handleSave} disabled={saving || !valid}
      >{$t('Save')}</button
    >
  </div>
</section>
