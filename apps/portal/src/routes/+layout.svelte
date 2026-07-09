<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { initI18n, t } from "$lib/i18n";
  import LocaleSwitcher from "$lib/components/LocaleSwitcher.svelte";
  import Logo from "$lib/components/Logo.svelte";
  import { clickOutside } from "$lib/clickOutside";
  import { apiKey, keyFingerprint, clearKey } from "$lib/auth";

  let { children } = $props();

  onMount(() => {
    void initI18n();
  });

  // Auth guard: no key + not on /login → bounce to /login. Runs client-side only
  // (SPA); the key lives in sessionStorage.
  const onLoginRoute = $derived($page.url.pathname.endsWith("/login"));
  $effect(() => {
    if (!$apiKey && !onLoginRoute) void goto(`${base}/login`);
  });

  // Top-nav segments (docs/12 §3): Overview / Connect / Requests / Memory.
  const nav = [
    { seg: "", label: "Overview" },
    { seg: "connect", label: "Connect" },
    { seg: "requests", label: "Requests" },
    { seg: "memory", label: "Memory" },
  ];

  const hrefFor = (seg: string) => (seg ? `${base}/${seg}` : `${base}/`);
  function isActive(seg: string): boolean {
    const path = $page.url.pathname.replace(/\/$/, "");
    const target = hrefFor(seg).replace(/\/$/, "");
    if (seg === "") return path === target || path === base;
    return path === target || path.startsWith(`${target}/`);
  }

  let menuOpen = $state(false);
  let navOpen = $state(false);
</script>

{#if onLoginRoute || !$apiKey}
  {@render children()}
{:else}
  <div class="min-h-screen bg-canvas text-ink-1">
    <header class="border-b border-border bg-surface">
      <div class="flex h-14 items-center gap-4 px-4 sm:px-6 lg:px-8">
        <a
          href={hrefFor("")}
          class="flex items-center gap-2 font-semibold text-ink-1"
        >
          <Logo size="sm" />
          <span>Helm</span>
        </a>

        <!-- Desktop nav — active item gets a solid indigo pill so the current page
             is unmistakable; others are muted grey that darken on hover. -->
        <nav class="ml-4 hidden items-center gap-1 md:flex">
          {#each nav as item (item.seg)}
            <a
              href={hrefFor(item.seg)}
              aria-current={isActive(item.seg) ? "page" : undefined}
              class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
              class:bg-indigo-600={isActive(item.seg)}
              class:text-white={isActive(item.seg)}
              class:shadow-sm={isActive(item.seg)}
              class:text-ink-2={!isActive(item.seg)}
              class:hover:bg-canvas={!isActive(item.seg)}
              class:hover:text-ink-1={!isActive(item.seg)}
            >
              {$t(item.label)}
            </a>
          {/each}
        </nav>

        <div class="ml-auto flex items-center gap-2">
          <!-- Mobile hamburger -->
          <button
            class="btn-icon md:hidden"
            aria-label={$t("Menu")}
            onclick={() => (navOpen = !navOpen)}
          >
            ☰
          </button>

          <!-- Key pill + account menu. clickOutside closes the dropdown when the
               user clicks the blank area (only wired while it's open). -->
          <div class="relative" use:clickOutside={() => (menuOpen = false)}>
            <button
              class="rounded-full border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-ink-2 hover:text-ink-1"
              onclick={() => (menuOpen = !menuOpen)}
            >
              {keyFingerprint($apiKey)} ▾
            </button>
            {#if menuOpen}
              <div
                class="absolute right-0 z-20 mt-2 w-48 rounded-lg border border-border bg-surface p-2 shadow-lg"
              >
                <div class="px-2 py-1.5">
                  <LocaleSwitcher />
                </div>
                <a
                  href={hrefFor("account")}
                  class="block rounded px-2 py-1.5 text-sm text-ink-2 hover:bg-canvas"
                  onclick={() => (menuOpen = false)}
                >
                  {$t("Account")}
                </a>
                <button
                  class="block w-full rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-canvas"
                  onclick={clearKey}
                >
                  {$t("Sign out")}
                </button>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Mobile nav drawer -->
      {#if navOpen}
        <nav class="border-t border-border px-4 py-2 md:hidden">
          {#each nav as item (item.seg)}
            <a
              href={hrefFor(item.seg)}
              aria-current={isActive(item.seg) ? "page" : undefined}
              class="mb-1 block rounded-md px-3 py-2 text-sm font-medium"
              class:bg-indigo-600={isActive(item.seg)}
              class:text-white={isActive(item.seg)}
              class:text-ink-2={!isActive(item.seg)}
              onclick={() => (navOpen = false)}
            >
              {$t(item.label)}
            </a>
          {/each}
        </nav>
      {/if}
    </header>

    <main class="px-4 py-6 sm:px-6 lg:px-8">
      {@render children()}
    </main>
  </div>
{/if}
