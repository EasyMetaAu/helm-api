<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { t } from "$lib/i18n";

  const SHARED_STORAGE_KEY = "helm_portal_refresh_interval";
  const REFRESH_INTERVAL_EVENT = "helm-portal-refresh-interval-change";

  let {
    onRefresh,
    storageKey = SHARED_STORAGE_KEY,
  }: {
    onRefresh: () => void | Promise<void>;
    storageKey?: string;
  } = $props();

  const INTERVALS: { seconds: number; label: string }[] = [
    { seconds: 5, label: "5s" },
    { seconds: 10, label: "10s" },
    { seconds: 30, label: "30s" },
    { seconds: 60, label: "1m" },
    { seconds: 300, label: "5m" },
    { seconds: 900, label: "15m" },
    { seconds: 1800, label: "30m" },
    { seconds: 3600, label: "1h" },
  ];

  let open = $state(false);
  let refreshing = $state(false);
  let intervalSeconds = $state(0);
  let root = $state<HTMLElement>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const activeLabel = $derived(
    INTERVALS.find((o) => o.seconds === intervalSeconds)?.label ?? null,
  );

  function parseInterval(value: string | null): number | null {
    if (value === null) return null;
    const seconds = Number(value);
    if (
      Number.isFinite(seconds) &&
      (seconds === 0 || INTERVALS.some((o) => o.seconds === seconds))
    ) {
      return seconds;
    }
    return null;
  }

  function readStoredInterval(key: string): string | null {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStoredInterval(key: string, seconds: number): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, String(seconds));
    } catch {
      // Persistence is optional; the in-page timer still works.
    }
  }

  async function runRefresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await onRefresh();
    } finally {
      refreshing = false;
    }
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function applyTimer(seconds: number): void {
    stopTimer();
    if (seconds > 0) {
      timer = setInterval(() => {
        void runRefresh();
      }, seconds * 1000);
    }
  }

  function applyInterval(seconds: number): void {
    intervalSeconds = seconds;
    applyTimer(seconds);
  }

  function broadcast(seconds: number): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(REFRESH_INTERVAL_EVENT, {
        detail: { storageKey, seconds },
      }),
    );
  }

  function selectInterval(seconds: number): void {
    applyInterval(seconds);
    open = false;
    writeStoredInterval(storageKey, seconds);
    broadcast(seconds);
  }

  untrack(() => {
    const saved = readStoredInterval(storageKey);
    const seconds = parseInterval(saved);
    if (seconds !== null) applyInterval(seconds);
  });

  function onSharedInterval(event: Event): void {
    const detail = (
      event as CustomEvent<{ storageKey?: string; seconds?: number }>
    ).detail;
    if (detail?.storageKey !== storageKey) return;
    const seconds = parseInterval(String(detail.seconds));
    if (seconds !== null && seconds !== intervalSeconds) applyInterval(seconds);
  }

  function onStorageInterval(event: StorageEvent): void {
    if (event.key !== storageKey) return;
    const seconds = parseInterval(event.newValue);
    if (seconds !== null && seconds !== intervalSeconds) applyInterval(seconds);
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target as Node | null;
    if (root && target && !root.contains(target)) open = false;
  }

  onMount(() => {
    window.addEventListener(REFRESH_INTERVAL_EVENT, onSharedInterval);
    window.addEventListener("storage", onStorageInterval);
    return () => {
      window.removeEventListener(REFRESH_INTERVAL_EVENT, onSharedInterval);
      window.removeEventListener("storage", onStorageInterval);
    };
  });

  onDestroy(stopTimer);
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onkeydown={(e) => e.key === "Escape" && (open = false)}
/>

<div
  bind:this={root}
  data-testid="refresh-control"
  class="relative inline-flex"
>
  <button
    type="button"
    data-testid="refresh-now"
    class="btn-secondary rounded-r-none"
    aria-label={$t("Refresh")}
    onclick={() => void runRefresh()}
  >
    <svg
      class="h-4 w-4 {refreshing ? 'animate-spin' : ''}"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.8"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.023 9.348h4.992V4.356M3.86 14.652H8.85m11.297-5.304a8.25 8.25 0 0 0-15.357-2.244M3.86 14.652a8.25 8.25 0 0 0 15.357 2.244"
      />
    </svg>
    {$t("Refresh")}
    {#if activeLabel}
      <span data-testid="refresh-active" class="font-medium text-indigo-600"
        >· {activeLabel}</span
      >
    {/if}
  </button>

  <button
    type="button"
    data-testid="refresh-toggle"
    class="btn-secondary -ml-px min-w-11 rounded-l-none px-1.5 md:min-w-0"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$t("Auto refresh")}
    onclick={() => (open = !open)}
  >
    <svg
      class="h-4 w-4 transition-transform {open ? 'rotate-180' : ''}"
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

  {#if open}
    <div
      data-testid="refresh-menu"
      role="menu"
      class="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg"
    >
      <button
        type="button"
        data-testid="refresh-interval-off"
        role="menuitemradio"
        aria-checked={intervalSeconds === 0}
        class="flex w-full items-center justify-between px-3 py-1.5 text-sm transition-colors hover:bg-slate-50 {intervalSeconds ===
        0
          ? 'font-medium text-indigo-600'
          : 'text-slate-700'}"
        onclick={() => selectInterval(0)}
      >
        {$t("Off")}
        {#if intervalSeconds === 0}<span aria-hidden="true">✓</span>{/if}
      </button>
      <div class="my-1 border-t border-slate-100"></div>
      <p
        class="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400"
      >
        {$t("Auto refresh")}
      </p>
      {#each INTERVALS as opt (opt.seconds)}
        <button
          type="button"
          data-testid="refresh-interval-{opt.seconds}"
          role="menuitemradio"
          aria-checked={intervalSeconds === opt.seconds}
          class="flex w-full items-center justify-between px-3 py-1.5 text-sm transition-colors hover:bg-slate-50 {intervalSeconds ===
          opt.seconds
            ? 'font-medium text-indigo-600'
            : 'text-slate-700'}"
          onclick={() => selectInterval(opt.seconds)}
        >
          {opt.label}
          {#if intervalSeconds === opt.seconds}<span aria-hidden="true">✓</span
            >{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
