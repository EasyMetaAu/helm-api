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

  // Top-nav segments (docs/12 §3): Overview / Connect / Requests / Memory / Account.
  const nav = [
    { seg: "", label: "Overview" },
    { seg: "connect", label: "Connect" },
    { seg: "requests", label: "Requests" },
    { seg: "memory", label: "Memory" },
    { seg: "account", label: "Account" },
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
  <div class="min-h-screen bg-canvas text-ink">
    <!-- The mobile nav drawer lives inside the header; a click below it closes it. -->
    <header
      class="border-b border-border bg-surface"
      use:clickOutside={() => (navOpen = false)}
    >
      <div class="flex h-14 items-center gap-4 px-4 sm:px-6 lg:px-8">
        <a
          href={hrefFor("")}
          class="flex items-center gap-2 font-semibold text-ink"
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
              class:text-ink-body={!isActive(item.seg)}
              class:hover:bg-canvas={!isActive(item.seg)}
              class:hover:text-ink={!isActive(item.seg)}
            >
              {$t(item.label)}
            </a>
          {/each}
        </nav>

        <div class="ml-auto flex items-center gap-2">
          <!-- Mobile hamburger -->
          <button
            class="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-control border border-border text-ink-body transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 md:hidden"
            aria-label={$t("Menu")}
            aria-expanded={navOpen}
            onclick={() => (navOpen = !navOpen)}
          >
            <svg
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.8"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
          </button>

          <div class="hidden sm:block">
            <LocaleSwitcher compact id="locale-switcher-header" />
          </div>

          <!-- Key pill + account menu. clickOutside closes the dropdown when the
               user clicks the blank area (only wired while it's open). -->
          <div class="relative" use:clickOutside={() => (menuOpen = false)}>
            <button
              class="inline-flex min-h-11 items-center rounded-full border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-ink-body hover:text-ink md:min-h-0"
              onclick={() => (menuOpen = !menuOpen)}
            >
              {keyFingerprint($apiKey)}
              <svg
                class="ml-1 h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m19.5 8.25-7.5 7.5-7.5-7.5"
                />
              </svg>
            </button>
            {#if menuOpen}
              <div
                class="absolute right-0 z-20 mt-2 w-48 rounded-lg border border-border bg-surface p-2 shadow-lg"
              >
                <div class="px-2 py-1.5 sm:hidden">
                  <LocaleSwitcher id="locale-switcher-menu" />
                </div>
                <button
                  class="flex min-h-11 w-full items-center rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-canvas md:min-h-0"
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
              class="mb-1 flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium"
              class:bg-indigo-600={isActive(item.seg)}
              class:text-white={isActive(item.seg)}
              class:text-ink-body={!isActive(item.seg)}
              onclick={() => (navOpen = false)}
            >
              {$t(item.label)}
            </a>
          {/each}
          <div class="mt-2 px-1 sm:hidden">
            <LocaleSwitcher id="locale-switcher-drawer" />
          </div>
        </nav>
      {/if}
    </header>

    <main class="px-4 py-6 sm:px-6 lg:px-8">
      {@render children()}
    </main>
  </div>
{/if}
