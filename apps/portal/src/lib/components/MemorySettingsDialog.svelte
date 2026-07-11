<script lang="ts">
  import { t } from "$lib/i18n";
  import { updateMemorySettings, type Me } from "$lib/api/portal";
  import {
    toMemorySettingsForm,
    toMemorySettingsRequest,
    type ActiveMemoryMode,
  } from "$lib/api/memory-settings";
  import Modal from "./Modal.svelte";

  let {
    me,
    onsaved,
    onclose,
  }: {
    me: Me;
    onsaved: (memory: Me["memory"]) => void;
    onclose: () => void;
  } = $props();

  let enabled = $state(false);
  let activeMode = $state<ActiveMemoryMode>("inject");
  let projectName = $state("");
  let threadSource = $state<"header" | "auto">("auto");
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    const form = toMemorySettingsForm(me.memory);
    enabled = form.enabled;
    activeMode = form.activeMode;
    projectName = form.projectName;
    threadSource = form.threadSource;
  });

  async function save(): Promise<void> {
    if (me.role === "root" || saving) return;
    saving = true;
    error = "";
    try {
      const result = await updateMemorySettings(
        toMemorySettingsRequest({
          enabled,
          activeMode,
          projectName,
          threadSource,
        }),
      );
      onsaved(result.memory);
    } catch (e) {
      error = e instanceof Error ? e.message : $t("Failed to save settings");
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t("Memory settings")} {onclose}>
  <form
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <div>
      <h2 class="section-header">{$t("Memory settings")}</h2>
      <p class="field-help mt-1">
        {$t(
          "These defaults control how this API key records and applies memory. Explicit x-memory-* request headers still override them.",
        )}
      </p>
    </div>

    <label
      class="flex items-center justify-between gap-4 rounded-lg border border-border bg-canvas px-3 py-3 text-sm"
    >
      <span>
        <span class="block field-label">{$t("Memory")}</span>
        <span class="field-help"
          >{$t("Record useful context across sessions")}</span
        >
      </span>
      <input
        type="checkbox"
        bind:checked={enabled}
        disabled={me.role === "root"}
        aria-label={$t("Memory")}
        class="h-4 w-4 accent-indigo-600"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Memory mode")}</span>
      <select
        class="select"
        bind:value={activeMode}
        disabled={!enabled || me.role === "root"}
      >
        <option value="observe">{$t("Observe (record only)")}</option>
        <option value="inject">{$t("Inject (record + hydrate)")}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Thread source")}</span>
      <select
        class="select"
        bind:value={threadSource}
        disabled={me.role === "root"}
      >
        <option value="auto">{$t("Auto (derive from client signals)")}</option>
        <option value="header">{$t("Header only (x-thread-id)")}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Project")}</span>
      <input
        class="input"
        maxlength="100"
        placeholder={$t("Private to this key")}
        bind:value={projectName}
        disabled={me.role === "root"}
      />
      <span class="field-help">
        {$t(
          "Changing the project switches memory pools; existing memory is not moved. Keys in the same account using the same project share that pool.",
        )}
      </span>
    </label>

    {#if error}<p class="alert-error" role="alert">{error}</p>{/if}

    <div class="flex justify-end gap-2 pt-1">
      <button type="button" class="btn-secondary" onclick={onclose}>
        {$t("Cancel")}
      </button>
      {#if me.role !== "root"}
        <button type="submit" class="btn-primary" disabled={saving}>
          {saving ? $t("Saving…") : $t("Save settings")}
        </button>
      {/if}
    </div>
  </form>
</Modal>
