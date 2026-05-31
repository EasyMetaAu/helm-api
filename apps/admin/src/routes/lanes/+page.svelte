<script lang="ts">
  import { untrack } from 'svelte';
  import { saveLane, type Lane } from '$lib/api/lanes.js';
  import LaneEditor from '$lib/components/LaneEditor.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests).
  let { data }: { data: { lanes: Lane[] } } = $props();

  // Seed the working list from the loaded data once; thereafter the page owns it.
  let lanes = $state<Lane[]>(untrack(() => data.lanes));
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
    <h1 class="text-2xl font-semibold text-slate-900">{$t('Lanes')}</h1>
    <p class="text-sm text-slate-500">
      {$t("View and fine-tune each lane's primary → fallback chain and constraints.")}
    </p>
  </header>

  {#if error}
    <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  {/if}

  <div class="flex flex-col gap-4">
    {#each lanes as lane (lane.name)}
      <LaneEditor {lane} onsave={handleSave} />
    {/each}
  </div>
</section>
