<script lang="ts">
  import { untrack } from "svelte";
  import { type Fact, type MemoryStatus, updateFact } from "$lib/api/memory.js";
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";

  let {
    fact,
    onsaved,
    onclose,
  }: {
    fact: Fact;
    onsaved: (fact: Fact) => void;
    onclose: () => void;
  } = $props();

  let factText = $state(untrack(() => fact.factText));
  let importance = $state<number>(untrack(() => fact.importance));
  let status = $state<MemoryStatus>(untrack(() => fact.status));
  let error = $state<string | null>(null);
  let saving = $state(false);

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    try {
      const updated = await updateFact(fact.id, {
        text: factText.trim(),
        importance: importance ?? fact.importance,
        status,
      });
      onsaved(updated);
    } catch (e) {
      error = e instanceof Error ? e.message : $t("Failed to update fact");
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t("Edit fact")} {onclose}>
  <h2 class="section-header">{$t("Edit fact")}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  <div class="mt-3 flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <span class="field-label">{$t("Subject")}</span>
      <code class="font-mono text-ink-strong">{fact.subjectKey || "—"}</code>
      <span class="field-help">
        {$t(
          "The subject is fixed — it identifies which fact a newer one supersedes.",
        )}
      </span>
    </div>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Fact text")}</span>
      <textarea
        class="input"
        rows="4"
        aria-label={$t("Fact text")}
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

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Status")}</span>
      <select class="select w-40" aria-label={$t("Status")} bind:value={status}>
        <option value="active">{$t("Active")}</option>
        <option value="archived">{$t("Archived")}</option>
        <option value="pruned">{$t("Pruned")}</option>
      </select>
    </label>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}
      >{$t("Cancel")}</button
    >
    <button
      type="button"
      class="btn-primary"
      disabled={saving || !factText.trim()}
      onclick={handleSave}
    >
      {$t("Save changes")}
    </button>
  </div>
</Modal>
