<script lang="ts">
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens } from "$lib/format";
  import { getMe, type Me, updateMemorySettings } from "$lib/api/portal";

  let me = $state<Me | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let saveError = $state("");
  let saving = $state(false);
  let saved = $state(false);
  let memoryEnabled = $state(false);
  let activeMode = $state<"observe" | "inject">("inject");
  let projectName = $state("");

  $effect(() => {
    void (async () => {
      try {
        me = await getMe();
        memoryEnabled = me.memory.mode !== "off";
        activeMode = me.memory.mode === "observe" ? "observe" : "inject";
        projectName = me.memory.project_name ?? "";
      } catch (e) {
        loadError = e instanceof Error ? e.message : "load failed";
      } finally {
        loading = false;
      }
    })();
  });

  const rpm = $derived(me?.rate_limit.rpm);
  const spend = $derived(me?.budget.spend_usd ?? null);
  const tokens = $derived(me?.budget.tokens ?? null);

  async function saveMemorySettings(): Promise<void> {
    if (!me || me.role === "root" || saving) return;
    saving = true;
    saved = false;
    saveError = "";
    try {
      const result = await updateMemorySettings({
        memory_mode: memoryEnabled ? activeMode : "off",
        memory_project_id: projectName.trim() || null,
      });
      me = { ...me, memory: result.memory };
      projectName = result.memory.project_name ?? "";
      saved = true;
    } catch (e) {
      saveError =
        e instanceof Error ? e.message : $t("Failed to save settings");
    } finally {
      saving = false;
    }
  }
</script>

<h1 class="page-title mb-1">{$t("Account")}</h1>
<p class="section-desc mb-4">
  {$t("Your key, its limits, and Memory defaults.")}
</p>

{#if loading}
  <p class="section-desc">{$t("Loading…")}</p>
{:else if loadError}
  <p class="alert-error">{loadError}</p>
{:else if me}
  <div class="card space-y-3">
    <div class="flex justify-between">
      <span class="section-desc">{$t("Key")}</span>
      <span class="font-mono text-sm">{me.key_prefix}…</span>
    </div>
    <div class="flex justify-between">
      <span class="section-desc">{$t("Role")}</span>
      <span>{me.role}</span>
    </div>
    <div class="flex justify-between">
      <span class="section-desc">{$t("Available lanes")}</span>
      <span>{me.allowed_lanes?.join(", ") ?? $t("all")}</span>
    </div>
    <div class="flex justify-between">
      <span class="section-desc">{$t("Rate limit")}</span>
      <span
        >{rpm === null || rpm === undefined
          ? $t("unlimited")
          : `${rpm} rpm`}</span
      >
    </div>
    <div class="flex justify-between">
      <span class="section-desc">{$t("Spend limit")}</span>
      <span>{spend === null ? $t("unlimited") : formatUsd(spend)}</span>
    </div>
    <div class="flex justify-between">
      <span class="section-desc">{$t("Token budget")}</span>
      <span>{tokens === null ? $t("unlimited") : formatTokens(tokens)}</span>
    </div>
  </div>

  <form
    class="card mt-4 space-y-4"
    onsubmit={(event) => {
      event.preventDefault();
      void saveMemorySettings();
    }}
  >
    <div>
      <h2 class="text-base font-semibold">{$t("Memory defaults")}</h2>
      <p class="field-help mt-1">
        {$t(
          "Server-side memory defaults for clients that cannot send dynamic headers (Claude Code, Codex). Explicit x-memory-* request headers always override. Auto thread source derives the conversation from signals the client already sends (prompt_cache_key, metadata.user_id, x-session-key).",
        )}
      </p>
    </div>

    <label class="flex items-center justify-between gap-4 text-sm">
      <span class="field-label">{$t("Memory")}</span>
      <input
        type="checkbox"
        bind:checked={memoryEnabled}
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
        disabled={!memoryEnabled || me.role === "root"}
      >
        <option value="observe">{$t("Observe (record only)")}</option>
        <option value="inject">{$t("Inject (record + hydrate)")}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t("Default project id")}</span>
      <input
        class="input"
        maxlength="100"
        placeholder={$t("None")}
        bind:value={projectName}
        disabled={me.role === "root"}
      />
      <span class="field-help">
        {$t(
          "Changing the project switches memory pools; existing memory is not moved. Keys in the same account using the same project share that pool.",
        )}
      </span>
    </label>

    {#if me.role === "root"}
      <p class="field-help">{me.role}: {$t("Memory mode")} {$t("Off")}</p>
    {:else}
      {#if saveError}<p class="alert-error">{saveError}</p>{/if}
      <div class="flex items-center gap-3">
        <button class="btn-primary" type="submit" disabled={saving}>
          {saving ? $t("Saving…") : $t("Save settings")}
        </button>
        {#if saved}<span class="text-sm text-success">{$t("Saved")}</span>{/if}
      </div>
    {/if}
  </form>
{/if}
