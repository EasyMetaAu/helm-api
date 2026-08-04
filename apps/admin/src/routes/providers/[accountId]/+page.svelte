<script lang="ts">
  import { base } from '$app/paths';
  import type { OAuthQuotaWindow, OAuthUsagePeriod } from '$lib/api/oauth.js';
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

  // epoch ms → local date-time string (formatTimestamp takes an ISO string).
  function fmtTime(ms: number): string {
    return new Date(ms).toLocaleString();
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

  // Distinct window keys present in the response, preserving the order the current
  // periods appear (Anthropic: 5h then 7d…). Each becomes a tab.
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

  // Default the active tab to the WEEKLY window (7d / primary / weekly) — that's the
  // allowance operators watch for shrinkage; fall back to the first window otherwise.
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

  // History for the active window, most recent first.
  const historyPeriods = $derived.by((): OAuthUsagePeriod[] =>
    activeKey === null ? [] : data.periods.periods.filter((p) => p.windowKey === activeKey),
  );

  // Bar-chart data (oldest → newest so the trend reads left-to-right). Current period
  // last, marked so it can be tinted differently.
  const trend = $derived.by(() => {
    const hist = [...historyPeriods].reverse().map((p) => ({ period: p, current: false }));
    const cur = currentPeriod ? [{ period: currentPeriod, current: true }] : [];
    return [...hist, ...cur];
  });
  const trendMax = $derived(Math.max(1, ...trend.map((b) => b.period.tokens)));

  // A scoped window caps ONE model family (Anthropic `7d-opus`/`7d-fable`, or a Codex
  // additional-limit window carrying a non-default `limitId`), but oauth_usage has no
  // model dimension — so the token totals shown here are account-wide, not just this
  // window's model. Flag it so the number isn't misread as this window's own
  // consumption (grok review R1-4 / R2-3).
  const isScopedWindow = $derived.by((): boolean => {
    if (activeKey === null) return false;
    if (activeKey.startsWith('7d-')) return true;
    const limitId = quotaWindow?.limitId;
    return limitId !== undefined && limitId !== 'codex';
  });

  // Distinguish two empty states (grok review R1-5): the account has quota windows
  // but NONE can be sliced (no resetsAtMs anchor / unknown window length) vs the
  // account genuinely has no recorded traffic. The first needs a fresh quota refresh,
  // not "no usage".
  const hasUnanchorableWindows = $derived(
    windowKeys.length === 0 && (data.quota?.windows.length ?? 0) > 0,
  );

  // Is the live quota snapshot for the ACTIVE window stale? Only true when its
  // resetsAtMs is missing or already in the past — that's the case where Used% and the
  // countdown belong to a FINISHED window and must not be shown next to the
  // reconstructed current-period tokens (grok review R3-1). A merely non-hour-aligned
  // boundary (the common case — real resetsAtMs rarely lands on the hour) still makes
  // token totals `approximate` (the ≈ marker) but leaves the snapshot's Used% VALID.
  const snapshotStale = $derived.by((): boolean => {
    const r = quotaWindow?.resetsAtMs;
    return r == null || r <= Date.now();
  });
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
  </header>

  {#if windowKeys.length === 0}
    {#if hasUnanchorableWindows}
      <div class="empty-state">
        {$t('This account has no reset time yet, so usage cannot be split into periods. Refresh the provider to fetch a fresh quota snapshot.')}
      </div>
    {:else}
      <div class="empty-state">{$t('No usage recorded for this account yet.')}</div>
    {/if}
  {:else}
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
        {$t('This window caps one model, but token totals below are account-wide (usage is not tracked per model). Use “Used %” for this window’s own consumption.')}
      </p>
    {/if}

    <!-- (a) Current period summary -->
    <section class="mb-6">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="section-header">
          {$t('Current period')}
          {#if currentPeriod?.approximate}
            <span
              class="ml-1 text-xs font-normal text-ink-muted"
              title={$t('Approximate — the period boundary is not hour-aligned, so hour-bucket totals are within about one hour')}
              >≈</span
            >
          {/if}
          {#if currentPeriod?.partial}
            <span class="ml-1 text-xs font-normal text-amber-600">{$t('(partial)')}</span>
          {/if}
        </h2>
        <!-- Show the reset countdown while the snapshot boundary is still in the future
             (not stale). A non-hour-aligned but future resetsAtMs is fine here. -->
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

    <!-- Trend: one bar per period (oldest → newest). Spotting a downward trend is the
         whole point — a provider quietly shrinking the allowance shows here. -->
    <section class="card mb-6">
      <h2 class="section-header mb-3">{$t('Tokens per period')}</h2>
      {#if trend.length > 0}
        <!-- Each column is a full-height flex item so the bar inside can size to a
             percentage of the h-40 track (a % height needs a parent with a resolved
             height — the column itself must be h-full, not shrink-to-content). -->
        <div class="flex h-40 items-end gap-1">
          {#each trend as bar, i (i)}
            <div class="flex h-full flex-1 items-end">
              <!-- Partial periods undercount (data cut off by retention) — hatch them
                   so a short bar isn't misread as a real drop in allowance. -->
              <div
                class={`w-full rounded-t ${
                  bar.period.partial
                    ? 'bg-slate-300'
                    : bar.current
                      ? 'bg-indigo-500'
                      : 'bg-indigo-300'
                }`}
                style={`height: ${Math.max(2, (bar.period.tokens / trendMax) * 100)}%`}
                title={`${fmtTime(bar.period.periodStartMs)} — ${formatTokens(bar.period.tokens)} tokens${bar.period.partial ? ' (partial)' : ''}`}
              ></div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-state">{$t('No usage recorded for this window yet.')}</div>
      {/if}
    </section>

    <!-- (b) Historical periods -->
    <section class="cards-table-frame">
      <table class="cards-table">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2 text-left">{$t('Period')}</th>
            <th class="px-3 py-2 text-right">{$t('Requests')}</th>
            <th class="px-3 py-2 text-right">{$t('Tokens')}</th>
            <th class="px-3 py-2 text-right">{$t('Cost')}</th>
          </tr>
        </thead>
        <tbody>
          {#if currentPeriod}
            <tr class="bg-indigo-50/40">
              <td data-label={$t('Period')} class="px-3 py-2">
                {fmtTime(currentPeriod.periodStartMs)} →
                <span class="text-ink-muted">{$t('now')}</span>
                {#if currentPeriod.approximate}
                  <span
                    class="ml-1 text-xs text-ink-muted"
                    title={$t('Approximate boundary — reconstructed by rolling back a fixed window length')}
                    >≈</span
                  >
                {/if}
                {#if currentPeriod.partial}
                  <span class="ml-1 text-xs text-amber-600">{$t('(partial)')}</span>
                {/if}
              </td>
              <td data-label={$t('Requests')} class="px-3 py-2 text-right font-mono"
                >{formatCount(currentPeriod.requests)}</td
              >
              <td data-label={$t('Tokens')} class="px-3 py-2 text-right font-mono"
                >{formatTokens(currentPeriod.tokens)}</td
              >
              <td data-label={$t('Cost')} class="px-3 py-2 text-right font-mono"
                >{formatUsd(currentPeriod.costUsd)}</td
              >
            </tr>
          {/if}
          {#each historyPeriods as p (p.periodStartMs)}
            <tr>
              <td data-label={$t('Period')} class="px-3 py-2">
                {fmtTime(p.periodStartMs)} → {fmtTime(p.periodEndMs)}
                {#if p.approximate}
                  <span
                    class="ml-1 text-xs text-ink-muted"
                    title={$t('Approximate boundary — reconstructed by rolling back a fixed window length')}
                    >≈</span
                  >
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
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>
