<script lang="ts">
  import { createFact, type FactCreateResult } from "$lib/api/memory.js";
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";

  let {
    onsaved,
    onclose,
  }: {
    onsaved: (result: FactCreateResult) => void;
    onclose: () => void;
  } = $props();

  let subjectText = $state("");
  let factText = $state("");
  let importance = $state<number>(0.5);
  let error = $state<string | null>(null);
  let saving = $state(false);

  const canSave = $derived(
    subjectText.trim().length > 0 && factText.trim().length > 0,
  );

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    try {
      const result = await createFact(
        subjectText.trim(),
        factText.trim(),
        importance,
      );
      onsaved(result);
    } catch (e) {
      error = e instanceof Error ? e.message : $t("Failed to create fact");
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t("Add fact")} {onclose}>
  <h2 class="section-header">{$t("Add fact")}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  <div class="mt-3 flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Subject")}</span>
      <input
        type="text"
        class="input"
        aria-label={$t("Subject")}
        placeholder={$t("e.g. favorite number")}
        bind:value={subjectText}
      />
      <span class="field-help">
        {$t(
          "A short topic — a newer fact with the same subject replaces this one.",
        )}
      </span>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Fact text")}</span>
      <textarea
        class="input"
        rows="4"
        aria-label={$t("Fact text")}
        placeholder={$t("e.g. The user's favorite number is 42.")}
        bind:value={factText}
      ></textarea>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Importance")}</span>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        class="input-sm w-28"
        aria-label={$t("Importance")}
        bind:value={importance}
      />
      <span class="field-help"
        >{$t("0 to 1 — higher means Helm favors recalling it.")}</span
      >
    </label>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}
      >{$t("Cancel")}</button
    >
    <button
      type="button"
      class="btn-primary"
      disabled={saving || !canSave}
      onclick={handleSave}
    >
      {$t("Add fact")}
    </button>
  </div>
</Modal>
