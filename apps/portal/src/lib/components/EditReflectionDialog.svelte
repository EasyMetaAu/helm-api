<script lang="ts">
  import { untrack } from "svelte";
  import { type Reflection, updateReflection } from "$lib/api/memory.js";
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";

  let {
    reflection,
    onsaved,
    onclose,
  }: {
    reflection: Reflection;
    onsaved: (reflection: Reflection) => void;
    onclose: () => void;
  } = $props();

  let reflectionText = $state(untrack(() => reflection.reflectionText));
  let error = $state<string | null>(null);
  let saving = $state(false);

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    try {
      const updated = await updateReflection(
        reflection.id,
        reflectionText.trim(),
      );
      onsaved(updated);
    } catch (e) {
      error =
        e instanceof Error ? e.message : $t("Failed to update reflection");
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t("Edit reflection")} {onclose} wide>
  <h2 class="section-header">{$t("Edit reflection")}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  <div class="mt-3 flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Reflection text")}</span>
      <textarea
        class="input"
        rows="8"
        aria-label={$t("Reflection text")}
        bind:value={reflectionText}
      ></textarea>
    </label>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}
      >{$t("Cancel")}</button
    >
    <button
      type="button"
      class="btn-primary"
      disabled={saving || !reflectionText.trim()}
      onclick={handleSave}
    >
      {$t("Save changes")}
    </button>
  </div>
</Modal>
