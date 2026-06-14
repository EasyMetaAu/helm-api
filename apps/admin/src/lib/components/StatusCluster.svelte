<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getHealth, getVersion, type BuildInfo, type HealthState } from '$lib/api/gateway.js';
  import { formatStars, getStarCount, REPO } from '$lib/api/github.js';
  import { formatTimestamp } from '$lib/format.js';
  import { t } from '$lib/i18n';
  import LocaleSwitcher from './LocaleSwitcher.svelte';

  // Unified header status cluster: live gateway health, version, GitHub stars,
  // repo link, and the language switcher — one place, top-right. Every signal is
  // fail-open (CLAUDE.md Principle 3): a failed meta fetch degrades that one item,
  // it never breaks the admin shell.
  const POLL_MS = 30_000;
  const REPO_URL = `https://github.com/${REPO}`;

  let health = $state<HealthState>('offline'); // pessimistic until the first probe
  let probed = $state(false); // false → "Checking…" rather than a misleading state
  let version = $state<BuildInfo | null>(null);
  let stars = $state<number | null>(null);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function probeHealth(): Promise<void> {
    try {
      health = await getHealth();
    } catch {
      health = 'offline';
    } finally {
      probed = true;
    }
  }

  onMount(() => {
    void probeHealth();
    timer = setInterval(() => void probeHealth(), POLL_MS);

    void (async () => {
      try {
        version = await getVersion();
      } catch {
        version = null;
      }
    })();
    void (async () => {
      try {
        stars = await getStarCount();
      } catch {
        stars = null;
      }
    })();
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  const dotClass = $derived(
    health === 'online' ? 'bg-emerald-500' : health === 'degraded' ? 'bg-amber-500' : 'bg-red-500',
  );
  const healthLabel = $derived(
    !probed
      ? 'Checking…'
      : health === 'online'
        ? 'Online'
        : health === 'degraded'
          ? 'Degraded'
          : 'Offline',
  );
  const showVersion = $derived(!!version && version.version !== 'unknown');
</script>

<div class="flex items-center gap-2 text-xs sm:gap-3">
  <!-- Live gateway health -->
  <span
    class="flex items-center gap-1.5 text-slate-500"
    title={$t(healthLabel)}
    data-testid="gateway-health"
  >
    <span class="h-2 w-2 shrink-0 rounded-full {dotClass}"></span>
    <span class="sr-only sm:not-sr-only sm:inline">{$t(healthLabel)}</span>
  </span>

  {#if showVersion && version}
    <span
      class="hidden tabular-nums text-slate-400 sm:inline"
      title={`${version.gitSha} · ${formatTimestamp(version.builtAt)}`}
      data-testid="gateway-version">v{version.version}</span
    >
  {/if}

  <!-- Project source + star count -->
  <a
    href={REPO_URL}
    target="_blank"
    rel="noopener noreferrer"
    class="flex items-center gap-1.5 text-slate-400 transition-colors hover:text-slate-700"
    aria-label={$t('GitHub repository')}
    data-testid="github-link"
  >
    <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
    {#if stars !== null}
      <span class="hidden tabular-nums sm:inline" data-testid="github-stars"
        >★ {formatStars(stars)}</span
      >
    {/if}
  </a>

  <!-- Divider -->
  <span class="hidden h-4 w-px bg-slate-200 sm:block" aria-hidden="true"></span>

  <!-- Language -->
  <LocaleSwitcher compact />
</div>
