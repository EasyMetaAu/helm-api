<script lang="ts">
  import { untrack } from 'svelte';
  import { saveLane, type Lane } from '$lib/api/lanes.js';
  import LaneEditor from '$lib/components/LaneEditor.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  // `models` is the routable-alias catalog the editor offers as combobox
  // suggestions; it defaults to [] so older callers/tests without it still work.
  let { data }: { data: { lanes: Lane[]; models?: string[] } } = $props();
  const models = $derived(data.models ?? []);

  // Seed the working list from the loaded data once; thereafter the page owns it.
  let lanes = $state<Lane[]>(untrack(() => data.lanes));
  // Every lane name, so each card can offer the OTHERS as chain targets (a chain
  // element may reference another lane, not just a model). Names are immutable in
  // this editor (saves map by name), so this stays stable across edits.
  const laneNames = $derived(lanes.map((l) => l.name));
  let error = $state<string | null>(null);
  let savingName = $state<string | null>(null);

  // Whole-lane PUT (avoids concurrent-patch field loss). On failure: fail-closed
  // — surface the error and leave the displayed lane data unchanged.
  async function handleSave(name: string, body: Lane): Promise<void> {
    error = null;
    savingName = name;
    try {
      const saved = await saveLane(name, body);
      // Server echoes the persisted lane; fall back to the submitted body so the
      // list stays consistent even if the response is empty.
      const next = saved ?? body;
      lanes = lanes.map((l) => (l.name === name ? next : l));
    } catch (e) {
      // Surface a page-level alert AND re-throw so the editor leaves its per-card
      // "Saved" flag off (fail-closed: no false success on a rejected write).
      error = e instanceof Error ? e.message : $t('Failed to save lane');
      throw e;
    } finally {
      savingName = null;
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
        <LaneEditor {lane} {models} {laneNames} onsave={handleSave} />
      {/each}
    </div>
  {/if}
</section>
