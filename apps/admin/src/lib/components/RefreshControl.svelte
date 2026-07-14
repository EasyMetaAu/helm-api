<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from '$lib/i18n';

  const SHARED_STORAGE_KEY = 'helm_admin_refresh_interval';
  const LEGACY_STORAGE_KEYS = [
    'helm_admin_home_refresh_interval',
    'helm_admin_requests_refresh_interval',
    'helm_admin_providers_refresh_interval',
    'helm_admin_memory_refresh_interval',
  ];
  const REFRESH_INTERVAL_EVENT = 'helm-admin-refresh-interval-change';

  // Split refresh control (Grafana-style): the left button refreshes the page
  // now, the caret opens a menu that picks an auto-refresh cadence. The parent
  // owns what "refresh" means (the requests list re-runs its loader via
  // invalidateAll); this component only schedules the calls and reports state. The
  // cadence is a single admin-wide preference so all pages stay in lockstep.
  let {
    onRefresh,
    onAutoRefresh,
    storageKey = SHARED_STORAGE_KEY,
  }: {
    onRefresh: () => void | Promise<void>;
    // Providers uses this to keep timer ticks cache-only while the explicit button
    // enqueues one upstream refresh. Other pages omit it and retain prior behavior.
    onAutoRefresh?: () => void | Promise<void>;
    // Mostly for tests/future embedded use. Admin routes should omit this so they
    // all share SHARED_STORAGE_KEY.
    storageKey?: string;
  } = $props();

  // Cadence choices in seconds (0 handled separately as "Off"). Labels are
  // language-neutral literals (like RangeFilter's 1h/6h), so they need no i18n.
  const INTERVALS: { seconds: number; label: string }[] = [
    { seconds: 5, label: '5s' },
    { seconds: 10, label: '10s' },
    { seconds: 30, label: '30s' },
    { seconds: 60, label: '1m' },
    { seconds: 300, label: '5m' },
    { seconds: 900, label: '15m' },
    { seconds: 1800, label: '30m' },
    { seconds: 3600, label: '1h' },
    { seconds: 7200, label: '2h' },
    { seconds: 86400, label: '1d' },
  ];

  let open = $state(false);
  let refreshing = $state(false);
  // Active cadence in seconds; 0 = auto-refresh off.
  let intervalSeconds = $state(0);
  let root = $state<HTMLElement>();

  // setInterval handle for the active cadence; null when off.
  let timer: ReturnType<typeof setInterval> | null = null;

  const activeLabel = $derived(INTERVALS.find((o) => o.seconds === intervalSeconds)?.label ?? null);

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
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStoredInterval(key: string, seconds: number): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, String(seconds));
    } catch {
      // ignore — auto-refresh keeps working without persistence
    }
  }

  // Run a refresh, guarding against overlap so a slow load never stacks ticks.
  async function runRefresh(callback: () => void | Promise<void> = onRefresh): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await callback();
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

  // (Re)start the timer for the active cadence: 0 stops auto-refresh, anything
  // else schedules ticks. First tick fires one interval later (no surprise burst).
  function applyTimer(seconds: number): void {
    stopTimer();
    if (seconds > 0) {
      timer = setInterval(() => {
        void runRefresh(onAutoRefresh ?? onRefresh);
      }, seconds * 1000);
    }
  }

  function applyInterval(seconds: number): void {
    intervalSeconds = seconds;
    applyTimer(seconds);
  }

  // Persist the cadence so it survives navigation. Best-effort: storage may be
  // unavailable (private mode) — the setting still applies for the session.
  function persist(seconds: number): void {
    writeStoredInterval(storageKey, seconds);
  }

  function broadcast(seconds: number): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent(REFRESH_INTERVAL_EVENT, {
        detail: { storageKey, seconds },
      }),
    );
  }

  // Apply a cadence chosen from the menu: update state, restart the timer, persist.
  function selectInterval(seconds: number): void {
    applyInterval(seconds);
    open = false;
    persist(seconds);
    broadcast(seconds);
  }

  // Restore a saved cadence on mount and resume ticking. A missing/corrupt value
  // (legacy, hand-edited, unknown option) is ignored — we stay Off rather than guess.
  // `storageKey` is a fixed prop, so reading its initial value once (untrack) is the
  // intent — this is a one-shot init, not a reactive effect. The read is best-effort:
  // localStorage access can throw (private mode, or jsdom's opaque-origin stub), so a
  // failure just leaves auto-refresh Off rather than breaking the whole page render.
  untrack(() => {
    let saved = readStoredInterval(storageKey);
    if (saved === null && storageKey === SHARED_STORAGE_KEY) {
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        const legacyValue = readStoredInterval(legacyKey);
        if (parseInterval(legacyValue) !== null) {
          saved = legacyValue;
          writeStoredInterval(storageKey, Number(legacyValue));
          break;
        }
      }
    }
    if (saved === null) return;
    const seconds = parseInterval(saved);
    if (seconds !== null) applyInterval(seconds);
  });

  function applyExternalInterval(seconds: number): void {
    if (seconds === intervalSeconds) return;
    applyInterval(seconds);
  }

  function onSharedInterval(event: Event): void {
    const detail = (event as CustomEvent<{ storageKey?: string; seconds?: number }>).detail;
    if (detail?.storageKey !== storageKey) return;
    const seconds = parseInterval(String(detail.seconds));
    if (seconds !== null) applyExternalInterval(seconds);
  }

  function onStorageInterval(event: StorageEvent): void {
    if (event.key !== storageKey) return;
    const seconds = parseInterval(event.newValue);
    if (seconds !== null) applyExternalInterval(seconds);
  }

  // Close the menu on any pointer-down outside the control (click-outside).
  function onWindowPointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target as Node | null;
    if (root && target && !root.contains(target)) open = false;
  }

  onMount(() => {
    window.addEventListener(REFRESH_INTERVAL_EVENT, onSharedInterval);
    window.addEventListener('storage', onStorageInterval);
    return () => {
      window.removeEventListener(REFRESH_INTERVAL_EVENT, onSharedInterval);
      window.removeEventListener('storage', onStorageInterval);
    };
  });

  onDestroy(stopTimer);
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

<div bind:this={root} data-testid="refresh-control" class="relative inline-flex">
  <!-- Refresh now. The arrow-path icon spins while a refresh is in flight. -->
  <button
    type="button"
    data-testid="refresh-now"
    class="btn-secondary rounded-r-none"
    aria-label={$t('Refresh')}
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
    {$t('Refresh')}
    {#if activeLabel}
      <span data-testid="refresh-active" class="font-medium text-indigo-600">· {activeLabel}</span>
    {/if}
  </button>

  <!-- Caret: opens the cadence menu. Shares its left border with the button. -->
  <button
    type="button"
    data-testid="refresh-toggle"
    class="btn-secondary -ml-px min-w-11 rounded-l-none px-1.5 md:min-w-0"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$t('Auto refresh')}
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
      <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
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
        {$t('Off')}
        {#if intervalSeconds === 0}<span aria-hidden="true">✓</span>{/if}
      </button>

      <div class="my-1 border-t border-slate-100"></div>
      <p class="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
        {$t('Auto refresh')}
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
          {#if intervalSeconds === opt.seconds}<span aria-hidden="true">✓</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
