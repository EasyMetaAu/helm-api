<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { OAuthQuotaWindow, UpstreamProviderUsage } from '@helm/shared';
  import { getUpstreamUsage } from '$lib/api/upstream-usage.js';
  import { accountDetailHref } from '$lib/oauth-account-id.js';
  import { durationParts, formatCount, formatTokens, formatUsd } from '$lib/format';
  import { t } from '$lib/i18n';

  let result = $state<UpstreamProviderUsage | null>(null);
  let error = $state(false);
  let busy = $state(false);
  let now = $state(Date.now());
  let active = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const next = await getUpstreamUsage();
      if (active) {
        result = next;
        error = false;
      }
    } catch {
      if (active) error = true;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    active = true;
    void refresh();
    const timer = setInterval(() => {
      now = Date.now();
      if (document.visibilityState !== 'hidden') void refresh();
    }, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  });

  const STALE_QUOTA_MS = 300_000;
  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  const timestamp = (ms: number | null | undefined) =>
    ms == null ? $t('Unknown') : new Date(ms).toLocaleString();

  function planLabel(plan: string): string {
    return plan
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
      .join(' ');
  }

  function titleFromSlug(slug: string): string {
    return slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) =>
        part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
      )
      .join(' ');
  }

  // Window labels mirror the Providers page: the quota duration is authoritative, the
  // primary/secondary key is only a neutral fallback when no duration is reported.
  function durationWindowLabel(windowMinutes: number | null | undefined): string | null {
    if (windowMinutes == null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
    if (windowMinutes === 300) return '5h';
    if (windowMinutes === 10_080) return $t('Weekly');
    if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
  }

  function windowLabel(key: string, windowMinutes: number | null | undefined): string {
    const durationLabel = durationWindowLabel(windowMinutes);
    if (
      durationLabel &&
      (key === 'primary' ||
        key === 'secondary' ||
        key.endsWith('-primary') ||
        key.endsWith('-secondary'))
    ) {
      return durationLabel;
    }
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
    if (key.endsWith('-primary')) return $t('Primary');
    if (key.endsWith('-secondary')) return $t('Secondary');
    if (key.startsWith('7d-')) return `7d · ${titleFromSlug(key.slice(3))}`;
    return key;
  }

  function quotaWindowLabel(window: OAuthQuotaWindow): string {
    const label = windowLabel(window.key, window.windowMinutes);
    const scope =
      window.limitName?.trim() ||
      (window.limitId && window.limitId !== 'codex' ? titleFromSlug(window.limitId) : null);
    return scope ? `${scope} · ${label}` : label;
  }

  // Same ramp as the Providers page: calm under 75%, warning to 90%, danger beyond.
  function barColor(pct: number): string {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 75) return 'bg-amber-500';
    return 'bg-indigo-500';
  }

  // ARIA keeps the clamped value; the drawn bar keeps the Providers page's 2% sliver so
  // a measured 0% still reads as a track with data rather than an empty one.
  const barWidth = (pct: number) => (Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0);
  const percentText = (pct: number) =>
    Number.isFinite(pct) ? `${numberFormat.format(pct)}%` : '—';
  const roundedPercent = (pct: number) => (Number.isFinite(pct) ? `${Math.round(pct)}%` : '—');

  // Countdown from an absolute reset timestamp; elapsed/absent ⇒ "". Shares
  // `durationParts` with the Providers page so a weekly window reads "4d 16h".
  function resetIn(ms: number | null | undefined): string {
    if (ms == null) return '';
    const left = ms - now;
    if (left <= 0) return '';
    const p = durationParts(left);
    if (p.unit === 'dh') return $t('resets in {d}d {h}h', { d: p.d, h: p.h });
    if (p.unit === 'hm') return $t('resets in {h}h {m}m', { h: p.h, m: p.m });
    return $t('resets in {m}m', { m: p.m });
  }

  function autoRecoverIn(ms: number): string {
    const left = ms - now;
    if (left <= 0) return '';
    const p = durationParts(left);
    if (p.unit === 'dh') return $t('auto-recovers in {d}d {h}h', { d: p.d, h: p.h });
    if (p.unit === 'hm') return $t('auto-recovers in {h}h {m}m', { h: p.h, m: p.m });
    return $t('auto-recovers in {m}m', { m: p.m });
  }

  // Credit amounts arrive as long decimal strings; show a short number and keep the
  // exact value for the tooltip only when rounding changed it.
  function amount(value: string | number | null | undefined): { text: string; full?: string } {
    if (value == null) return { text: $t('Unknown') };
    const raw = String(value);
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return { text: raw };
    const text = numberFormat.format(parsed);
    return text === raw ? { text } : { text, full: raw };
  }

  function rateLimitLabel(type: string): string {
    switch (type) {
      case 'rate_limit_reached':
        return $t('Rate limit reached');
      case 'workspace_owner_credits_depleted':
      case 'workspace_member_credits_depleted':
        return $t('Workspace credits depleted');
      case 'workspace_owner_usage_limit_reached':
      case 'workspace_member_usage_limit_reached':
        return $t('Workspace usage limit reached');
      default:
        return type;
    }
  }

  function creditStatusLabel(status: string): string {
    switch (status) {
      case 'available':
        return $t('Available');
      case 'redeeming':
        return $t('Redeeming');
      case 'redeemed':
        return $t('Redeemed');
      case 'unknown':
        return $t('Unknown');
      default:
        return status;
    }
  }

  function apiKeyStateLabel(state: string): string {
    switch (state) {
      case 'ready':
        return $t('Ready');
      case 'quota_exhausted':
        return $t('Quota exhausted');
      case 'invalid':
        return $t('Invalid');
      case 'cooldown':
        return $t('Cooldown');
      default:
        return state;
    }
  }

  const apiKeyStateBadge = (state: string) =>
    state === 'ready' ? 'badge-ok' : state === 'invalid' ? 'badge-error' : 'badge-warning';

  function spendUsedPercent(remainingPercent: number | null | undefined): number | null {
    return typeof remainingPercent === 'number' && Number.isFinite(remainingPercent)
      ? Math.min(100, Math.max(0, 100 - remainingPercent))
      : null;
  }
</script>

{#snippet quotaTrack(pct: number, label: string, resetsAtMs: number | null | undefined)}
  {@const countdown = resetIn(resetsAtMs)}
  <div>
    <div class="flex items-center justify-between gap-1 text-xs text-ink-muted">
      <span>{label}</span>
      <span class="shrink-0 tabular-nums" title={Number.isFinite(pct) ? `${pct}%` : undefined}
        >{roundedPercent(pct)}</span
      >
    </div>
    <div
      class="progress-track"
      role="progressbar"
      aria-label={`${label} ${$t('Used')}`}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Number.isFinite(pct) ? barWidth(pct) : undefined}
      aria-valuetext={percentText(pct)}
    >
      <div
        class={`progress-bar ${barColor(pct)}`}
        style={`width:${Math.max(2, barWidth(pct))}%`}
      ></div>
    </div>
    {#if countdown}
      <div
        class="text-[10px] text-ink-muted"
        title={`${$t('Resets at')}: ${timestamp(resetsAtMs)}`}
      >
        {countdown}
      </div>
    {/if}
  </div>
{/snippet}

{#if result?.configured || error}
  <section class="flex flex-col gap-2" aria-labelledby="upstream-usage-title">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h2 id="upstream-usage-title" class="section-header shrink-0">{$t('Upstream usage')}</h2>
      {#if result?.configured}
        <p class="field-help order-2 w-full min-w-0 tabular-nums md:order-none md:w-auto md:flex-1">
          <span class="break-all">{result.source}</span> · {$t('Snapshot read at')}: {timestamp(
            result.snapshot.generatedAt,
          )}
        </p>
      {/if}
      <button
        type="button"
        class="btn-secondary ml-auto shrink-0"
        disabled={busy}
        aria-busy={busy}
        onclick={refresh}>{$t('Refresh upstream usage')}</button
      >
    </header>
    <p class="field-help">
      {$t(
        'Read-only. Subscription quotas cover the provider account; request and token totals cover traffic through the upstream Helm, not this instance.',
      )}
    </p>
    {#if error}<p role="alert" class="alert-error">
        {$t('Upstream usage is unavailable. Any values below are from the last successful read.')}
      </p>{/if}
    {#if result?.configured}
      {@const snapshot = result.snapshot}
      {@const rows = snapshot.providers.flatMap((provider) =>
        provider.accounts.map((account) => ({ provider, account })),
      )}
      {@const keyRows = snapshot.apiKeyPools.flatMap((pool) =>
        pool.accounts.map((account) => ({ pool, account })),
      )}
      {#if rows.length > 0}
        <div class="cards-table-frame overflow-visible">
          <table class="cards-table">
            <caption class="sr-only">{$t('Upstream usage')}</caption>
            <thead class="table-head">
              <tr>
                <th class="px-3 py-2">{$t('Provider')}</th>
                <th class="px-3 py-2">{$t('Today')}</th>
                <th class="px-3 py-2">{$t('Quota')}</th>
                <th class="px-3 py-2 table-mode:text-right">{$t('Details')}</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as { provider, account } (`${provider.id}/${account.account}`)}
                {@const usage = snapshot.usage.find(
                  (r) => r.providerId === provider.id && r.account === account.account,
                )}
                {@const quota = snapshot.quota.find(
                  (r) => r.providerId === provider.id && r.account === account.account,
                )}
                {@const plan =
                  quota?.planType ?? account.anthropicPlanType ?? account.chatgptPlanType}
                {@const limitedUntil =
                  quota?.usageLimitedUntilMs && quota.usageLimitedUntilMs > now
                    ? quota.usageLimitedUntilMs
                    : null}
                {@const recovery = limitedUntil ? autoRecoverIn(limitedUntil) : ''}
                {@const stale = quota ? now - quota.capturedAt > STALE_QUOTA_MS : false}
                {@const spend = quota?.individualLimit}
                {@const spendUsed = spend ? spendUsedPercent(spend.remainingPercent) : null}
                <tr class="align-top">
                  <!-- Provider / account + health, mirroring the subscription table. The
                     account links to its usage detail, read from the upstream source. -->
                  <td
                    data-label={$t('Provider')}
                    class="table-mode:w-56 table-mode:whitespace-normal"
                  >
                    <a
                      class="group block"
                      href={`${accountDetailHref(base, provider.id, account.account)}?source=upstream`}
                      title={$t('View token usage per reset period')}
                    >
                      <div
                        class="font-medium text-ink-body group-hover:text-indigo-600 group-hover:underline"
                      >
                        {provider.name}
                      </div>
                      <code
                        class="break-all font-mono text-xs text-ink-strong group-hover:text-indigo-600"
                      >
                        {account.account}
                      </code>
                    </a>
                    {#if (account.email && account.email !== account.account) || plan}
                      <div class="mt-1 flex max-w-52 flex-col items-start gap-1 text-xs">
                        {#if account.email && account.email !== account.account}
                          <span class="break-all text-ink-body">{account.email}</span>
                        {/if}
                        {#if plan}<span class="badge-neutral">{planLabel(plan)}</span>{/if}
                      </div>
                    {/if}
                    <!-- Health (+ parked / rate-limit pill and its recovery time) -->
                    <div class="mt-1.5 flex flex-wrap items-center gap-1">
                      {#if account.healthy}
                        <span class="badge-ok">{$t('connected')}</span>
                      {:else}
                        <span class="badge-error">{$t('needs reconnect')}</span>
                      {/if}
                      {#if !account.schedulable}
                        <span class="badge-neutral">{$t('parked')}</span>
                      {/if}
                      {#if limitedUntil}
                        <span class="badge-error">{$t('Rate limited')}</span>
                        {#if recovery}
                          <span
                            class="basis-full text-[10px] text-ink-muted"
                            title={`${$t('Limited until')}: ${timestamp(limitedUntil)}`}
                            >{recovery}</span
                          >
                        {/if}
                      {/if}
                    </div>
                  </td>

                  <!-- Today's usage; an absent row is unavailable, a zero row is measured. -->
                  <td data-label={$t('Today')} class="text-xs tabular-nums">
                    {#if usage}
                      <div class="text-ink-body">
                        <span>{$t('{n} req', { n: formatCount(usage.requests) })}</span>
                        <span class="text-ink-muted">
                          · {usage.rpm == null ? '—' : numberFormat.format(usage.rpm)} RPM</span
                        >
                      </div>
                      <div class="text-ink-muted">
                        <span>{formatTokens(usage.tokens)} tok</span> ·
                        <span>{formatUsd(usage.costUsd)}</span>
                      </div>
                    {:else}
                      <span class="text-ink-muted">—</span>
                    {/if}
                  </td>

                  <!-- Quota windows (+ monthly credit limit), countdowns only; exact
                     timestamps and amounts live in Details. -->
                  <td data-label={$t('Quota')}>
                    {#if quota && (quota.windows.length > 0 || spendUsed != null)}
                      <div class="flex w-full flex-col gap-1.5 table-mode:w-36">
                        {#each quota.windows as window (`${window.limitId ?? ''}/${window.key}`)}
                          {@render quotaTrack(
                            window.usedPercent,
                            quotaWindowLabel(window),
                            window.resetsAtMs,
                          )}
                        {/each}
                        {#if spend && spendUsed != null}
                          {@render quotaTrack(
                            spendUsed,
                            $t('Monthly credit limit'),
                            spend.resetsAtMs,
                          )}
                        {/if}
                      </div>
                    {:else}
                      <span class="text-xs text-ink-muted" title={$t('Quota unavailable')}>—</span>
                    {/if}
                    {#if quota?.rateLimitReachedType}
                      <div class="mt-1 text-[10px] text-ink-muted">
                        {rateLimitLabel(quota.rateLimitReachedType)}
                      </div>
                    {/if}
                    {#if stale && quota}
                      <div class="mt-1.5">
                        <span
                          class="badge-warning"
                          title={`${$t('Quota captured at')}: ${timestamp(quota.capturedAt)}`}
                          >{$t('Stale quota snapshot')}</span
                        >
                      </div>
                    {/if}
                  </td>

                  <!-- Details: exact timestamps, credits and limits for this snapshot. -->
                  <td data-label={$t('Details')} class="table-mode:text-right">
                    {#if quota}
                      {@const credits = quota.credits}
                      {@const resetDetails = quota.resetCreditDetails ?? []}
                      <details class="menu">
                        <summary class="btn-secondary list-none [&::-webkit-details-marker]:hidden"
                          >{$t('Details')}</summary
                        >
                        <div
                          class="menu-panel max-h-96 w-72 max-w-[calc(100vw-3rem)] overflow-y-auto whitespace-normal p-3 text-left text-xs"
                        >
                          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums">
                            <dt class="text-ink-muted">{$t('Quota captured at')}</dt>
                            <dd class="text-ink-body">
                              {timestamp(quota.capturedAt)}{#if stale}
                                · {$t('Stale quota snapshot')}{/if}
                            </dd>
                            {#each quota.windows as window (`${window.limitId ?? ''}/${window.key}`)}
                              <dt class="text-ink-muted">{quotaWindowLabel(window)}</dt>
                              <dd class="text-ink-body">
                                {percentText(window.usedPercent)} · {$t('Resets at')}: {timestamp(
                                  window.resetsAtMs,
                                )}
                              </dd>
                            {/each}
                            {#if limitedUntil}
                              <dt class="text-ink-muted">{$t('Limited until')}</dt>
                              <dd class="text-ink-body">{timestamp(limitedUntil)}</dd>
                            {/if}
                            {#if quota.rateLimitReachedType}
                              <dt class="text-ink-muted">{$t('Limit reached')}</dt>
                              <dd class="text-ink-body">
                                {rateLimitLabel(quota.rateLimitReachedType)}
                              </dd>
                            {/if}
                            {#if credits}
                              {@const balance = amount(credits.balance)}
                              <dt class="text-ink-muted">{$t('Credits')}</dt>
                              <dd
                                class="text-ink-body"
                                title={credits.unlimited ? undefined : balance.full}
                              >
                                {credits.unlimited ? $t('Unlimited') : balance.text}
                              </dd>
                            {/if}
                            {#if quota.resetCredits != null}
                              <dt class="text-ink-muted">{$t('Reset credits')}</dt>
                              <dd class="text-ink-body">{quota.resetCredits}</dd>
                            {/if}
                            {#if spend}
                              {@const used = amount(spend.used)}
                              {@const limit = amount(spend.limit)}
                              <dt class="text-ink-muted">{$t('Monthly credit limit')}</dt>
                              <dd class="text-ink-body">
                                <span title={used.full}>{used.text}</span> /
                                <span title={limit.full}>{limit.text}</span>
                              </dd>
                              <dt class="text-ink-muted">{$t('Remaining')}</dt>
                              <dd class="text-ink-body">{percentText(spend.remainingPercent)}</dd>
                              <dt class="text-ink-muted">{$t('Resets at')}</dt>
                              <dd class="text-ink-body">{timestamp(spend.resetsAtMs)}</dd>
                            {/if}
                          </dl>
                          {#if resetDetails.length > 0}
                            <ul class="mt-2 flex flex-col gap-1 tabular-nums text-ink-muted">
                              {#each resetDetails as credit (credit.id)}
                                <li>
                                  {credit.title ??
                                    (credit.resetType === 'codexRateLimits'
                                      ? $t('Reset credits')
                                      : $t('Unknown'))} · {creditStatusLabel(credit.status)} · {$t(
                                    'Expires',
                                  )}: {timestamp(credit.expiresAt)}
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        </div>
                      </details>
                    {:else}
                      <span class="text-xs text-ink-muted">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if keyRows.length > 0}
        <h3 class="mt-2 text-sm font-semibold text-ink-strong">{$t('API key accounts')}</h3>
        <div class="cards-table-frame">
          <table class="cards-table">
            <caption class="sr-only">{$t('API key accounts')}</caption>
            <thead class="table-head">
              <tr>
                <th class="px-3 py-2">{$t('Provider')}</th>
                <th class="px-3 py-2">{$t('Last 24 hours')}</th>
              </tr>
            </thead>
            <tbody>
              {#each keyRows as { pool, account } (`${pool.id}/${account.id}`)}
                {@const usage = pool.usage.find((row) => row.account === account.id)}
                <tr class="align-top">
                  <td
                    data-label={$t('Provider')}
                    class="table-mode:w-56 table-mode:whitespace-normal"
                  >
                    <div class="font-medium text-ink-body">{pool.id}</div>
                    <code class="break-all font-mono text-xs text-ink-strong">{account.name}</code>
                    <div class="mt-1.5 flex flex-wrap items-center gap-1">
                      <span class={apiKeyStateBadge(account.state)}
                        >{apiKeyStateLabel(account.state)}</span
                      >
                      {#if !account.enabled}
                        <span class="badge-neutral">{$t('Paused')}</span>
                      {/if}
                      {#if account.nextRetryAt}
                        <span class="basis-full text-[10px] tabular-nums text-ink-muted"
                          >{$t('Retry at')}: {timestamp(account.nextRetryAt)}</span
                        >
                      {/if}
                    </div>
                  </td>
                  <td data-label={$t('Last 24 hours')} class="text-xs tabular-nums">
                    {#if usage}
                      <div class="text-ink-body">
                        {$t('{n} req', { n: formatCount(usage.requests) })}
                      </div>
                      <div class="text-ink-muted">
                        <span>{formatTokens(usage.tokens)} tok</span> ·
                        <span>{formatUsd(usage.costUsd)}</span>
                      </div>
                    {:else}
                      <span class="text-ink-muted">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if rows.length === 0 && keyRows.length === 0}
        <p class="empty-state">{$t('No upstream accounts')}</p>
      {/if}
    {/if}
  </section>
{/if}
