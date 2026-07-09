<script lang="ts">
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { t } from "$lib/i18n";
  import { setKey, getKey } from "$lib/auth";
  import LocaleSwitcher from "$lib/components/LocaleSwitcher.svelte";
  import Logo from "$lib/components/Logo.svelte";

  let value = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(e: Event) {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    busy = true;
    error = "";
    try {
      // Verify the key by hitting the bearer-scoped /me before we store it.
      const res = await fetch(`${base}/api/me`, {
        headers: { accept: "application/json", Authorization: `Bearer ${key}` },
      });
      if (res.status === 401) {
        error = $t("That key is not valid.");
        return;
      }
      if (!res.ok) {
        error = $t("Could not verify the key. Try again.");
        return;
      }
      setKey(key);
      await goto(`${base}/`);
    } catch {
      error = $t("Could not reach the server.");
    } finally {
      busy = false;
    }
  }

  // Already signed in? Skip straight to the overview.
  $effect(() => {
    if (getKey()) void goto(`${base}/`);
  });
</script>

<div class="flex min-h-screen items-center justify-center bg-canvas px-4">
  <div class="w-full max-w-sm">
    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-2 text-lg font-semibold text-ink-1">
        <Logo /> Helm
      </div>
      <LocaleSwitcher compact />
    </div>

    <div class="card">
      <h1 class="page-title mb-1">{$t("Sign in")}</h1>
      <p class="section-desc mb-4">
        {$t("Paste your API key to view your usage and connect your clients.")}
      </p>

      <form onsubmit={submit} class="space-y-3">
        <input
          class="input font-mono"
          type="password"
          autocomplete="off"
          placeholder="helm_..."
          bind:value
          disabled={busy}
        />
        {#if error}
          <p class="alert-error">{error}</p>
        {/if}
        <button
          class="btn-primary w-full"
          type="submit"
          disabled={busy || !value.trim()}
        >
          {busy ? $t("Verifying…") : $t("Continue")}
        </button>
      </form>

      <p class="field-help mt-4">
        {$t(
          "Your key stays in this browser tab only and is sent over HTTPS with each request. Closing the tab signs you out.",
        )}
      </p>
    </div>
  </div>
</div>
