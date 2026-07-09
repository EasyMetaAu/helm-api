<script lang="ts">
  import { t } from "$lib/i18n";
  import { formatUsd, formatTokens } from "$lib/format";
  import { getMe, type Me } from "$lib/api/portal";

  let me = $state<Me | null>(null);
  let loading = $state(true);
  let error = $state("");

  $effect(() => {
    void (async () => {
      try {
        me = await getMe();
      } catch (e) {
        error = e instanceof Error ? e.message : "load failed";
      } finally {
        loading = false;
      }
    })();
  });

  const rpm = $derived(me?.rate_limit.rpm);
  const spend = $derived(me?.budget.spend_usd ?? null);
  const tokens = $derived(me?.budget.tokens ?? null);
</script>

<h1 class="page-title mb-1">{$t("Account")}</h1>
<p class="section-desc mb-4">
  {$t(
    "Your key and its limits. These are read-only — contact your administrator to change them.",
  )}
</p>

{#if loading}
  <p class="section-desc">{$t("Loading…")}</p>
{:else if error}
  <p class="alert-error">{error}</p>
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
    <div class="flex justify-between">
      <span class="section-desc">{$t("Memory mode")}</span>
      <span>{me.memory.mode}</span>
    </div>
  </div>
{/if}
