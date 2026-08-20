<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import type { OAuthQuotaWindow, OAuthUsagePeriod } from '$lib/api/oauth.js';
  import RefreshControl from '$lib/components/RefreshControl.svelte';
  import { formatCount, formatTokens, formatUsd } from '$lib/format.js';
  import { t } from '$lib/i18n';
  import type { AccountDetailData } from './+page.js';

  let { data }: { data: AccountDetailData } = $props();

  // Friendly window-key labels, mirroring the providers list (5h / 7d / 7d · Fable /
  // Weekly). Kept local + small; the providers page owns the richer scoped variant.
  function windowLabel(key: string, windowMinutes: number | null): string {
    if ((key === 'primary' || key === 'secondary') && windowMinutes === 10_080)
      return $t('Weekly');
    const map: Record<string, string> = {
      '5h': '5h',
      '7d': '7d',
      '7d-opus': '7d · Opus',
      '7d-sonnet': '7d · Sonnet',
      '7d-fable': '7d · Fable',
      primary: $t('Primary'),
      secondary: $t('Secondary'),
    };
    if (map[key]) return map[key];
    if (key.startsWith('7d-')) return `7d · ${key.slice(3)}`;
    return key;
  }

  function barColor(pct: number): string {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 75) return 'bg-amber-500';
    return 'bg-indigo-500';
  }

  // "resets in 3h 12m" / "" when unknown or elapsed.
  function resetIn(ms: number | null): string {
    if (ms == null) return '';
    const left = ms - Date.now();
    if (left <= 0) return '';
    const mins = Math.floor(left / 60_000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const parts = [d ? `${d}d` : '', h ? `${h}h` : '', !d && m ? `${m}m` : ''].filter(Boolean);
    return parts.join(' ');
  }

  // Reset-window keys present in the current summary/history (Anthropic: 5h then 7d…).
  // Natural calendar day/week views remain account-wide.
  const windowKeys = $derived.by(() => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const p of [...data.periods.current, ...data.periods.periods]) {
      if (!seen.has(p.windowKey)) {
        seen.add(p.windowKey);
        keys.push(p.windowKey);
      }
    }
    return keys;
  });

  // Default the active tab to the WEEKLY window (7d / primary / weekly) — the allowance
  // operators watch for shrinkage; fall back to the first window otherwise.
  function isWeeklyKey(key: string): boolean {
    return key === '7d' || key.startsWith('7d-') || key === 'primary' || key === 'weekly';
  }

  let activeKey = $state<string | null>(null);
  $effect(() => {
    if (activeKey === null && windowKeys.length > 0) {
      activeKey = windowKeys.find(isWeeklyKey) ?? windowKeys[0] ?? null;
    }
  });

  const quotaWindow = $derived.by((): OAuthQuotaWindow | null => {
    if (!data.quota || activeKey === null) return null;
    return data.quota.windows.find((w) => w.key === activeKey) ?? null;
  });

  const currentPeriod = $derived.by((): OAuthUsagePeriod | null => {
    if (activeKey === null) return null;
    return data.periods.current.find((p) => p.windowKey === activeKey) ?? null;
  });

  let granularity = $state<'period' | 'day' | 'week'>('period');
  const history = $derived.by(() =>
    granularity === 'period'
      ? [...data.periods.current, ...data.periods.periods].filter(
          (p) => p.windowKey === activeKey,
        )
      : granularity === 'day'
        ? data.periods.daily
        : data.periods.weekly,
  );

  // Bar-chart data (oldest → newest so the trend reads left-to-right).
  const trend = $derived([...history].reverse());
  const trendMax = $derived(Math.max(1, ...trend.map((p) => p.tokens)));

  // A scoped window caps ONE model family (Anthropic `7d-opus`/`7d-fable`, or a Codex
  // additional-limit window carrying a non-default `limitId`); Used% is model-scoped
  // but the calendar history below is account-wide (usage has no model dimension). Flag
  // it so the two aren't conflated.
  const isScopedWindow = $derived.by((): boolean => {
    if (activeKey === null) return false;
    if (activeKey.startsWith('7d-')) return true;
    const limitId = quotaWindow?.limitId;
    return limitId !== undefined && limitId !== 'codex';
  });

  // Is the live quota snapshot for the ACTIVE window stale? True when its resetsAtMs is
  // missing or already past — then Used% / countdown belong to a finished window and
  // must not be shown as the current period's.
  const snapshotStale = $derived.by((): boolean => {
    const r = quotaWindow?.resetsAtMs;
    return r == null || r <= Date.now();
  });

  // Label a calendar period: a day shows its date; a week shows "start – end". For an
  // in-progress week (partial, ends in the future) clip the end to today so the label
  // doesn't imply a full Mon–Sun span that hasn't happened yet.
  function periodLabel(p: OAuthUsagePeriod): string {
    const start = new Date(p.periodStartMs);
    if (granularity === 'period') {
      return `${start.toLocaleString()} – ${new Date(p.periodEndMs).toLocaleString()}`;
    }
    if (granularity === 'day') return start.toLocaleDateString();
    const endMs = Math.min(p.periodEndMs, Date.now());
    const end = new Date(endMs - 1); // inclusive last day
    return `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
  }
</script>

<div class="w-full px-4 py-6 md:px-8 md:py-8">
  <header class="mb-5">
    <a class="link-inline text-sm" href={`${base}/providers`}>← {$t('Providers')}</a>
    <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="page-title">{data.account}</h1>
      <code class="font-mono text-sm text-ink-muted">{data.providerId}</code>
    </div>
    <p class="mt-1 text-sm text-ink-muted">
      {$t('Token usage per quota reset period. Periods marked ≈ have approximate boundaries.')}
    </p>
    <div class="mt-3">
      <RefreshControl onRefresh={invalidateAll} />
    </div>
  </header>

  {#if windowKeys.length === 0 && history.length === 0}
    <div class="empty-state">{$t('No usage recorded for this account yet.')}</div>
  {:else}
    {#if windowKeys.length > 0}
    <!-- Window tabs: one per reset cadence (an account can have several). -->
    <div class="mb-5 flex flex-wrap gap-2" role="tablist">
      {#each windowKeys as key (key)}
        <button
          type="button"
          role="tab"
          aria-selected={activeKey === key}
          class={activeKey === key ? 'btn-primary' : 'btn-secondary'}
          onclick={() => (activeKey = key)}
        >
          {windowLabel(key, data.quota?.windows.find((w) => w.key === key)?.windowMinutes ?? null)}
        </button>
      {/each}
    </div>

    {#if isScopedWindow}
      <p class="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        {$t('This window caps one model, but the history below is account-wide (usage is not tracked per model). Use “Used %” for this window’s own consumption.')}
      </p>
    {/if}

    <!-- (a) Current reset-window summary — the real resetsAtMs boundary, exact. -->
    <section class="mb-6">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="section-header">
          {$t('Current period')}
          {#if currentPeriod?.approximate}<span class="text-xs text-ink-muted">≈</span>{/if}
          {#if currentPeriod?.partial}<span class="text-xs text-amber-600">{$t('(partial)')}</span>{/if}
        </h2>
        {#if quotaWindow && !snapshotStale && resetIn(quotaWindow.resetsAtMs)}
          <span class="text-sm text-ink-muted"
            >{$t('resets in {t}', { t: resetIn(quotaWindow.resetsAtMs) })}</span
          >
        {/if}
      </div>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <div class="card">
          <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
            {$t('Requests')}
          </div>
          <div class="mt-1 text-2xl font-semibold text-slate-900">
            {formatCount(currentPeriod?.requests ?? 0)}
          </div>
        </div>
        <div class="card">
          <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
            {$t('Tokens')}
          </div>
          <div class="mt-1 text-2xl font-semibold text-slate-900">
            {formatTokens(currentPeriod?.tokens ?? 0)}
          </div>
        </div>
        <div class="card">
          <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
            {$t('Cost')}
          </div>
          <div class="mt-1 text-2xl font-semibold text-slate-900">
            {formatUsd(currentPeriod?.costUsd ?? null)}
          </div>
        </div>
        <div class="card">
          <div class="text-xs font-medium uppercase tracking-wide text-slate-400">
            {$t('Used')}
          </div>
          <!-- Used% comes from the live quota snapshot and is valid as long as the
               snapshot boundary is still in the future. Only when the snapshot is STALE
               (resetsAtMs missing/past) does Used% belong to a finished window — then
               show "—" rather than pair a low new-period token count with a high stale
               Used% (a false "shrank" signal). A non-hour-aligned but fresh snapshot
               keeps Used% (grok review R3-1). -->
          {#if quotaWindow && !snapshotStale}
            <div class="mt-1 text-2xl font-semibold text-slate-900">
              {Math.round(quotaWindow.usedPercent)}%
            </div>
            <div class="progress-track mt-2">
              <div
                class={`progress-bar ${barColor(quotaWindow.usedPercent)}`}
                style={`width: ${Math.min(100, quotaWindow.usedPercent)}%`}
              ></div>
            </div>
          {:else}
            <div class="mt-1 text-2xl font-semibold text-slate-900">—</div>
            {#if quotaWindow && snapshotStale}
              <div class="mt-1 text-xs text-ink-muted">{$t('snapshot may be stale')}</div>
            {/if}
          {/if}
        </div>
      </div>
    </section>
    {/if}

    <!-- Reset periods are primary; natural day/week remain as compatibility views. -->
    <div class="mb-3 flex items-center justify-between">
      <h2 class="section-header">{$t('Usage history')}</h2>
      <div class="flex gap-1" role="tablist">
        <button
          type="button"
          class={granularity === 'period' ? 'btn-primary' : 'btn-secondary'}
          onclick={() => (granularity = 'period')}>{$t('Period')}</button
        >
        <button
          type="button"
          class={granularity === 'day' ? 'btn-primary' : 'btn-secondary'}
          onclick={() => (granularity = 'day')}>{$t('Daily')}</button
        >
        <button
          type="button"
          class={granularity === 'week' ? 'btn-primary' : 'btn-secondary'}
          onclick={() => (granularity = 'week')}>{$t('Weekly')}</button
        >
      </div>
    </div>

    <section class="card mb-6">
      {#if trend.length > 0}
        <!-- Each column is a full-height flex item so the bar inside can size to a
             percentage of the h-40 track (a % height needs a parent with a resolved
             height — the column itself must be h-full, not shrink-to-content). -->
        <div class="flex h-40 items-end gap-1">
          {#each trend as p, i (i)}
            <div class="flex h-full flex-1 items-end">
              <div
                class={`w-full rounded-t ${p === currentPeriod ? 'bg-emerald-400' : p.partial ? 'bg-slate-300' : 'bg-indigo-400'}`}
                style={`height: ${Math.max(2, (p.tokens / trendMax) * 100)}%`}
                title={`${periodLabel(p)} — ${formatTokens(p.tokens)} tokens${p.partial ? ' (partial)' : ''}`}
              ></div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-state">{$t('No usage recorded for this account yet.')}</div>
      {/if}
    </section>

    <!-- History table -->
    <section class="cards-table-frame">
      <table class="cards-table">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2 text-left">
              {granularity === 'period'
                ? $t('Period')
                : granularity === 'day'
                  ? $t('Day')
                  : $t('Week')}
            </th>
            <th class="px-3 py-2 text-right">{$t('Requests')}</th>
            <th class="px-3 py-2 text-right">{$t('Tokens')}</th>
            <th class="px-3 py-2 text-right">{$t('Cost')}</th>
            <th class="px-3 py-2 text-right">{$t('Used')} %</th>
          </tr>
        </thead>
        <tbody>
          {#each history as p (p.periodStartMs)}
            <tr>
              <td data-label={$t('Period')} class="px-3 py-2">
                {periodLabel(p)}
                {#if p === currentPeriod}
                  <span class="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700"
                    >{$t('Current period')}</span
                  >
                {/if}
                {#if p.approximate}
                  <span class="ml-1 text-xs text-ink-muted">≈</span>
                {/if}
                {#if p.partial}
                  <span class="ml-1 text-xs text-amber-600">{$t('(partial)')}</span>
                {/if}
              </td>
              <td data-label={$t('Requests')} class="px-3 py-2 text-right font-mono"
                >{formatCount(p.requests)}</td
              >
              <td data-label={$t('Tokens')} class="px-3 py-2 text-right font-mono"
                >{formatTokens(p.tokens)}</td
              >
              <td data-label={$t('Cost')} class="px-3 py-2 text-right font-mono"
                >{formatUsd(p.costUsd)}</td
              >
              <td data-label={`${$t('Used')} %`} class="px-3 py-2 text-right font-mono">
                {granularity === 'period' && p.usedPercent != null
                  ? `${Math.round(p.usedPercent)}%`
                  : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>
