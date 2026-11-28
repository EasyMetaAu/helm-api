<script lang="ts">
  import UpstreamProviderUsage from '$lib/components/UpstreamProviderUsage.svelte';
  import ManagedProviders from '$lib/components/ManagedProviders.svelte';
  let providerEditor = $state<ReturnType<typeof ManagedProviders>>();
  let keyManager = $state<ReturnType<typeof ApiKeyPools>>();
  let connections = $state<ManagedProviderView[]>([]);
  let keyPools = $state<ApiKeyPoolView[]>([]);
  let upstreamUsageVisible = $state(false);
  import ApiKeyPools from '$lib/components/ApiKeyPools.svelte';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { goto, invalidateAll, replaceState } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import {
    type AccountKind,
    type AccountListRow,
    type ProviderListFilters,
    type SortKey,
    filterAndSortRows,
    mostConstrainedWindow,
    parseProviderListFilters,
    providerListFiltersToSearch,
  } from './account-list';
  import { accountDetailHref } from '$lib/oauth-account-id.js';
  import {
    type ManagedProviderView,
    type ApiKeyPoolView,
    type ApiKeyAccountView,
    isCodexQuotaWindowPlaceholder,
    selectCodexAccountWeeklyQuotaWindows,
    usableAnthropicResetGrant,
    type AnthropicResetGrant,
    type AnthropicResetStatus,
  } from '@helm/shared';
  import {
    consumeCodexResetCredit,
    consumeAnthropicReset,
    getAnthropicResetStatus,
    getOAuthOverview,
    logoutOAuth,
    requestOAuthRefresh,
    resetUsageLimit,
    setAccountSchedule,
    setSelectionStrategy,
    type OAuthAccount,
    type OAuthAdminRefreshStatus,
    type OAuthOverview,
    type OAuthProviderStatus,
    type OAuthQuotaSnapshot,
    type OAuthQuotaWindow,
    type OAuthSelectionStrategy,
    type OAuthUsageRow,
  } from '$lib/api/oauth.js';
  import ConnectProviderDialog from '$lib/components/ConnectProviderDialog.svelte';
  import ManageAccountDialog from '$lib/components/ManageAccountDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import Switch from '$lib/components/Switch.svelte';
  import RefreshControl from '$lib/components/RefreshControl.svelte';
  import TestAccountDialog from '$lib/components/TestAccountDialog.svelte';
  import {
    durationParts,
    formatCount,
    formatDurationMs,
    formatTokens,
    formatUsd,
  } from '$lib/format';
  import { t } from '$lib/i18n';
  import { tooltip } from '$lib/tooltip';

  // Subscription OAuth login (issue #38). Pure consumer (Principle 1): the gateway
  // owns the flow + encrypted token storage; this page lists connected accounts and
  // now their day-to-day operating signals — today's usage, remaining quota windows,
  // pool priority + schedulable — with inline edits for the routing knobs. Usage and
  // quota are fail-open observability (absent ⇒ rendered as "—"), so a flaky stats
  // endpoint never breaks the page.
  let {
    data,
  }: {
    data: OAuthOverview & { loadError?: string };
  } = $props();

  let overview = $state<OAuthOverview & { loadError?: string }>(untrack(() => ({ ...data })));
  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let showConnect = $state<boolean>(false);
  let reconnecting = $state<{ providerId: string; account: string } | null>(null);
  let managing = $state<{ providerId: string; providerName: string; account: string } | null>(null);
  // The account whose connectivity-test dialog is open (providers page "Test"
  // button). Carries the row's chat models; media creates are paid, non-streaming
  // operations and must never be triggered by this short-message test.
  let testing = $state<{
    providerId: string;
    providerName: string;
    account: string;
    models: string[];
  } | null>(null);
  let confirming = $state<{ providerId: string; account: string } | null>(null);
  let disconnecting = $state<boolean>(false);
  // One global account-pool strategy applies across every subscription provider pool.
  // Account priority/schedulable remain per-account controls below.
  let savingStrategy = $state<boolean>(false);
  // Codex accounts whose local retry click is in flight (keyed provider/account) —
  // clears Helm's local auto-park cooldown (#291). Upstream 5h/7d windows are provider
  // subscription limits and are not operator-resettable.
  let resetting = $state<Record<string, boolean>>({});
  // The Codex account whose "Reset limit" consume is awaiting confirmation. A reset
  // spends a scarce, irreversible credit AND restores the WHOLE upstream ChatGPT
  // account (the grant is keyed by chatgpt_account_id, not the helm label), so it must
  // be confirmed — never fire on a single click. `credits` is the available count shown
  // in the dialog. Only one reset dialog is open at a time (mirrors `confirming`).
  // `autoReset` is the account's current opt-in (pre-filled), editable via the dialog's
  // checkbox so the operator can turn on future auto-reset right as they reset manually.
  let confirmingReset = $state<{
    providerId: string;
    account: string;
    credits: number;
    autoReset: boolean;
    creditId?: string;
    creditTitle?: string;
    idempotencyKey: string;
  } | null>(null);
  let confirmingAnthropicReset = $state<{
    account: string;
    status: AnthropicResetStatus;
    grant: AnthropicResetGrant;
  } | null>(null);
  // Cached read-only Claude grant status keeps the reset action informative without
  // changing the consume boundary: the POST still only runs from the confirmation modal.
  let anthropicResetStatusByAccount = $state<Record<string, AnthropicResetStatus>>({});
  const anthropicResetRequests = new Set<string>();
  // True while the confirmed consume is in flight (disables the dialog's buttons).
  let resettingLimit = $state<boolean>(false);
  // Transient success line after a credit reset (e.g. "Reset 2 window(s)"); cleared on
  // the next action. Errors continue to use the shared `error` banner.
  let resetNotice = $state<string | null>(null);

  // Keep mutation-triggered SvelteKit invalidations compatible with the local
  // cache snapshot used by manual/automatic refreshes.
  $effect(() => {
    overview = { ...data };
    if (data.loadError) error = data.loadError;
    untrack(scheduleProviderRevalidation);
  });

  const keyOf = (providerId: string, account: string): string => `${providerId}/${account}`;
  const ACTIVE_LIMIT_RECOVERY_THRESHOLD = 95;

  $effect(() => {
    const anthropicAccounts = overview.providers
      .filter((provider) => provider.id === 'anthropic')
      .flatMap((provider) => provider.accounts.map((account) => account.account));
    untrack(() => {
      for (const account of anthropicAccounts) {
        const key = keyOf('anthropic', account);
        if (anthropicResetRequests.has(key)) continue;
        anthropicResetRequests.add(key);
        void Promise.resolve()
          .then(() => getAnthropicResetStatus(account))
          .then((status) => {
            if (status) anthropicResetStatusByAccount[key] = status;
          })
          .catch(() => {
            anthropicResetRequests.delete(key);
          });
      }
    });
  });
  const CODEX_RESET_MIN_WEEKLY_USED_PERCENT = 90;
  const strategyOptions: Array<{
    value: OAuthSelectionStrategy;
    label: string;
    description: string;
  }> = [
    {
      value: 'balanced',
      label: 'Balanced',
      description: 'Spread new sessions across accounts while keeping sessions sticky.',
    },
    {
      value: 'manual_priority',
      label: 'Manual priority',
      description:
        'New requests are assigned at random by priority. Lower numbers receive more traffic. Existing sessions keep their available account.',
    },
    {
      value: 'low_risk',
      label: 'Low risk',
      description: 'Prefer accounts with lower quota pressure to reduce 429 risk.',
    },
    {
      value: 'use_expiring',
      label: 'Avoid waste',
      description:
        'New requests are assigned at random by expiring quota. More unused quota and an earlier reset increase the odds. Codex reset credits also count.',
    },
    {
      value: 'fastest',
      label: 'Speed first',
      description:
        'Use recent streamed response speed within the same model and priority; keep account and quota limits.',
    },
  ];

  // One table row per connected account, flattened across providers, joined to its
  // usage + quota snapshot (both fail-open: a missing entry renders "—").
  let usageByKey = $derived(
    new Map(overview.usage.map((u) => [keyOf(u.providerId, u.account), u])),
  );
  let quotaByKey = $derived(
    new Map(overview.quota.map((q) => [keyOf(q.providerId, q.account), q])),
  );
  let rows = $derived(
    overview.providers.flatMap((p) => p.accounts.map((account) => ({ provider: p, account }))),
  );

  function providerName(id: string): string {
    return overview.providers.find((p) => p.id === id)?.name ?? id;
  }

  function anthropicResetGrant(account: string): AnthropicResetGrant | null {
    const status = anthropicResetStatusByAccount[keyOf('anthropic', account)];
    if (!status) return null;
    return (
      status.grants.find((grant) => grant.id === status.next_grant_id && grant.resets_left > 0) ??
      status.grants.find((grant) => grant.resets_left > 0) ??
      null
    );
  }

  function anthropicResetButtonMeta(account: string): string {
    const grant = anthropicResetGrant(account);
    if (!grant) return '';
    return `${$t('{n} resets remaining', { n: grant.resets_left })} · ${$t('Expires')}: ${new Date(grant.ends_at).toLocaleDateString()}`;
  }

  function mediaBadge(model: string): 'Image' | 'Video' | null {
    if (model === 'grok-imagine-image' || model === 'grok-imagine-image-quality') return 'Image';
    if (model === 'grok-imagine-video-1.5-preview' || model === 'grok-imagine-video') {
      return 'Video';
    }
    return null;
  }

  function planLabel(plan: string): string {
    return plan
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
      .join(' ');
  }

  // Fuller proxy detail for the hover tooltip — adds the auth shape (username +
  // whether a password is set) WITHOUT the secret itself.
  function proxyTitle(p: OAuthAccount['proxy']): string {
    if (!p) return '';
    const auth = p.username
      ? ` · ${p.username}${p.hasPassword ? ':••••' : ''}`
      : p.hasPassword
        ? ' · ••••'
        : '';
    return `${p.type}://${p.host}:${p.port}${auth}`;
  }

  // The access token is short-lived and auto-renewed by the gateway, so a lapsed one
  // is NOT an alarm — show "auto-renews"; when valid, the remaining time hints at the
  // next renewal. Coarsening (incl. the ">24h ⇒ days" rule) lives in `durationParts`
  // so this label agrees with the quota-reset countdown below.
  function expiryLabel(a: OAuthAccount): string {
    if (a.expiresAt == null) return $t('auto-renews');
    const ms = a.expiresAt - Date.now();
    if (ms <= 0) return $t('auto-renews');
    const p = durationParts(ms);
    if (p.unit === 'dh') return $t('in {d}d {h}h', { d: p.d, h: p.h });
    if (p.unit === 'hm') return $t('in {h}h {m}m', { h: p.h, m: p.m });
    return $t('in {m}m', { m: p.m });
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

  // Friendly window labels (provider-specific keys → display).
  function durationWindowLabel(windowMinutes: number | null): string | null {
    if (windowMinutes == null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
    if (windowMinutes === 300) return '5h';
    if (windowMinutes === 10_080) return $t('Weekly');
    if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
  }

  function windowLabel(key: string, windowMinutes: number | null = null): string {
    // Codex plan shapes are not stable: some accounts now expose their weekly
    // allowance as `primary` instead of `secondary`. The duration is authoritative;
    // the primary/secondary key is only a neutral fallback when duration is absent.
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
    const base = windowLabel(window.key, window.windowMinutes);
    const scope =
      window.limitName?.trim() ||
      (window.limitId && window.limitId !== 'codex' ? titleFromSlug(window.limitId) : null);
    return scope ? `${scope} · ${base}` : base;
  }

  // Color ramp mirrors claude-relay: calm under 75%, warning to 90%, danger beyond.
  function barColor(pct: number): string {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 75) return 'bg-amber-500';
    return 'bg-indigo-500';
  }

  function isAccountWideQuotaWindow(w: OAuthQuotaWindow): boolean {
    if (w.limitId !== undefined && w.limitId !== 'codex') return false;
    return !w.key.startsWith('7d-');
  }

  // "resets in 4d 16h" countdown from an absolute reset timestamp; null/elapsed ⇒ "".
  // Shares `durationParts` with `expiryLabel` so the coarsening (a 7-day window reads
  // "4d 16h", not "112h 2m") stays identical across every duration label.
  function resetIn(ms: number | null): string {
    if (ms == null) return '';
    const left = ms - Date.now();
    if (left <= 0) return '';
    const p = durationParts(left);
    if (p.unit === 'dh') return $t('resets in {d}d {h}h', { d: p.d, h: p.h });
    if (p.unit === 'hm') return $t('resets in {h}h {m}m', { h: p.h, m: p.m });
    return $t('resets in {m}m', { m: p.m });
  }

  function activeRecoveryWindow(
    windows: OAuthQuotaWindow[],
    now: number,
    threshold: number,
  ): OAuthQuotaWindow | null {
    let chosen: OAuthQuotaWindow | null = null;
    for (const w of windows) {
      if (!isAccountWideQuotaWindow(w)) continue;
      if (w.usedPercent < threshold || w.resetsAtMs == null || w.resetsAtMs <= now) {
        continue;
      }
      if (chosen == null || w.resetsAtMs < (chosen.resetsAtMs ?? Number.POSITIVE_INFINITY)) {
        chosen = w;
      }
    }
    return chosen;
  }

  type UsageLimitStatus = {
    untilMs: number;
    label: string | null;
    retryable: boolean;
  };

  // Is this account auto-parked by a usage limit right now? Prefer the nearest
  // near-full quota window over the short generic 429 fallback, so an upstream 5h
  // limit reported as 98-99% still shows the real reset instead of "0m". The row
  // action is retryable only when no active upstream quota window explains the park.
  function usageLimitStatus(
    q: OAuthQuotaSnapshot | undefined,
    allowLocalRetry = false,
  ): UsageLimitStatus | null {
    const now = Date.now();
    let untilMs =
      q?.usageLimitedUntilMs != null && q.usageLimitedUntilMs > now ? q.usageLimitedUntilMs : null;
    let label: string | null = null;
    const recoveryWindow = activeRecoveryWindow(
      q?.windows ?? [],
      now,
      untilMs == null ? 100 : ACTIVE_LIMIT_RECOVERY_THRESHOLD,
    );
    if (recoveryWindow?.resetsAtMs != null) {
      untilMs = recoveryWindow.resetsAtMs;
      label = quotaWindowLabel(recoveryWindow);
      return { untilMs, label, retryable: false };
    }
    if (untilMs != null && !allowLocalRetry && q?.windows.some(isAccountWideQuotaWindow)) {
      return null;
    }
    return untilMs == null ? null : { untilMs, label, retryable: allowLocalRetry };
  }

  function codexWeeklyUsedPercent(q: OAuthQuotaSnapshot | undefined): number | null {
    const weekly = selectCodexAccountWeeklyQuotaWindows(q?.windows ?? [])
      .map((w) => w.usedPercent)
      .filter((pct) => Number.isFinite(pct));
    return weekly && weekly.length > 0 ? Math.max(...weekly) : null;
  }

  function canUseCodexResetCredit(
    q: OAuthQuotaSnapshot | undefined,
    credits: number | null,
  ): boolean {
    return (
      credits != null &&
      credits > 0 &&
      (q?.rateLimitReachedType == null || q.rateLimitReachedType === 'rate_limit_reached') &&
      (codexWeeklyUsedPercent(q) ?? -1) >= CODEX_RESET_MIN_WEEKLY_USED_PERCENT
    );
  }

  function resetCreditTitle(q: OAuthQuotaSnapshot | undefined, credits: number | null): string {
    const weekly = codexWeeklyUsedPercent(q);
    if (credits == null) return $t('Reset-credit count unavailable');
    if (credits <= 0) return $t('No reset credits available');
    if (q?.rateLimitReachedType != null && q.rateLimitReachedType !== 'rate_limit_reached') {
      return $t('This limit cannot be restored with a Codex reset credit');
    }
    if (weekly == null) return $t('Weekly quota snapshot unavailable');
    if (weekly < CODEX_RESET_MIN_WEEKLY_USED_PERCENT) {
      return $t('Weekly usage must reach 90% before reset credits can be used');
    }
    return $t('Consume one credit to restore the rate-limit window');
  }

  function rateLimitReachedLabel(type: OAuthQuotaSnapshot['rateLimitReachedType']): string | null {
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
        return null;
    }
  }

  function resetRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `reset-${Date.now().toString(36)}`;
  }

  function individualLimitUsedPercent(q: OAuthQuotaSnapshot | undefined): number | null {
    const remaining = q?.individualLimit?.remainingPercent;
    return typeof remaining === 'number' && Number.isFinite(remaining)
      ? Math.min(100, Math.max(0, 100 - remaining))
      : null;
  }

  function formatCreditAmount(value: string): string {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : value;
  }

  function formatCreditBalance(value: string | null): string | null {
    if (value == null) return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return value;
    return number === 0 ? null : number.toFixed(2);
  }

  function isRetiredCodexLimit(
    limitId: string | undefined,
    limitName: string | null | undefined,
  ): boolean {
    if (limitId?.trim().toLowerCase() === 'codex_spark') return true;
    const normalizedName = limitName?.trim().toLowerCase().replaceAll('_', '-');
    return normalizedName?.endsWith('-codex-spark') === true;
  }

  function activeCodexQuota(quota: OAuthQuotaSnapshot | undefined): OAuthQuotaSnapshot | undefined {
    if (!quota) return undefined;
    return {
      ...quota,
      windows: quota.windows.filter(
        (window) =>
          !isRetiredCodexLimit(window.limitId, window.limitName) &&
          !isCodexQuotaWindowPlaceholder(window, quota.capturedAt),
      ),
      additionalLimits: quota.additionalLimits?.filter(
        (limit) => !isRetiredCodexLimit(limit.limitId, limit.limitName),
      ),
    };
  }

  function additionalLimitNames(q: OAuthQuotaSnapshot | undefined): string[] {
    if (!q?.additionalLimits?.length) return [];
    const representedIds = new Set(q.windows.map((window) => window.limitId).filter(Boolean));
    const representedNames = new Set(
      q.windows.map((window) => window.limitName?.trim()).filter(Boolean),
    );
    return [
      ...new Set(
        q.additionalLimits
          .filter(
            (limit) =>
              !representedIds.has(limit.limitId) &&
              !(limit.limitName && representedNames.has(limit.limitName.trim())),
          )
          .map((limit) => limit.limitName?.trim() || titleFromSlug(limit.limitId))
          .filter(Boolean),
      ),
    ];
  }

  // Countdown to auto-recovery for the rate-limited pill — same `durationParts`
  // coarsening as resetIn so a long cooldown reads "auto-recovers in 4d 16h".
  function autoRecoverIn(ms: number | null): string {
    if (ms == null) return '';
    const left = ms - Date.now();
    if (left <= 0) return '';
    const p = durationParts(left);
    if (p.unit === 'dh') return $t('auto-recovers in {d}d {h}h', { d: p.d, h: p.h });
    if (p.unit === 'hm') return $t('auto-recovers in {h}h {m}m', { h: p.h, m: p.m });
    return $t('auto-recovers in {m}m', { m: p.m });
  }

  function onConnected(): void {
    showConnect = false;
    reconnecting = null;
    void invalidateAll();
  }

  const REFRESH_POLL_MS = 750;
  const REFRESH_POLL_LIMIT = 160;
  const PROVIDER_REFRESH_TTL_MS = 60 * 60_000;
  const QUOTA_PROVIDER_IDS = new Set(['anthropic', 'openai-codex', 'xai']);
  let destroyed = false;
  let mounted = false;
  let pollGeneration = 0;
  let providerRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProviderRefreshAttemptAt: number | null = null;

  function clearProviderRevalidationTimer(): void {
    if (providerRevalidationTimer !== null) {
      clearTimeout(providerRevalidationTimer);
      providerRevalidationTimer = null;
    }
  }

  function oldestQuotaCapture(): number | null {
    const snapshots = new Map(
      overview.quota.map((snapshot) => [keyOf(snapshot.providerId, snapshot.account), snapshot]),
    );
    let oldest: number | null = null;
    for (const provider of overview.providers) {
      if (!QUOTA_PROVIDER_IDS.has(provider.id)) continue;
      for (const account of provider.accounts) {
        const capturedAt = snapshots.get(keyOf(provider.id, account.account))?.capturedAt ?? 0;
        oldest = oldest === null ? capturedAt : Math.min(oldest, capturedAt);
      }
    }
    return oldest;
  }

  function scheduleProviderRevalidation(): void {
    if (!mounted || destroyed) return;
    clearProviderRevalidationTimer();
    const capturedAt = oldestQuotaCapture();
    if (capturedAt === null) return;
    const staleAt = capturedAt + PROVIDER_REFRESH_TTL_MS;
    const retryAt = (lastProviderRefreshAttemptAt ?? 0) + PROVIDER_REFRESH_TTL_MS;
    const delayMs = Math.max(0, Math.max(staleAt, retryAt) - Date.now());
    providerRevalidationTimer = setTimeout(() => {
      providerRevalidationTimer = null;
      void revalidateStaleProviders();
    }, delayMs);
  }

  async function revalidateStaleProviders(): Promise<void> {
    if (destroyed) return;
    if (document.visibilityState === 'hidden') return;
    const capturedAt = oldestQuotaCapture();
    if (capturedAt === null || Date.now() - capturedAt < PROVIDER_REFRESH_TTL_MS) {
      scheduleProviderRevalidation();
      return;
    }
    await refresh();
    scheduleProviderRevalidation();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState !== 'hidden') scheduleProviderRevalidation();
  }

  onMount(() => {
    mounted = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleProviderRevalidation();
  });

  onDestroy(() => {
    destroyed = true;
    pollGeneration += 1;
    clearProviderRevalidationTimer();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  function refreshActive(status: OAuthAdminRefreshStatus): boolean {
    return status.state === 'queued' || status.state === 'running';
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function refreshCachedOverview(): Promise<OAuthOverview | null> {
    try {
      const next = await getOAuthOverview();
      if (!destroyed) {
        overview = next;
        error = null;
        scheduleProviderRevalidation();
      }
      return next;
    } catch (e) {
      if (!destroyed) {
        error = e instanceof Error ? e.message : $t('Failed to load OAuth providers');
      }
      return null;
    }
  }

  // Poll only the cache-only overview after a job is accepted. One poller per page
  // is enough; the gateway independently coalesces clicks across tabs/requests.
  async function pollRefresh(jobId: string | null): Promise<void> {
    const generation = ++pollGeneration;
    for (let attempt = 0; attempt < REFRESH_POLL_LIMIT; attempt += 1) {
      await wait(REFRESH_POLL_MS);
      if (destroyed || generation !== pollGeneration) return;
      const next = await refreshCachedOverview();
      if (!next) return;
      if (!refreshActive(next.refresh)) return;
      if (jobId !== null && next.refresh.jobId !== jobId) return;
    }
  }

  // Explicit click enqueues upstream work and returns immediately. The latest cache
  // is rendered at once, then cache-only polling picks up the completed snapshot.
  async function refresh(): Promise<void> {
    error = null;
    lastProviderRefreshAttemptAt = Date.now();
    try {
      const queued = await requestOAuthRefresh();
      overview = { ...overview, refresh: queued.status };
      const next = await refreshCachedOverview();
      if (next && refreshActive(next.refresh)) void pollRefresh(next.refresh.jobId);
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to refresh providers');
    }
  }

  // Timer ticks are intentionally cache-only. They can observe a job started by
  // another admin tab, but they never create provider traffic themselves.
  async function autoRefresh(): Promise<void> {
    await refreshCachedOverview();
  }

  function refreshStatusLabel(status: OAuthAdminRefreshStatus): string | null {
    if (status.state === 'queued') return $t('Provider refresh queued');
    if (status.state === 'running') return $t('Refreshing provider data…');
    if (status.state === 'failed') {
      return status.error
        ? $t('Provider refresh failed: {error}', { error: status.error })
        : $t('Provider refresh failed');
    }
    if (status.state === 'succeeded' || status.lastSuccessAt !== null) {
      const refreshedAt = status.lastSuccessAt ?? status.finishedAt;
      const time = refreshedAt === null ? null : new Date(refreshedAt).toLocaleTimeString();
      const remainingMs = status.nextAllowedAt === null ? 0 : status.nextAllowedAt - Date.now();
      const cooldownMs = remainingMs > 0 ? remainingMs : null;
      const refreshed = time
        ? $t('Provider data refreshed at {time}', { time })
        : $t('Provider data refreshed');
      return cooldownMs === null
        ? refreshed
        : `${refreshed} · ${$t('refresh available again in {duration}', {
            duration: formatDurationMs(cooldownMs),
          })}`;
    }
    return null;
  }

  function onManaged(): void {
    managing = null;
    void invalidateAll();
  }

  // List-level edits: priority and the per-account switches save straight from the
  // row through the same PUT the Manage dialog uses; the route hot-rebuilds the pool,
  // so the page reloads its data afterwards. Errors land in the shared banner.
  let savingSchedule = $state<Record<string, boolean>>({});

  async function updateSchedule(
    providerId: string,
    account: string,
    patch: Parameters<typeof setAccountSchedule>[2],
  ): Promise<void> {
    const k = keyOf(providerId, account);
    savingSchedule = { ...savingSchedule, [k]: true };
    error = null;
    try {
      await setAccountSchedule(providerId, account, patch);
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update scheduling');
    } finally {
      savingSchedule = { ...savingSchedule, [k]: false };
    }
  }

  // Priority is a non-negative integer on both account types (API keys cap at 1000).
  // `Number`, not parseInt, so "1.9" is refused instead of silently truncated.
  function parsePriority(raw: string, max: number): number | null {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(value) || value < 0 || value > max) {
      error =
        max === Number.MAX_SAFE_INTEGER
          ? $t('Priority must be a non-negative integer')
          : $t('Priority must be a whole number from 0 to {max}', { max });
      return null;
    }
    return value;
  }

  function saveOAuthPriority(providerId: string, account: string, raw: string): void {
    const priority = parsePriority(raw, Number.MAX_SAFE_INTEGER);
    if (priority !== null) void updateSchedule(providerId, account, { priority });
  }

  function saveKeyPriority(pool: string, account: ApiKeyAccountView, raw: string): void {
    const priority = parsePriority(raw, 1000);
    if (priority !== null) keyManager?.setPriority(pool, account, priority);
  }

  async function saveSelectionStrategy(selectionStrategy: OAuthSelectionStrategy): Promise<void> {
    savingStrategy = true;
    error = null;
    try {
      await setSelectionStrategy(selectionStrategy);
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update strategy');
    } finally {
      savingStrategy = false;
    }
  }

  // "Retry account": clear Helm's local auto-park cooldown so the account rejoins the
  // pool on the next request. Cooldown-only — upstream quota windows and the operator's
  // schedulable park are untouched. On success invalidateAll re-reads the snapshot.
  async function retryAccount(providerId: string, account: string): Promise<void> {
    const k = keyOf(providerId, account);
    resetting = { ...resetting, [k]: true };
    error = null;
    try {
      await resetUsageLimit(providerId, account);
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to retry account');
    } finally {
      resetting = { ...resetting, [k]: false };
    }
  }

  // "Reset limit" (Codex only): consume one rate-limit reset credit to restore the
  // account's windows, AFTER explicit confirmation (`confirmingReset` is set by the
  // row button; this runs from the dialog's confirm). FAIL-CLOSED on the server, so a
  // rejection means the reset did NOT happen — surface it via `error`. On success,
  // refresh so the quota bars + the remaining-credit count reflect the consumed credit.
  async function confirmResetLimit(): Promise<void> {
    if (!confirmingReset) return;
    const { providerId, account, autoReset, creditId, idempotencyKey } = confirmingReset;
    resettingLimit = true;
    error = null;
    resetNotice = null;
    try {
      const quota = quotaByKey.get(keyOf(providerId, account));
      if (!canUseCodexResetCredit(quota, confirmingReset.credits)) {
        error = $t('Reset limit requires weekly usage of at least 90%');
        return;
      }
      const result = await consumeCodexResetCredit(providerId, account, {
        ...(creditId === undefined ? {} : { creditId }),
        idempotencyKey,
      });
      if (result.outcome === 'nothingToReset') {
        error = $t('No rate-limit window needed resetting');
        return;
      }
      if (result.outcome === 'noCredit') {
        error = $t('No reset credits available');
        confirmingReset = null;
        await invalidateAll();
        return;
      }
      if (result.outcome !== 'reset' && result.outcome !== 'alreadyRedeemed') {
        error = $t('Unexpected reset-credit outcome');
        return;
      }
      // Persist the auto-reset opt-in only after the scarce reset-credit consume
      // succeeds. A failed manual reset must not silently enable future auto-spends.
      try {
        await setAccountSchedule(providerId, account, { autoReset });
      } catch {
        /* non-fatal: the manual reset is the primary action */
      }
      confirmingReset = null;
      await invalidateAll();
      resetNotice =
        result.outcome === 'alreadyRedeemed'
          ? $t('Reset completed successfully')
          : result.windowsReset != null
            ? $t('Reset {n} window(s)', { n: result.windowsReset })
            : $t('Reset limit consumed');
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to reset limit');
    } finally {
      resettingLimit = false;
    }
  }

  async function prepareAnthropicReset(account: string): Promise<void> {
    try {
      const status = await getAnthropicResetStatus(account);
      anthropicResetStatusByAccount[keyOf('anthropic', account)] = status;
      const grant = usableAnthropicResetGrant(status, Date.now());
      if (!grant)
        throw new Error(
          status.pending
            ? $t('A previous Claude reset is still unconfirmed')
            : $t('No Claude reset is currently available'),
        );
      confirmingAnthropicReset = { account, status, grant };
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to read Claude reset status');
    }
  }
  async function confirmAnthropicReset(): Promise<void> {
    if (!confirmingAnthropicReset) return;
    resettingLimit = true;
    error = null;
    try {
      const { account, grant } = confirmingAnthropicReset;
      const result = await consumeAnthropicReset({
        account,
        grantId: grant.id,
        expectedResetsLeft: grant.resets_left,
      });
      confirmingAnthropicReset = null;
      if (result.status) anthropicResetStatusByAccount[keyOf('anthropic', account)] = result.status;
      if (result.result === 'unknown')
        throw new Error($t('Claude reset outcome is unconfirmed; refresh usage before retrying'));
      await invalidateAll();
      resetNotice =
        result.result === 'reset' ? $t('Claude usage reset') : $t('Claude reset was not applied');
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to reset Claude usage');
    } finally {
      resettingLimit = false;
    }
  }

  async function confirmDisconnect(): Promise<void> {
    if (!confirming) return;
    error = null;
    disconnecting = true;
    try {
      await logoutOAuth(confirming.providerId, confirming.account);
      confirming = null;
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to disconnect');
    } finally {
      disconnecting = false;
    }
  }
  // ── One list for every account ───────────────────────────────────────────────
  // Subscription logins, API key accounts and key-free connections become the same
  // row shape (see ./account-list), so the list shows the same columns and actions
  // for all of them. Search, filters and sort live in the URL.
  let filters = $state<ProviderListFilters>(
    untrack(() => parseProviderListFilters($page.url.searchParams)),
  );

  function setFilters(next: Partial<ProviderListFilters>): void {
    filters = { ...filters, ...next };
    const qs = providerListFiltersToSearch(filters);
    replaceState(qs ? `?${qs}` : $page.url.pathname, {});
  }

  // Back/forward restore the filters the URL carries.
  $effect(() => {
    const fromUrl = parseProviderListFilters($page.url.searchParams);
    untrack(() => {
      if (providerListFiltersToSearch(fromUrl) !== providerListFiltersToSearch(filters)) {
        filters = fromUrl;
      }
    });
  });

  function sortBy(key: SortKey): void {
    if (filters.sort === key) setFilters({ dir: filters.dir === 'asc' ? 'desc' : 'asc' });
    else setFilters({ sort: key, dir: key === 'name' || key === 'priority' ? 'asc' : 'desc' });
  }

  type Tone = 'ok' | 'warning' | 'error' | 'neutral';
  type QuotaSummary = {
    remaining: number;
    used: number;
    label: string;
    resetText: string;
  };
  type ListRow = AccountListRow & {
    accountLabel: string;
    /** Secondary facts kept out of the list, shown on hover over the account. */
    accountTitle: string;
    providerLabel: string;
    typeLabel: string;
    status: { tone: Tone; label: string; detail: string; title: string } | null;
    quota: QuotaSummary | null;
    /** Every quota window, each with its own bar. */
    windows: Array<{ key: string; label: string; used: number; resetText: string }>;
    /** Every balance-like fact the provider reports (credits, resets, limits). */
    balances: Array<{ label: string; value: string; testid?: string }>;
    costUsd: number | null | undefined;
    rpm: number | null;
    usagePeriod: 'today' | 'day';
    proxy: { label: string; title: string } | null;
    href: string | null;
    open: (() => void) | null;
    oauth?: { provider: OAuthProviderStatus; account: OAuthAccount };
    key?: (typeof keyEntries)[number];
    connection?: ManagedProviderView;
  };

  const toneClass: Record<Tone, string> = {
    ok: 'badge-ok',
    warning: 'badge-warning',
    error: 'badge-error',
    neutral: 'badge-neutral',
  };

  const PLAN_LABELS: Record<string, string> = {
    pro: 'Pro',
    max: 'Max',
    team: 'Team',
    enterprise: 'Enterprise',
  };

  function subscriptionPlan(p: OAuthProviderStatus, account: OAuthAccount): string | null {
    if (p.id === 'anthropic') {
      return account.anthropicPlanType ? (PLAN_LABELS[account.anthropicPlanType] ?? null) : null;
    }
    if (p.id === 'openai-codex') {
      const plan =
        quotaByKey.get(keyOf(p.id, account.account))?.planType ?? account.chatgptPlanType;
      return plan ? planLabel(plan) : null;
    }
    return null;
  }

  function quotaSummary(q: OAuthQuotaSnapshot | undefined): QuotaSummary | null {
    const windows = q?.windows ?? [];
    const worst = mostConstrainedWindow(windows);
    if (worst) {
      const used = Math.min(100, Math.max(0, worst.usedPercent));
      return {
        used,
        remaining: Math.round(100 - used),
        label: quotaWindowLabel(worst),
        resetText: resetIn(worst.resetsAtMs),
      };
    }
    const individual = individualLimitUsedPercent(q);
    if (individual != null && q?.individualLimit) {
      return {
        used: individual,
        remaining: Math.round(100 - individual),
        label: $t('Monthly credit limit'),
        resetText: resetIn(q.individualLimit.resetsAtMs),
      };
    }
    return null;
  }

  function balancesFor(
    provider: OAuthProviderStatus,
    account: OAuthAccount,
    q: OAuthQuotaSnapshot | undefined,
  ): ListRow['balances'] {
    const out: ListRow['balances'] = [];
    if (q?.individualLimit) {
      out.push({
        label: $t('Monthly credit limit'),
        value: $t('{used} of {limit} credits used', {
          used: formatCreditAmount(q.individualLimit.used),
          limit: formatCreditAmount(q.individualLimit.limit),
        }),
        testid: 'codex-individual-limit',
      });
    }
    if (q?.credits?.unlimited) out.push({ label: $t('Credits'), value: $t('Unlimited') });
    else if (q?.credits) {
      const n = Number(q.credits.balance);
      out.push({
        label: $t('Credits'),
        value:
          q.credits.balance == null ? '—' : Number.isFinite(n) ? n.toFixed(2) : q.credits.balance,
      });
    }
    if (q?.resetCredits != null) {
      out.push({ label: $t('Reset credits'), value: String(q.resetCredits) });
    }
    if (provider.id === 'anthropic') {
      const grant = anthropicResetGrant(account.account);
      if (grant) {
        out.push({
          label: $t('Claude resets'),
          value: `${grant.resets_left} · ${$t('Expires')} ${new Date(grant.ends_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`,
        });
      }
    }
    const extra = additionalLimitNames(q);
    if (extra.length > 0) out.push({ label: $t('Additional limits'), value: extra.join(', ') });
    const reached = rateLimitReachedLabel(q?.rateLimitReachedType);
    if (reached) out.push({ label: $t('Limit'), value: reached });
    return out;
  }

  function oauthStatus(
    account: OAuthAccount,
    limit: UsageLimitStatus | null,
  ): {
    tone: Tone;
    label: string;
    detail: string;
    title: string;
    group: AccountListRow['statusGroup'];
  } {
    if (!account.healthy) {
      return {
        tone: 'error',
        label: $t('Needs sign-in'),
        detail: '',
        title: '',
        group: 'attention',
      };
    }
    if (limit) {
      const recovery = autoRecoverIn(limit.untilMs);
      return {
        tone: account.allowSpendRemainingCredits ? 'warning' : 'error',
        label: account.allowSpendRemainingCredits
          ? $t('Limited · using credits')
          : $t('Rate limited'),
        detail: limit.label && recovery ? `${limit.label} · ${recovery}` : recovery,
        title: limit.label ?? '',
        group: 'attention',
      };
    }
    if (!account.schedulable) {
      return { tone: 'neutral', label: $t('Paused'), detail: '', title: '', group: 'paused' };
    }
    return { tone: 'ok', label: $t('Normal'), detail: '', title: '', group: 'ok' };
  }

  function keyStatus(account: ApiKeyAccountView | null): {
    tone: Tone;
    label: string;
    detail: string;
    title: string;
    group: AccountListRow['statusGroup'];
  } {
    if (!account) {
      return {
        tone: 'warning',
        label: $t('No saved keys'),
        detail: '',
        title: '',
        group: 'attention',
      };
    }
    const title = [account.reason, account.reasonMessage].filter(Boolean).join('\n');
    const detail = account.nextRetryAt
      ? `${$t('Next recovery attempt')}: ${new Date(account.nextRetryAt).toLocaleString(undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : '';
    if (!account.enabled)
      return { tone: 'neutral', label: $t('Paused'), detail: '', title, group: 'paused' };
    switch (account.state) {
      case 'ready':
        return { tone: 'ok', label: $t('Normal'), detail: '', title, group: 'ok' };
      case 'cooldown':
        return { tone: 'warning', label: $t('Rate limited'), detail, title, group: 'attention' };
      case 'quota_exhausted':
        return { tone: 'warning', label: $t('Quota exhausted'), detail, title, group: 'attention' };
      case 'invalid':
        return { tone: 'error', label: $t('Key not working'), detail, title, group: 'attention' };
    }
  }

  const keyEntries = $derived(
    keyPools.flatMap((pool) => {
      const linked = connections.filter((p) => !p.keyless && p.poolId === pool.id);
      const label = linked.find((p) => p.id === pool.id)?.label ?? linked[0]?.label ?? pool.id;
      return (pool.accounts.length ? pool.accounts : [null]).map((account) => ({
        pool,
        account,
        linked,
        label,
      }));
    }),
  );

  function proxyOf(
    proxy: OAuthAccount['proxy'] | ApiKeyAccountView['proxy'],
  ): { label: string; title: string } | null {
    return proxy ? { label: $t('Proxy'), title: proxyTitle(proxy) } : null;
  }

  const allRows = $derived.by((): ListRow[] => {
    const out: ListRow[] = [];
    for (const { provider, account } of rows) {
      const k = keyOf(provider.id, account.account);
      const isCodex = provider.id === 'openai-codex';
      const quotaRaw = quotaByKey.get(k);
      const quota = isCodex ? activeCodexQuota(quotaRaw) : quotaRaw;
      const usage = usageByKey.get(k);
      const status = oauthStatus(account, usageLimitStatus(quota, isCodex));
      const summary = quotaSummary(quota);
      const plan = subscriptionPlan(provider, account);
      out.push({
        id: `oauth:${k}`,
        kind: 'subscription',
        name: account.account,
        accountLabel: account.account,
        accountTitle: [
          account.email && account.email !== account.account ? account.email : '',
          plan ? $t('Plan: {plan}', { plan }) : '',
          account.isFedramp ? $t('FedRAMP') : '',
          account.chatgptAccountId ? $t('ChatGPT ID: {id}', { id: account.chatgptAccountId }) : '',
          `${$t('Token expires')}: ${expiryLabel(account)}`,
          account.models.length > 0 ? `${$t('Models')}: ${account.models.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        providerLabel: provider.name,
        typeLabel: [$t('Subscription'), plan, provider.id === 'xai' ? $t('Experimental') : null]
          .filter(Boolean)
          .join(' · '),
        priority: account.priority,
        statusGroup: status.group,
        status,
        remainingPercent: summary?.remaining ?? null,
        quota: summary,
        windows: (quota?.windows ?? []).map((w) => ({
          key: w.key,
          label: quotaWindowLabel(w),
          used: Math.min(100, Math.max(0, w.usedPercent)),
          resetText: resetIn(w.resetsAtMs),
        })),
        balances: balancesFor(provider, account, quota),
        tokens: usage?.tokens ?? 0,
        requests: usage?.requests ?? 0,
        costUsd: usage?.costUsd,
        rpm: usage?.rpm ?? null,
        usagePeriod: 'today',
        proxy: proxyOf(account.proxy),
        href: accountDetailHref(base, provider.id, account.account),
        open: null,
        searchText: `${provider.name} ${account.account} ${account.email ?? ''} ${account.models.join(' ')}`,
        oauth: { provider, account },
      });
    }
    for (const entry of keyEntries) {
      const { pool, account, label } = entry;
      const usage = account ? pool.usage.find((u) => u.account === account.id) : undefined;
      const status = keyStatus(account);
      out.push({
        id: `key:${pool.id}/${account?.id ?? 'empty'}`,
        kind: 'key',
        name: account?.name ?? label,
        accountLabel: account?.name ?? label,
        accountTitle: [
          (account?.models ?? pool.models).length > 0
            ? `${$t('Models')}: ${(account?.models ?? pool.models).join(', ')}`
            : '',
          entry.linked.length > 1
            ? $t('Shared by {count} connections', { count: entry.linked.length })
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        providerLabel: account ? `${label} · ${account.mask}` : label,
        typeLabel: 'API Key',
        priority: account?.priority ?? null,
        statusGroup: status.group,
        status,
        remainingPercent: null,
        quota: null,
        windows: [],
        balances: [],
        tokens: usage?.tokens ?? 0,
        requests: usage?.requests ?? 0,
        costUsd: usage?.costUsd,
        rpm: null,
        usagePeriod: 'day',
        proxy: proxyOf(account?.proxy),
        href: null,
        open: account
          ? () => keyManager?.edit(pool.id, account)
          : pool.configured
            ? () => keyManager?.addKeys(pool.id)
            : null,
        searchText: `${label} ${account?.name ?? ''} ${entry.linked.map((p) => `${p.label} ${p.base_url}`).join(' ')} ${(account?.models ?? pool.models).join(' ')}`,
        key: entry,
      });
    }
    for (const connection of connections) {
      if (keyPools.some((pool) => pool.id === connection.poolId)) continue;
      const kind: AccountKind = connection.keyless ? 'keyless' : 'key';
      out.push({
        id: `conn:${connection.id}`,
        kind,
        name: connection.label,
        accountLabel: connection.label,
        accountTitle: connection.models.length
          ? `${$t('Models')}: ${connection.models.map((m) => m.alias).join(', ')}`
          : '',
        providerLabel: connection.base_url,
        typeLabel: connection.keyless ? $t('No key required') : 'API Key',
        priority: null,
        statusGroup: 'ok',
        status: null,
        remainingPercent: null,
        quota: null,
        windows: [],
        balances: [],
        tokens: 0,
        requests: 0,
        costUsd: undefined,
        rpm: null,
        usagePeriod: 'day',
        proxy: null,
        href: null,
        open: connection.keyless ? null : () => providerEditor?.start(connection),
        searchText: `${connection.label} ${connection.base_url} ${connection.models.map((m) => m.alias).join(' ')}`,
        connection,
      });
    }
    return out;
  });

  const visibleRows = $derived(filterAndSortRows(allRows, filters));

  // A click anywhere on a row opens the account; clicks on its own controls don't.
  function onRowClick(event: MouseEvent, row: ListRow): void {
    const target = event.target as Element | null;
    if (target?.closest('a, button, input, select, textarea, label, details, summary')) return;
    openRow(row);
  }

  function openRow(row: ListRow): void {
    if (row.href) void goto(row.href);
    else row.open?.();
  }

  function onRowKey(event: KeyboardEvent, row: ListRow): void {
    if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
    event.preventDefault();
    openRow(row);
  }

  const sortColumns: Array<{ key: SortKey; label: string; align?: 'right' }> = [
    { key: 'name', label: 'Account' },
    { key: 'remaining', label: 'Quota and balance' },
    { key: 'used', label: 'Usage', align: 'right' },
    { key: 'calls', label: 'Calls', align: 'right' },
    { key: 'priority', label: 'Priority' },
  ];
  const sortLabel = (key: SortKey) => sortColumns.find((c) => c.key === key)?.label ?? key;
</script>

<section class="page">
  <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Providers')}</h1>
      <p class="section-desc">{$t('Manage subscriptions and API key accounts in one place.')}</p>
    </div>
  </header>

  <ManagedProviders
    bind:this={providerEditor}
    headless
    onloaded={(value) => (connections = value)}
    onOAuth={() => {
      reconnecting = null;
      showConnect = true;
    }}
    onchange={() => {
      void keyManager?.refreshView();
    }}
  />
  <ApiKeyPools
    bind:this={keyManager}
    headless
    providers={connections}
    onloaded={(value) => (keyPools = value)}
    onconfigure={(provider) => providerEditor?.start(provider)}
  />

  {#snippet icon(name: 'fast' | 'auto-reset' | 'credits' | 'direct' | 'proxy')}
    <svg
      class="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {#if name === 'fast'}
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      {:else if name === 'auto-reset'}
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
      {:else if name === 'credits'}
        <circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path
          d="M7 6h1v4"
        />
      {:else if name === 'direct'}
        <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
      {:else}
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {/if}
    </svg>
  {/snippet}

  {#snippet sortHeader(key: SortKey, align: 'left' | 'right' = 'left')}
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 uppercase tracking-wide hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      class:flex-row-reverse={align === 'right'}
      aria-label={$t('Sort by {column}', { column: $t(sortLabel(key)) })}
      onclick={() => sortBy(key)}
    >
      <span>{$t(sortLabel(key))}</span>
      <span class="w-2 text-[10px]" aria-hidden="true"
        >{filters.sort === key ? (filters.dir === 'asc' ? '↑' : '↓') : ''}</span
      >
    </button>
  {/snippet}

  <section class="flex flex-col gap-3" aria-label={$t('Providers')}>
    <header class="flex flex-wrap items-center gap-2">
      <input
        class="input min-w-0 flex-1 sm:max-w-xs"
        type="search"
        aria-label={$t('Search providers')}
        placeholder={$t('Search accounts or models')}
        value={filters.q}
        oninput={(e) => setFilters({ q: e.currentTarget.value })}
      />
      <select
        class="select w-full sm:w-36"
        aria-label={$t('Account type')}
        value={filters.type}
        onchange={(e) => setFilters({ type: e.currentTarget.value as ProviderListFilters['type'] })}
      >
        <option value="all">{$t('All types')}</option>
        <option value="subscription">{$t('Subscription')}</option>
        <option value="key">API Key</option>
        <option value="keyless">{$t('No key required')}</option>
      </select>
      <select
        class="select w-full sm:w-36"
        aria-label={$t('Status')}
        value={filters.status}
        onchange={(e) =>
          setFilters({ status: e.currentTarget.value as ProviderListFilters['status'] })}
      >
        <option value="all">{$t('All statuses')}</option>
        <option value="ok">{$t('Normal')}</option>
        <option value="attention">{$t('Needs attention')}</option>
        <option value="paused">{$t('Paused')}</option>
      </select>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        {#if rows.length > 0}
          {@const selectedStrategy =
            strategyOptions.find((option) => option.value === overview.selectionStrategy) ??
            strategyOptions[0]}
          <label
            class="flex items-center gap-2 text-sm text-ink-muted"
            title={$t(selectedStrategy.description)}
          >
            <span class="shrink-0">{$t('Subscription account usage')}</span>
            <select
              class="select w-40 disabled:opacity-50"
              aria-label={$t('Account usage strategy')}
              value={overview.selectionStrategy}
              disabled={savingStrategy}
              onchange={(e) =>
                saveSelectionStrategy(e.currentTarget.value as OAuthSelectionStrategy)}
            >
              {#each strategyOptions as option (option.value)}
                <option value={option.value}>{$t(option.label)}</option>
              {/each}
            </select>
          </label>
        {/if}
        <RefreshControl
          onRefresh={async () => {
            await Promise.all([refresh(), keyManager?.refreshView(), providerEditor?.load()]);
          }}
          onAutoRefresh={async () => {
            await Promise.all([autoRefresh(), keyManager?.refreshView(), providerEditor?.load()]);
          }}
        />
        <button type="button" class="btn-primary" onclick={() => providerEditor?.start()}
          >{$t('Add provider')}</button
        >
      </div>
    </header>

    {#if refreshStatusLabel(overview.refresh)}
      <p
        data-testid="provider-refresh-status"
        class:alert-error={overview.refresh.state === 'failed'}
        class:field-help={overview.refresh.state !== 'failed'}
        role="status"
        aria-live="polite"
      >
        {refreshStatusLabel(overview.refresh)}
      </p>
    {/if}
    {#if error}
      <p class="alert-error" role="alert">{error}</p>
    {/if}

    {#if resetNotice}
      <p class="alert-success" role="status">{resetNotice}</p>
    {/if}

    {#if !overview.configured}
      <p class="alert-warn">
        {$t('OAuth login is disabled. Set HELM_OAUTH_ENC_KEY (32 bytes) and restart to enable it.')}
      </p>
    {/if}

    {#if showConnect}
      <ConnectProviderDialog
        providers={overview.providers}
        reconnect={reconnecting}
        onconnected={onConnected}
        onclose={() => {
          reconnecting = null;
          showConnect = false;
        }}
      />
    {/if}

    {#if managing}
      <ManageAccountDialog
        providerId={managing.providerId}
        providerName={managing.providerName}
        account={managing.account}
        onsaved={onManaged}
        onclose={() => (managing = null)}
      />
    {/if}

    {#if testing}
      <TestAccountDialog
        provider={testing.providerId}
        providerName={testing.providerName}
        account={testing.account}
        models={testing.models}
        onclose={() => (testing = null)}
      />
    {/if}

    {#if visibleRows.length === 0}
      <div class="empty-state">
        {$t('No matching providers. Add a provider or change the filters.')}
      </div>
    {:else}
      <div class="cards-table-frame overflow-visible">
        <table class="cards-table">
          <thead class="table-head">
            <tr>
              <th class="px-3 py-2">{@render sortHeader('name')}</th>
              <th class="px-3 py-2">{$t('Status')}</th>
              <th class="px-3 py-2">{@render sortHeader('remaining')}</th>
              <th class="px-3 py-2 text-right" title={$t('Tokens, cost and requests')}
                >{@render sortHeader('used', 'right')}</th
              >
              <th class="px-3 py-2">{$t('Connection')}</th>
              <th
                class="px-3 py-2 text-center"
                title={$t(
                  'Lower numbers are used first. In lanes with “Mix accounts by priority” on, accounts from every provider in the lane share this order; elsewhere it applies within each pool.',
                )}>{@render sortHeader('priority')}</th
              >
              <th class="whitespace-nowrap px-3 py-2">{$t('Enabled')}</th>
              <th class="whitespace-nowrap px-3 py-2">{$t('Options')}</th>
              <th class="px-3 py-2"><span class="sr-only">{$t('Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as row (row.id)}
              {@const scheduleKey = row.oauth
                ? keyOf(row.oauth.provider.id, row.oauth.account.account)
                : ''}
              {@const saving = savingSchedule[scheduleKey] === true}
              <tr
                class="cursor-pointer align-top focus-visible:bg-slate-50 focus-visible:outline-none"
                data-testid={row.oauth
                  ? 'provider-account-row'
                  : row.key
                    ? 'key-provider-row'
                    : 'unpooled-provider-row'}
                tabindex={row.href || row.open ? 0 : -1}
                onclick={(e) => onRowClick(e, row)}
                onkeydown={(e) => onRowKey(e, row)}
              >
                <!-- Account: name, what kind of account, and where it comes from. -->
                <td
                  data-label={$t('Account')}
                  data-testid="provider-account-cell"
                  class="table-mode:max-w-60 table-mode:min-w-48 table-mode:whitespace-normal"
                >
                  {#if row.href}
                    <a
                      class="block truncate font-medium text-ink-body hover:underline"
                      href={row.href}
                      title={row.accountTitle || row.accountLabel}>{row.accountLabel}</a
                    >
                  {:else}
                    <div
                      class="truncate font-medium text-ink-body"
                      title={row.accountTitle || row.accountLabel}
                    >
                      {row.accountLabel}
                    </div>
                  {/if}
                  <div class="mt-1 flex min-w-0 items-center gap-1.5">
                    <span
                      class={`shrink-0 whitespace-nowrap ${row.kind === 'subscription' ? 'badge-rules' : 'badge-neutral'}`}
                      data-testid="provider-type-cell">{row.typeLabel}</span
                    >
                    <span class="truncate text-xs text-ink-muted" title={row.providerLabel}
                      >{row.providerLabel}</span
                    >
                  </div>
                </td>

                <td
                  data-label={$t('Status')}
                  data-testid="provider-status-cell"
                  class="table-mode:max-w-36 table-mode:whitespace-normal"
                  title={row.status?.title || undefined}
                >
                  {#if row.status}
                    <span class={toneClass[row.status.tone]}>{row.status.label}</span>
                    {#if row.status.detail}
                      <div class="mt-0.5 text-xs text-ink-muted">{row.status.detail}</div>
                    {/if}
                    {#if row.key && row.status.tone !== 'ok' && row.status.title}
                      <!-- Why an API key stopped: the provider's own message, full text on hover. -->
                      <div class="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                        {row.status.title.split('\n').at(-1)}
                      </div>
                    {/if}
                  {:else}
                    <span class="text-ink-muted">—</span>
                  {/if}
                </td>

                <!-- Quota and balance: every window with its own bar, then every
                     balance-like fact (credits, reset credits, monthly limit…). -->
                <td
                  data-label={$t('Quota and balance')}
                  data-testid="provider-quota-cell"
                  class="table-mode:whitespace-normal"
                >
                  {#if row.windows.length === 0 && row.balances.length === 0}
                    <span class="text-ink-muted">—</span>
                  {:else}
                    <div class="flex w-full flex-col gap-1.5 table-mode:w-52">
                      {#each row.windows as w (w.key)}
                        <div>
                          <div class="flex items-baseline justify-between gap-2 text-xs">
                            <span class="truncate text-ink-muted">{w.label}</span>
                            <span class="shrink-0 font-medium tabular-nums text-ink-body"
                              >{$t('{n}% left', { n: Math.round(100 - w.used) })}</span
                            >
                          </div>
                          <div class="progress-track mt-0.5">
                            <div
                              class={`progress-bar ${barColor(w.used)}`}
                              style={`width:${Math.min(100, Math.max(2, w.used))}%`}
                            ></div>
                          </div>
                          {#if w.resetText}
                            <div class="text-[11px] text-ink-muted">{w.resetText}</div>
                          {/if}
                        </div>
                      {/each}
                      {#if row.balances.length > 0}
                        <dl
                          class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs"
                          class:border-t={row.windows.length > 0}
                          class:border-slate-100={row.windows.length > 0}
                          class:pt-1.5={row.windows.length > 0}
                        >
                          {#each row.balances as b (b.label)}
                            <dt class="text-ink-muted">{b.label}</dt>
                            <dd
                              class="min-w-0 break-words text-right tabular-nums text-ink-body"
                              data-testid={b.testid}
                            >
                              {b.value}
                            </dd>
                          {/each}
                        </dl>
                      {/if}
                    </div>
                  {/if}
                </td>

                <td
                  data-label={$t('Usage')}
                  data-testid="provider-used-cell"
                  class="table-mode:text-right"
                >
                  {#if row.tokens > 0 || row.requests > 0 || (row.costUsd ?? 0) > 0}
                    <div class="tabular-nums text-ink-body">
                      {formatTokens(row.tokens)}
                      <span class="text-ink-muted">· {formatUsd(row.costUsd)}</span>
                    </div>
                    <div
                      class="text-xs tabular-nums text-ink-muted"
                      data-testid="provider-calls-cell"
                      title={row.rpm != null ? `${row.rpm} ${$t('per minute')}` : undefined}
                    >
                      {$t('{n} calls', {
                        n: formatCount(row.requests),
                      })}{#if row.rpm != null}{` · ${row.rpm}/${$t('min')}`}{/if}
                    </div>
                    <div class="text-[11px] text-ink-muted">
                      {row.usagePeriod === 'day' ? $t('Last 24 hours') : $t('Today')}
                    </div>
                  {:else}
                    <span class="text-ink-muted" data-testid="provider-calls-cell">—</span>
                  {/if}
                </td>

                <td data-label={$t('Connection')} data-testid="provider-connection-cell">
                  {#if row.kind === 'keyless' || row.connection}
                    <span class="text-ink-muted">—</span>
                  {:else if row.proxy}
                    <span
                      class="inline-flex items-center gap-1 text-xs text-ink-body"
                      use:tooltip={`${$t('Via proxy')}: ${row.proxy.title}`}
                      >{@render icon('proxy')}{row.proxy.label}</span
                    >
                  {:else}
                    <span
                      class="inline-flex items-center gap-1 text-xs text-ink-muted"
                      use:tooltip={$t('Connects directly, no proxy')}
                      >{@render icon('direct')}{$t('Direct')}</span
                    >
                  {/if}
                </td>

                <!-- Priority: lower numbers are used first. Edited in place. -->
                <td
                  data-label={$t('Priority')}
                  data-testid="provider-priority-cell"
                  class="table-mode:text-center"
                >
                  {#if row.oauth}
                    {@const { provider, account } = row.oauth}
                    <input
                      class="input-sm w-16 text-center tabular-nums"
                      type="number"
                      min="0"
                      step="1"
                      aria-label={$t('Priority')}
                      value={account.priority}
                      disabled={saving}
                      onchange={(e) =>
                        saveOAuthPriority(provider.id, account.account, e.currentTarget.value)}
                    />
                  {:else if row.key?.account}
                    {@const { pool, account } = row.key}
                    {#if account}
                      <input
                        class="input-sm w-16 text-center tabular-nums"
                        type="number"
                        min="0"
                        max="1000"
                        step="1"
                        aria-label={$t('Priority')}
                        value={account.priority}
                        title={pool.strategy === 'round_robin'
                          ? $t(
                              'This key pool takes turns. Its priority still applies in lanes that mix accounts by priority, or after switching it to manual priority.',
                            )
                          : undefined}
                        onchange={(e) => saveKeyPriority(pool.id, account, e.currentTarget.value)}
                      />
                    {/if}
                  {:else}
                    <span class="text-ink-muted">—</span>
                  {/if}
                </td>

                <!-- Enabled: whether the gateway may route to this account. -->
                <td data-label={$t('Enabled')} data-testid="provider-enabled-cell">
                  {#if row.oauth}
                    {@const { provider, account } = row.oauth}
                    <Switch
                      label={$t('Schedulable')}
                      checked={account.schedulable}
                      disabled={saving || account.credentialFailed === true}
                      title={account.credentialFailed ? $t('Needs sign-in') : undefined}
                      onchange={(v) =>
                        updateSchedule(provider.id, account.account, { schedulable: v })}
                    />
                  {:else if row.key?.account}
                    {@const { pool, account } = row.key}
                    {#if account}
                      <Switch
                        label={$t('Schedulable')}
                        checked={account.enabled}
                        onchange={() => keyManager?.toggleAccount(pool.id, account)}
                      />
                    {/if}
                  {:else}
                    <span class="text-ink-muted">—</span>
                  {/if}
                </td>

                <!-- Options: fixed slots (fast / auto-reset / use credits) so every row lines up. -->
                <td data-label={$t('Options')} data-testid="provider-options-cell">
                  {#if row.oauth}
                    {@const { provider, account } = row.oauth}
                    {@const options = [
                      provider.id === 'anthropic' || provider.id === 'openai-codex'
                        ? {
                            icon: 'fast' as const,
                            label: $t('Fast mode'),
                            title: $t('Fast mode: always use the provider’s faster tier'),
                            on: account.fastMode ?? false,
                            patch: (v: boolean) => ({ fastMode: v }),
                          }
                        : null,
                      provider.id === 'openai-codex'
                        ? {
                            icon: 'auto-reset' as const,
                            label: $t('Auto-reset'),
                            title: $t(
                              'Auto-resets the weekly limit once it saturates (at most once per hour)',
                            ),
                            on: account.autoReset ?? false,
                            patch: (v: boolean) => ({ autoReset: v }),
                          }
                        : null,
                      {
                        icon: 'credits' as const,
                        label: $t('Use credits when limited'),
                        title: $t('Keeps using remaining credits when limited'),
                        on: account.allowSpendRemainingCredits ?? false,
                        patch: (v: boolean) => ({ allowSpendRemainingCredits: v }),
                      },
                    ]}
                    <div class="flex items-center gap-1.5">
                      {#each options as option, i (i)}
                        {#if option}
                          <button
                            type="button"
                            class="btn-icon-toggle"
                            aria-pressed={option.on}
                            aria-label={option.label}
                            use:tooltip={`${option.title} · ${option.on ? $t('On') : $t('Off')}`}
                            disabled={saving}
                            onclick={() =>
                              updateSchedule(
                                provider.id,
                                account.account,
                                option.patch(!option.on),
                              )}>{@render icon(option.icon)}</button
                          >
                        {:else}
                          <span class="btn-icon-toggle invisible" aria-hidden="true"></span>
                        {/if}
                      {/each}
                    </div>
                  {:else}
                    <span class="text-ink-muted">—</span>
                  {/if}
                </td>
                <!-- Actions: Test stays visible, everything else in one menu. -->
                <td class="table-mode:w-px table-mode:text-right">
                  <div class="flex items-center justify-end gap-2">
                    {#if row.oauth}
                      {@const { provider, account } = row.oauth}
                      {@const k = keyOf(provider.id, account.account)}
                      {@const isCodex = provider.id === 'openai-codex'}
                      {@const quota = isCodex
                        ? activeCodexQuota(quotaByKey.get(k))
                        : quotaByKey.get(k)}
                      {@const codexCredits = isCodex ? (quota?.resetCredits ?? null) : null}
                      {@const usageLimit = usageLimitStatus(quota, isCodex)}
                      {#if !account.healthy}
                        <button
                          type="button"
                          class="btn-primary"
                          disabled={!overview.configured}
                          onclick={() => {
                            reconnecting = { providerId: provider.id, account: account.account };
                            showConnect = true;
                          }}>{$t('Reconnect')}</button
                        >
                      {/if}
                      <button
                        type="button"
                        class="btn-secondary"
                        onclick={() =>
                          (testing = {
                            providerId: provider.id,
                            providerName: provider.name,
                            account: account.account,
                            models: account.models.filter((model) => mediaBadge(model) === null),
                          })}>{$t('Test')}</button
                      >
                      <details data-testid="provider-actions" class="menu">
                        <summary class="menu-trigger" use:tooltip={$t('More actions')}>
                          <span aria-hidden="true">⋯</span>
                          <span class="sr-only">{$t('More actions')}</span>
                        </summary>
                        <div class="menu-panel w-56">
                          <button
                            type="button"
                            class="menu-item"
                            onclick={() =>
                              (managing = {
                                providerId: provider.id,
                                providerName: provider.name,
                                account: account.account,
                              })}>{$t('Manage')}</button
                          >
                          {#if usageLimit?.retryable && isCodex}
                            <button
                              type="button"
                              class="menu-item"
                              disabled={resetting[k] === true}
                              title={$t('Clear Helm local cooldown and try this account again')}
                              onclick={() => retryAccount(provider.id, account.account)}
                              >{resetting[k] === true
                                ? $t('Retrying…')
                                : $t('Retry account')}</button
                            >
                          {/if}
                          {#if isCodex}
                            <button
                              type="button"
                              class="menu-item"
                              disabled={!canUseCodexResetCredit(quota, codexCredits)}
                              title={resetCreditTitle(quota, codexCredits)}
                              onclick={() =>
                                (confirmingReset = (() => {
                                  const credit = quota?.resetCreditDetails?.find(
                                    (item) =>
                                      item.status === 'available' &&
                                      item.resetType === 'codexRateLimits',
                                  );
                                  return {
                                    providerId: provider.id,
                                    account: account.account,
                                    credits: codexCredits ?? 0,
                                    autoReset: account.autoReset ?? false,
                                    ...(credit?.id ? { creditId: credit.id } : {}),
                                    ...(credit?.title ? { creditTitle: credit.title } : {}),
                                    idempotencyKey: resetRequestId(),
                                  };
                                })())}
                              >{codexCredits != null && codexCredits > 0
                                ? $t('Reset limit ({n})', { n: codexCredits })
                                : $t('Reset limit')}</button
                            >
                          {/if}
                          {#if provider.id === 'anthropic'}
                            <button
                              type="button"
                              class="menu-item"
                              disabled={resettingLimit}
                              onclick={() => prepareAnthropicReset(account.account)}
                              >{$t(
                                'Reset Claude usage',
                              )}{#if anthropicResetButtonMeta(account.account)}
                                <span class="text-xs opacity-80" data-testid="anthropic-reset-meta"
                                  >({anthropicResetButtonMeta(account.account)})</span
                                >{/if}</button
                            >
                          {/if}
                          <button
                            type="button"
                            class="menu-item-danger"
                            disabled={disconnecting}
                            onclick={() =>
                              (confirming = { providerId: provider.id, account: account.account })}
                            >{$t('Disconnect')}</button
                          >
                        </div>
                      </details>
                    {:else if row.key}
                      {@const { pool, account, linked } = row.key}
                      {#if account}
                        <button
                          type="button"
                          class="btn-secondary"
                          disabled={!keyManager?.canTest(pool, account)}
                          onclick={() => keyManager?.openTest(pool, account)}>{$t('Test')}</button
                        >
                      {:else}
                        <button
                          type="button"
                          class="btn-primary"
                          disabled={!pool.configured}
                          onclick={() => keyManager?.addKeys(pool.id)}>{$t('Add API keys')}</button
                        >
                      {/if}
                      <details class="menu">
                        <summary class="menu-trigger" use:tooltip={$t('More actions')}
                          ><span aria-hidden="true">⋯</span><span class="sr-only"
                            >{$t('More actions')}</span
                          ></summary
                        >
                        <div class="menu-panel w-64">
                          {#if account}<button
                              type="button"
                              class="menu-item"
                              onclick={() => keyManager?.edit(pool.id, account)}
                              >{$t('Manage')}</button
                            >{/if}
                          <button
                            type="button"
                            class="menu-item"
                            disabled={!pool.configured}
                            onclick={() => keyManager?.addKeys(pool.id)}
                            >{$t('Add API keys')}</button
                          >
                          <button
                            type="button"
                            class="menu-item"
                            disabled={!keyManager?.canRecover(pool)}
                            onclick={() => keyManager?.batchTest(pool)}
                            >{$t('Batch test and recover')}</button
                          >
                          {#if account}<button
                              type="button"
                              class="menu-item"
                              onclick={() => keyManager?.toggleAccount(pool.id, account)}
                              >{account.enabled ? $t('Pause') : $t('Resume')}</button
                            >{/if}
                          {#if account && keyManager?.canRecoverAccount(account) && keyManager?.canTest(pool, account)}
                            <button
                              type="button"
                              class="menu-item"
                              onclick={() => keyManager?.recoverAccount(pool, account)}
                              >{$t('Try recovery')}</button
                            >
                          {/if}
                          {#each linked as connection (connection.id)}
                            <button
                              type="button"
                              class="menu-item"
                              onclick={() => providerEditor?.start(connection)}
                              >{$t('Configure')} · {connection.label}</button
                            >
                          {/each}
                          {#each linked as connection (connection.id)}
                            {#if connection.managed}<button
                                type="button"
                                class="menu-item-danger"
                                onclick={() => providerEditor?.askDelete(connection)}
                                >{$t('Delete provider')} · {connection.label}</button
                              >{/if}
                          {/each}
                          {#if account}<button
                              type="button"
                              class="menu-item-danger"
                              onclick={() => keyManager?.removeAccount(pool.id, account)}
                              >{$t('Delete account')}</button
                            >{/if}
                        </div>
                      </details>
                    {:else if row.connection}
                      {#if row.connection.keyless}
                        <span class="field-help">{$t('Configuration file')}</span>
                      {:else}
                        <button
                          type="button"
                          class="btn-secondary"
                          onclick={() => row.connection && providerEditor?.start(row.connection)}
                          >{$t('Manage here')}</button
                        >
                      {/if}
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <details hidden={!upstreamUsageVisible}>
    <summary class="w-fit cursor-pointer text-sm text-ink-muted">{$t('Upstream usage')}</summary
    ><UpstreamProviderUsage onvisibility={(visible) => (upstreamUsageVisible = visible)} />
  </details>

  {#if confirming}
    <Modal
      label={$t('Confirm disconnect')}
      onclose={() => {
        if (!disconnecting) confirming = null;
      }}
    >
      <h2 class="section-header">{$t('Confirm disconnect')}</h2>
      <p class="mt-3 text-sm text-ink-body">
        {$t('Disconnect')}
        <code class="font-mono text-ink-strong">{confirming.account}</code>
        {$t('from')}
        {providerName(confirming.providerId)}{$t('? Helm will forget its stored tokens.')}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={disconnecting}
          onclick={() => (confirming = null)}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="btn-danger"
          disabled={disconnecting}
          onclick={confirmDisconnect}
          >{disconnecting ? $t('Disconnecting…') : $t('Disconnect')}</button
        >
      </div>
    </Modal>
  {/if}

  {#if confirmingReset}
    <Modal
      label={$t('Confirm reset limit')}
      onclose={() => {
        if (!resettingLimit) confirmingReset = null;
      }}
    >
      <h2 class="section-header">{$t('Confirm reset limit')}</h2>
      <p class="mt-3 text-sm text-ink-body">
        {$t('Consume one of {n} reset credits for', { n: confirmingReset.credits })}
        <code class="font-mono text-ink-strong">{confirmingReset.account}</code>?
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        {$t(
          'This restores the rate-limit window for the entire ChatGPT account. Any other connected account using the same ChatGPT login will also be reset.',
        )}
      </p>
      {#if confirmingReset.creditTitle}
        <p class="mt-2 text-sm font-medium text-ink-body">{confirmingReset.creditTitle}</p>
      {/if}
      <label class="checkbox-field mt-4" data-testid="reset-auto-reset-toggle">
        <input type="checkbox" class="checkbox" bind:checked={confirmingReset.autoReset} />
        <span class="text-sm text-ink-body"
          >{$t('Also auto-reset this account in the future (at most once per hour)')}</span
        >
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={resettingLimit}
          onclick={() => (confirmingReset = null)}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="btn-primary"
          disabled={resettingLimit}
          onclick={confirmResetLimit}
          >{resettingLimit ? $t('Resetting…') : $t('Reset limit')}</button
        >
      </div>
    </Modal>
  {/if}

  {#if confirmingAnthropicReset}
    <Modal
      label={$t('Confirm Claude usage reset')}
      dismissible={false}
      onclose={() => {
        if (!resettingLimit) confirmingAnthropicReset = null;
      }}
    >
      <h2 class="section-header">{$t('Confirm Claude usage reset')}</h2>
      <p class="mt-3 text-sm text-ink-body">
        {$t('Use one Claude reset for')}
        <code class="font-mono text-ink-strong">{confirmingAnthropicReset.account}</code>?
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        {confirmingAnthropicReset.grant.label ?? confirmingAnthropicReset.grant.id}; {$t(
          '{n} resets remaining',
          { n: confirmingAnthropicReset.grant.resets_left },
        )}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        {$t('Scope')}: {confirmingAnthropicReset.grant.clears.join(', ')} · {$t('Expires')}: {new Date(
          confirmingAnthropicReset.grant.ends_at,
        ).toLocaleString()}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        {$t('Claude reset affects every connected token in the same Claude organization')}
      </p>
      {#if confirmingAnthropicReset.status.cooldown_until}<p class="mt-2 text-sm text-ink-muted">
          {$t('Claude reset is currently cooling down')}
        </p>{/if}
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={resettingLimit}
          onclick={() => (confirmingAnthropicReset = null)}>{$t('Cancel')}</button
        ><button
          type="button"
          class="btn-primary"
          disabled={resettingLimit}
          onclick={confirmAnthropicReset}
          >{resettingLimit ? $t('Resetting…') : $t('Reset Claude usage')}</button
        >
      </div>
    </Modal>
  {/if}
</section>
