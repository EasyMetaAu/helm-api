<script lang="ts">
  import '../app.css';
  import { base } from '$app/paths';
  import { page } from '$app/stores';

  let { children } = $props();

  // Mobile slide-over state. Desktop (md+) keeps the sidebar pinned.
  let navOpen = $state(false);

  type Item = { seg: string; label: string; icon: string };
  // Single-path outline icons (Heroicons) — no icon dependency, stays lean.
  const nav: Item[] = [
    {
      seg: '',
      label: 'Dashboard',
      icon: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 .75-.75V15a.75.75 0 0 1 .75-.75h2.25a.75.75 0 0 1 .75.75v5.25c0 .415.336.75.75.75h4.5a.75.75 0 0 0 .75-.75V9.75',
    },
    {
      seg: 'requests',
      label: 'Requests',
      icon: 'M3.75 12h16.5m-16.5 5.25h16.5M3.75 6.75h16.5',
    },
    {
      seg: 'lanes',
      label: 'Lanes',
      icon: 'M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5',
    },
    {
      seg: 'policies',
      label: 'Policies',
      icon: 'M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z',
    },
    {
      seg: 'classifier',
      label: 'Classifier',
      icon: 'M3.792 2.938A49.069 49.069 0 0 1 12 2.25c2.797 0 5.54.236 8.209.688a1.857 1.857 0 0 1 1.541 1.836v1.044a3 3 0 0 1-.879 2.121l-6.182 6.182a1.5 1.5 0 0 0-.439 1.061v2.927a3 3 0 0 1-1.658 2.684l-1.757.878A.75.75 0 0 1 9.75 21v-5.818a1.5 1.5 0 0 0-.44-1.06L3.13 7.938a3 3 0 0 1-.879-2.121V4.774c0-.897.64-1.683 1.542-1.836Z',
    },
    {
      seg: 'keys',
      label: 'API Keys',
      icon: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
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

<div class="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
  <!-- Mobile backdrop -->
  {#if navOpen}
    <button
      class="fixed inset-0 z-20 bg-slate-900/30 md:hidden"
      aria-label="Close navigation"
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
        <div class="text-[11px] text-slate-400">LLM Gateway</div>
      </div>
    </div>

    <nav class="flex-1 space-y-1 px-3 py-2">
      {#each nav as item (item.seg)}
        <a
          href={hrefFor(item.seg)}
          aria-current={isActive(item.seg) ? 'page' : undefined}
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
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="border-t border-slate-100 px-5 py-4">
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
        Connected
      </div>
    </div>
  </aside>

  <!-- Main column -->
  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Top bar: hamburger on mobile + current section label -->
    <header
      class="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur md:px-6"
    >
      <button
        class="-ml-1 rounded-lg p-2 text-slate-500 hover:bg-slate-100 md:hidden"
        aria-label="Open navigation"
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
      <h1 class="text-base font-semibold tracking-tight text-slate-900">{activeLabel}</h1>
    </header>

    <main class="flex-1 overflow-y-auto">
      {@render children()}
    </main>
  </div>
</div>
