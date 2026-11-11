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

  // Keep the bar within its bounds; the visible label and ARIA text retain actual usage.
  const barWidth = (pct: number) => (Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0);
  const percentText = (pct: number) =>
    Number.isFinite(pct) ? `${numberFormat.format(pct)}%` : '—';

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

{#snippet usageBar(pct: number, label: string)}
  <div
    class="progress-track"
    role="progressbar"
    aria-label={label}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Number.isFinite(pct) ? barWidth(pct) : undefined}
    aria-valuetext={percentText(pct)}
  >
    <div class={`progress-bar ${barColor(pct)}`} style={`width:${barWidth(pct)}%`}></div>
  </div>
{/snippet}

{#snippet trafficCell(
  usage:
    | { requests: number; tokens: number; costUsd?: number | null; rpm?: number | null }
    | undefined,
  showRpm: boolean,
)}
  {#if usage}
    <div class="text-sm tabular-nums text-ink-strong">
      {$t('{requests} requests · {tokens} tokens', {
        requests: formatCount(usage.requests),
        tokens: formatTokens(usage.tokens),
      })}
    </div>
    <div class="text-xs tabular-nums text-ink-muted">
      {$t('Estimated cost')}: {formatUsd(usage.costUsd)}{#if showRpm}
        · {$t('Average RPM')}: {usage.rpm == null ? '—' : numberFormat.format(usage.rpm)}{/if}
    </div>
  {:else}
    <span class="text-xs text-ink-muted">—</span>
  {/if}
{/snippet}

{#if result?.configured || error}
  <section class="flex flex-col gap-3" aria-labelledby="upstream-usage-title">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 id="upstream-usage-title" class="section-header">{$t('Upstream usage')}</h2>
        {#if result?.configured}<p class="section-desc break-all">{result.source}</p>{/if}
      </div>
      <button type="button" class="btn-secondary" disabled={busy} aria-busy={busy} onclick={refresh}
        >{$t('Refresh upstream usage')}</button
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
      <p class="field-help tabular-nums">
        {$t('Snapshot read at')}: {timestamp(snapshot.generatedAt)}
      </p>
      {#each snapshot.providers as provider (provider.id)}
        {#if provider.accounts.length > 0}
          <h3 class="font-semibold text-ink-strong">{provider.name}</h3>
          <div class="cards-table-frame compact">
            <table class="cards-table">
              <caption class="sr-only">{provider.name}</caption>
              <thead class="table-head">
                <tr>
                  <th class="px-3 py-2">{$t('Account')}</th>
                  <th class="px-3 py-2">{$t('Quota')}</th>
                  <th class="px-3 py-2">{$t('Today')}</th>
                </tr>
              </thead>
              <tbody>
                {#each provider.accounts as account (account.account)}
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
                  {@const credits = quota?.credits}
                  {@const spend = quota?.individualLimit}
                  {@const spendUsed = spend ? spendUsedPercent(spend.remainingPercent) : null}
                  {@const resetDetails = quota?.resetCreditDetails ?? []}
                  {@const hasDetails =
                    Boolean(credits || spend) ||
                    quota?.resetCredits != null ||
                    resetDetails.length > 0}
                  <tr class="align-top">
                    <td
                      data-label={$t('Account')}
                      class="table-mode:w-72 table-mode:whitespace-normal"
                    >
                      <a
                        class="link-inline break-all font-medium"
                        href={`${accountDetailHref(base, provider.id, account.account)}?source=upstream`}
                        title={$t('View token usage per reset period')}>{account.account}</a
                      >
                      {#if account.email && account.email !== account.account}<div
                          class="break-all text-xs text-ink-muted"
                        >
                          {account.email}
                        </div>{/if}
                      <div class="mt-1.5 flex flex-wrap items-center gap-1">
                        <span class="badge-neutral">{plan ? planLabel(plan) : $t('Unknown')}</span>
                        <span class={account.healthy ? 'badge-ok' : 'badge-error'}
                          >{account.healthy ? $t('Healthy') : $t('Needs attention')}</span
                        >
                        <span class={account.schedulable ? 'badge-neutral' : 'badge-warning'}
                          >{account.schedulable ? $t('Enabled') : $t('Paused')}</span
                        >
                      </div>
                    </td>

                    <td data-label={$t('Quota')} class="table-mode:whitespace-normal">
                      <div class="flex w-full max-w-sm flex-col gap-2">
                        {#if quota}
                          {#each quota.windows as window (`${window.limitId ?? ''}/${window.key}`)}
                            {@const label = quotaWindowLabel(window)}
                            {@const countdown = resetIn(window.resetsAtMs)}
                            <div>
                              <div class="mb-1 flex items-baseline justify-between gap-2 text-xs">
                                <span class="min-w-0 font-medium text-ink-strong">{label}</span>
                                <span class="shrink-0 tabular-nums text-ink-body"
                                  >{percentText(window.usedPercent)}</span
                                >
                              </div>
                              {@render usageBar(window.usedPercent, `${label} ${$t('Used')}`)}
                              <div class="mt-0.5 text-[11px] tabular-nums text-ink-muted">
                                {#if countdown}{countdown} ·
                                {/if}{$t('Resets at')}: {timestamp(window.resetsAtMs)}
                              </div>
                            </div>
                          {/each}
                          {#if quota.windows.length === 0}
                            <span class="text-xs text-ink-muted">{$t('Quota unavailable')}</span>
                          {/if}
                          {#if limitedUntil || quota.rateLimitReachedType}
                            <div class="flex flex-wrap items-center gap-1">
                              {#if quota.rateLimitReachedType}
                                <span class="badge-error"
                                  >{$t('Limit reached')}: {rateLimitLabel(
                                    quota.rateLimitReachedType,
                                  )}</span
                                >
                              {/if}
                              {#if limitedUntil}
                                <span class="badge-warning tabular-nums"
                                  >{$t('Limited until')}: {timestamp(limitedUntil)}</span
                                >
                              {/if}
                            </div>
                          {/if}
                          {#if hasDetails}
                            <details class="text-xs">
                              <summary
                                class="w-fit cursor-pointer select-none rounded text-xs font-medium text-ink-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                                >{$t('Details')}</summary
                              >
                              <dl
                                class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums"
                              >
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
                                  <dt class="text-ink-muted">{$t('Spend limit')}</dt>
                                  <dd class="text-ink-body">
                                    <span title={used.full}>{used.text}</span> /
                                    <span title={limit.full}>{limit.text}</span>
                                  </dd>
                                  <dt class="text-ink-muted">{$t('Remaining')}</dt>
                                  <dd class="text-ink-body">
                                    {percentText(spend.remainingPercent)}
                                  </dd>
                                  {#if spendUsed != null}
                                    <dd class="col-span-2">
                                      {@render usageBar(
                                        spendUsed,
                                        `${$t('Spend limit')} ${$t('Used')}`,
                                      )}
                                    </dd>
                                  {/if}
                                  <dt class="text-ink-muted">{$t('Resets at')}</dt>
                                  <dd class="text-ink-body">{timestamp(spend.resetsAtMs)}</dd>
                                {/if}
                              </dl>
                              {#if resetDetails.length > 0}
                                <ul class="mt-1.5 flex flex-col gap-1 text-ink-muted">
                                  {#each resetDetails as credit (credit.id)}
                                    <li class="tabular-nums">
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
                            </details>
                          {/if}
                          <div class="text-[11px] tabular-nums text-ink-muted">
                            {$t('Quota captured at')}: {timestamp(quota.capturedAt)}
                            {#if now - quota.capturedAt > STALE_QUOTA_MS}
                              <span class="badge-warning ml-1">{$t('Stale quota snapshot')}</span>
                            {/if}
                          </div>
                        {:else}
                          <span class="text-xs text-ink-muted">{$t('Quota unavailable')}</span>
                        {/if}
                      </div>
                    </td>

                    <td data-label={$t('Today')}>
                      {@render trafficCell(usage, true)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/each}
      {#each snapshot.apiKeyPools as pool (pool.id)}
        {#if pool.accounts.length > 0}
          <h3 class="font-semibold text-ink-strong">{pool.id} · {$t('API key accounts')}</h3>
          <div class="cards-table-frame compact">
            <table class="cards-table">
              <caption class="sr-only">{pool.id} · {$t('API key accounts')}</caption>
              <thead class="table-head">
                <tr>
                  <th class="px-3 py-2">{$t('Account')}</th>
                  <th class="px-3 py-2">{$t('Status')}</th>
                  <th class="px-3 py-2">{$t('Last 24 hours')}</th>
                </tr>
              </thead>
              <tbody>
                {#each pool.accounts as account (account.id)}
                  {@const usage = pool.usage.find((row) => row.account === account.id)}
                  <tr class="align-top">
                    <td
                      data-label={$t('Account')}
                      class="table-mode:w-72 table-mode:whitespace-normal"
                    >
                      <span class="break-all font-medium text-ink-body">{account.name}</span>
                    </td>
                    <td data-label={$t('Status')} class="table-mode:whitespace-normal">
                      <div class="flex flex-wrap items-center gap-1">
                        <span class={account.enabled ? 'badge-neutral' : 'badge-warning'}
                          >{account.enabled ? $t('Enabled') : $t('Paused')}</span
                        >
                        <span class={apiKeyStateBadge(account.state)}
                          >{apiKeyStateLabel(account.state)}</span
                        >
                      </div>
                      {#if account.nextRetryAt}<div
                          class="mt-1 text-xs tabular-nums text-ink-muted"
                        >
                          {$t('Retry at')}: {timestamp(account.nextRetryAt)}
                        </div>{/if}
                    </td>
                    <td data-label={$t('Last 24 hours')}>
                      {@render trafficCell(usage, false)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/each}
      {#if !snapshot.providers.some((provider) => provider.accounts.length) && !snapshot.apiKeyPools.some((pool) => pool.accounts.length)}<p
          class="empty-state"
        >
          {$t('No upstream accounts')}
        </p>{/if}
    {/if}
  </section>
{/if}
