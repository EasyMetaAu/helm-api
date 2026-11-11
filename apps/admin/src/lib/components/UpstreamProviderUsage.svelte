<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { UpstreamProviderUsage } from '@helm/shared';
  import { getUpstreamUsage } from '$lib/api/upstream-usage.js';
  import { accountDetailHref } from '$lib/oauth-account-id.js';
  import { formatCount, formatTokens, formatUsd, formatDurationMs } from '$lib/format';
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
  const timestamp = (ms: number | null | undefined) =>
    ms == null ? $t('Unknown') : new Date(ms).toLocaleString();
</script>

{#if result?.configured || error}
  <section class="flex flex-col gap-3" aria-labelledby="upstream-usage-title">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="upstream-usage-title" class="section-header">{$t('Upstream usage')}</h2>
        {#if result?.configured}<p class="text-sm text-ink-muted">{result.source}</p>{/if}
      </div>
      <button type="button" class="btn-secondary" disabled={busy} onclick={refresh}
        >{$t('Refresh upstream usage')}</button
      >
    </header>
    <p class="text-sm text-ink-muted">
      {$t(
        'Read-only. Subscription quotas cover the provider account; request and token totals cover traffic through the upstream Helm, not this instance.',
      )}
    </p>
    {#if error}<p role="alert" class="text-sm text-red-600">
        {$t('Upstream usage is unavailable. Any values below are from the last successful read.')}
      </p>{/if}
    {#if result?.configured}
      {@const snapshot = result.snapshot}
      <p class="text-xs text-ink-muted">
        {$t('Snapshot read at')}: {timestamp(snapshot.generatedAt)}
      </p>
      {#each snapshot.providers as provider (provider.id)}
        {#if provider.accounts.length > 0}
          <h3 class="font-semibold text-ink-strong">{provider.name}</h3>
          <div class="grid gap-3 lg:grid-cols-2">
            {#each provider.accounts as account (account.account)}
              {@const usage = snapshot.usage.find(
                (r) => r.providerId === provider.id && r.account === account.account,
              )}
              {@const quota = snapshot.quota.find(
                (r) => r.providerId === provider.id && r.account === account.account,
              )}
              <article class="rounded-xl border border-stroke p-4">
                <div class="flex flex-wrap justify-between gap-2">
                  <a
                    class="link-inline break-all font-medium"
                    href={`${accountDetailHref(base, provider.id, account.account)}?source=upstream`}
                    >{account.account}</a
                  >
                  <span class="text-sm"
                    >{quota?.planType ??
                      account.anthropicPlanType ??
                      account.chatgptPlanType ??
                      $t('Unknown')}</span
                  >
                </div>
                {#if account.email && account.email !== account.account}<p
                    class="text-xs text-ink-muted break-all"
                  >
                    {account.email}
                  </p>{/if}
                <p class="mt-1 text-sm text-ink-muted">
                  {account.healthy ? $t('Healthy') : $t('Needs attention')} · {account.schedulable
                    ? $t('Enabled')
                    : $t('Paused')}
                </p>
                <p class="mt-2 text-sm">
                  {$t('Today')}: {$t('{requests} requests · {tokens} tokens', {
                    requests: formatCount(usage?.requests ?? 0),
                    tokens: formatTokens(usage?.tokens ?? 0),
                  })} · {$t('Estimated cost')}: {formatUsd(usage?.costUsd)}
                </p>
                {#if usage}<p class="text-xs text-ink-muted">
                    {$t('Average RPM')}: {usage.rpm}
                  </p>{/if}
                {#if quota}
                  <p class="mt-2 text-xs text-ink-muted">
                    {$t('Quota captured at')}: {timestamp(
                      quota.capturedAt,
                    )}{#if now - quota.capturedAt > 300_000}
                      · {$t('Stale quota snapshot')}{/if}
                  </p>
                  {#each quota.windows as window (`${window.limitId ?? ''}/${window.key}`)}
                    <div class="mt-3">
                      <div class="flex justify-between gap-2 text-sm">
                        <span>{window.limitName ?? window.limitId ?? ''} {window.key}</span><span
                          >{window.usedPercent}%</span
                        >
                      </div>
                      <progress
                        class="mt-1 h-2 w-full accent-indigo-500"
                        max="100"
                        value={Math.min(100, window.usedPercent)}
                        aria-label={`${window.limitName ?? window.key} ${$t('Used')}`}
                      ></progress>
                      <p class="text-xs text-ink-muted">
                        {$t('Resets at')}: {timestamp(
                          window.resetsAtMs,
                        )}{#if window.resetsAtMs && window.resetsAtMs > now}
                          · {formatDurationMs(window.resetsAtMs - now)}{/if}
                      </p>
                    </div>
                  {/each}
                  {#if quota.windows.length === 0}<p class="mt-2 text-sm">
                      {$t('Quota unavailable')}
                    </p>{/if}
                  {#if quota.usageLimitedUntilMs && quota.usageLimitedUntilMs > now}<p
                      class="mt-2 text-sm"
                    >
                      {$t('Limited until')}: {timestamp(quota.usageLimitedUntilMs)}
                    </p>{/if}
                  {#if quota.credits}<p class="mt-2 text-sm">
                      {$t('Credits')}: {quota.credits.unlimited
                        ? $t('Unlimited')
                        : (quota.credits.balance ?? $t('Unknown'))}
                    </p>{/if}
                  {#if quota.individualLimit}
                    <p class="mt-2 text-sm">
                      {$t('Spend limit')}: {quota.individualLimit.used} / {quota.individualLimit
                        .limit} · {$t('Remaining')}: {quota.individualLimit.remainingPercent}% · {$t(
                        'Resets at',
                      )}: {timestamp(quota.individualLimit.resetsAtMs)}
                    </p>
                  {/if}
                  {#if quota.resetCredits != null}<p class="mt-2 text-sm">
                      {$t('Reset credits')}: {quota.resetCredits}
                    </p>{/if}
                  {#each quota.resetCreditDetails ?? [] as credit (credit.id)}
                    <p class="mt-1 text-xs text-ink-muted">
                      {credit.title ?? credit.resetType} · {credit.status} · {$t('Expires')}: {timestamp(
                        credit.expiresAt,
                      )}
                    </p>
                  {/each}
                  {#if quota.rateLimitReachedType}<p class="mt-2 text-sm">
                      {$t('Limit reached')}: {quota.rateLimitReachedType}
                    </p>{/if}
                {:else}
                  <p class="mt-2 text-sm text-ink-muted">{$t('Quota unavailable')}</p>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      {/each}
      {#each snapshot.apiKeyPools as pool (pool.id)}
        {#if pool.accounts.length > 0}
          <h3 class="font-semibold text-ink-strong">{pool.id} · {$t('API key accounts')}</h3>
          <p class="text-xs text-ink-muted">{$t('Last 24 hours')}</p>
          <div class="grid gap-3 lg:grid-cols-2">
            {#each pool.accounts as account (account.id)}
              {@const usage = pool.usage.find((row) => row.account === account.id)}
              <article class="rounded-xl border border-stroke p-4">
                <h4 class="font-medium break-all">{account.name}</h4>
                <p class="text-sm text-ink-muted">
                  {account.enabled ? $t('Enabled') : $t('Paused')} · {account.state}
                </p>
                <p class="mt-2 text-sm">
                  {$t('{requests} requests · {tokens} tokens', {
                    requests: formatCount(usage?.requests ?? 0),
                    tokens: formatTokens(usage?.tokens ?? 0),
                  })} · {$t('Estimated cost')}: {formatUsd(usage?.costUsd)}
                </p>
                {#if account.nextRetryAt}<p class="text-xs text-ink-muted">
                    {$t('Retry at')}: {timestamp(account.nextRetryAt)}
                  </p>{/if}
              </article>
            {/each}
          </div>
        {/if}
      {/each}
      {#if !snapshot.providers.some((provider) => provider.accounts.length) && !snapshot.apiKeyPools.some((pool) => pool.accounts.length)}<p
          class="text-sm text-ink-muted"
        >
          {$t('No upstream accounts')}
        </p>{/if}
    {/if}
  </section>
{/if}
