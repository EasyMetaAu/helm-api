<script lang="ts">
  import { untrack } from 'svelte';
  import { type Reflection, updateReflection } from '$lib/api/memory.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Edit-reflection dialog (docs/13): edits the reflection text IN PLACE. The
  // server recomputes the token estimate + stamps updatedAt but does NOT bump
  // `version` (that stays the machine-merge counter). The updated row bubbles up
  // via `onsaved`.
  let {
    reflection,
    onsaved,
    onclose,
  }: {
    reflection: Reflection;
    onsaved: (reflection: Reflection) => void;
    onclose: () => void;
  } = $props();

  // Captured once at mount (remounted per edit — see EditFactDialog).
  let reflectionText = $state(untrack(() => reflection.reflectionText));

  let error = $state<string | null>(null);
  let saving = $state<boolean>(false);

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    try {
      const updated = await updateReflection(reflection.id, {
        reflectionText: reflectionText.trim(),
      });
      onsaved(updated);
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update reflection');
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t('Edit reflection')} {onclose} wide>
  <h2 class="section-header">{$t('Edit reflection')}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  <div class="mt-3 flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Reflection text')}</span>
      <textarea
        class="input"
        rows="8"
        aria-label={$t('Reflection text')}
        bind:value={reflectionText}
      ></textarea>
    </label>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
    <button type="button" class="btn-primary" disabled={saving} onclick={handleSave}
      >{$t('Save changes')}</button
    >
  </div>
</Modal>
