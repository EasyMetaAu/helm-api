<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import NavProgress from '$lib/components/NavProgress.svelte';
  import StatusCluster from '$lib/components/StatusCluster.svelte';
  import { initI18n, t } from '$lib/i18n';

  let { children } = $props();

  // Resolve the saved/browser language once on the client (SPA — no SSR).
  onMount(() => {
    void initI18n();
  });

  // Mobile slide-over state. Desktop (md+) keeps the sidebar pinned.
  let navOpen = $state(false);

  type Item = { seg: string; label: string; desc: string; icon: string };
  // Single-path outline icons (Heroicons) — no icon dependency, stays lean.
  // `desc` is a plain-words one-liner shown as a subtitle + title tooltip so a
  // non-expert operator can tell the screens apart at a glance.
  const nav: Item[] = [
    {
      seg: '',
      label: 'Dashboard',
      desc: 'Traffic and health at a glance',
      icon: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 .75-.75V15a.75.75 0 0 1 .75-.75h2.25a.75.75 0 0 1 .75.75v5.25c0 .415.336.75.75.75h4.5a.75.75 0 0 0 .75-.75V9.75',
    },
    {
      seg: 'requests',
      label: 'Requests',
      desc: 'Every request and the lane it took',
      icon: 'M3.75 12h16.5m-16.5 5.25h16.5M3.75 6.75h16.5',
    },
    {
      seg: 'lanes',
      label: 'Lanes',
      desc: 'Quality tiers and fallback models',
      icon: 'M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5',
    },
    {
      seg: 'policies',
      label: 'Policies',
      desc: 'Rules that override or cap the lane',
      icon: 'M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z',
    },
    {
      seg: 'classifier',
      label: 'Classifier',
      desc: 'How a request is matched to a lane',
      icon: 'M3.792 2.938A49.069 49.069 0 0 1 12 2.25c2.797 0 5.54.236 8.209.688a1.857 1.857 0 0 1 1.541 1.836v1.044a3 3 0 0 1-.879 2.121l-6.182 6.182a1.5 1.5 0 0 0-.439 1.061v2.927a3 3 0 0 1-1.658 2.684l-1.757.878A.75.75 0 0 1 9.75 21v-5.818a1.5 1.5 0 0 0-.44-1.06L3.13 7.938a3 3 0 0 1-.879-2.121V4.774c0-.897.64-1.683 1.542-1.836Z',
    },
    {
      seg: 'keys',
      label: 'API Keys',
      desc: 'Client keys and their lane limits',
      icon: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
    },
    {
      seg: 'providers',
      label: 'Providers',
      desc: 'Connect Codex and Claude subscriptions',
      icon: 'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z',
    },
    {
      seg: 'settings',
      label: 'Settings',
      desc: 'System Settings',
      icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    },
  ];

  function hrefFor(seg: string): string {
    return seg === '' ? `${base}/` : `${base}/${seg}`;
  }

  const current = $derived($page.url.pathname.replace(/\/+$/, ''));
  function isActive(seg: string): boolean {
    const root = base.replace(/\/+$/, '');
    if (seg === '') return current === root || current === '';
    const target = `${root}/${seg}`;
    return current === target || current.startsWith(`${target}/`);
  }

  const activeLabel = $derived(nav.find((n) => isActive(n.seg))?.label ?? 'Dashboard');
</script>

<!-- Top navigation progress bar — fixed overlay, sits above the whole shell. -->
<NavProgress />

<div class="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
  <!-- Mobile backdrop -->
  {#if navOpen}
    <button
      class="fixed inset-0 z-20 bg-slate-900/30 md:hidden"
      aria-label={$t('Close navigation')}
      onclick={() => (navOpen = false)}
    ></button>
  {/if}

  <!-- Sidebar -->
  <aside
    class="fixed inset-y-0 left-0 z-30 flex w-64 transform flex-col border-r border-slate-200 bg-white transition-transform duration-200 ease-out md:static md:translate-x-0 {navOpen
      ? 'translate-x-0'
      : '-translate-x-full'}"
  >
    <div class="flex h-16 items-center gap-2.5 px-5">
      <span
        class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white"
        >H</span
      >
      <div class="leading-tight">
        <div class="text-sm font-semibold tracking-tight">Helm</div>
        <div class="text-xs text-slate-400">{$t('LLM Gateway')}</div>
      </div>
    </div>

    <nav class="flex-1 space-y-1 px-3 py-2">
      {#each nav as item (item.seg)}
        <a
          href={hrefFor(item.seg)}
          aria-current={isActive(item.seg) ? 'page' : undefined}
          title={$t(item.desc)}
          onclick={() => (navOpen = false)}
          class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors {isActive(
            item.seg,
          )
            ? 'bg-indigo-50 text-indigo-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}"
        >
          <svg
            class="h-5 w-5 shrink-0 {isActive(item.seg)
              ? 'text-indigo-600'
              : 'text-slate-400 group-hover:text-slate-500'}"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.6"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
          </svg>
          <span class="min-w-0 leading-tight">
            <span class="block truncate">{$t(item.label)}</span>
            <span class="block truncate text-xs font-normal text-slate-400">{$t(item.desc)}</span>
          </span>
        </a>
      {/each}
    </nav>
  </aside>

  <!-- Main column -->
  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Top bar: hamburger on mobile + current section label -->
    <header
      class="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur md:px-6"
    >
      <button
        class="-ml-1 flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"
        aria-label={$t('Open navigation')}
        onclick={() => (navOpen = true)}
      >
        <svg
          class="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.8"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
          />
        </svg>
      </button>
      <h1 class="text-base font-semibold tracking-tight text-slate-900">{$t(activeLabel)}</h1>
      <div class="ml-auto flex items-center">
        <StatusCluster />
      </div>
    </header>

    <main class="flex-1 overflow-y-auto">
      {@render children()}
    </main>
  </div>
</div>
