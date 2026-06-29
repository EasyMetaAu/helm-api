<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    consumeCodexResetCredit,
    logoutOAuth,
    resetUsageLimit,
    setAccountSchedule,
    type OAuthAccount,
    type OAuthProviderStatus,
    type OAuthQuotaSnapshot,
    type OAuthQuotaWindow,
    type OAuthUsageRow,
  } from '$lib/api/oauth.js';
  import ConnectProviderDialog from '$lib/components/ConnectProviderDialog.svelte';
  import ManageAccountDialog from '$lib/components/ManageAccountDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import TestAccountDialog from '$lib/components/TestAccountDialog.svelte';
  import { durationParts, formatCount, formatTokens, formatUsd } from '$lib/format';
  import { t } from '$lib/i18n';

  // Subscription OAuth login (issue #38). Pure consumer (Principle 1): the gateway
  // owns the flow + encrypted token storage; this page lists connected accounts and
  // now their day-to-day operating signals — today's usage, remaining quota windows,
  // pool priority + schedulable — with inline edits for the routing knobs. Usage and
  // quota are fail-open observability (absent ⇒ rendered as "—"), so a flaky stats
  // endpoint never breaks the page.
  let {
    data,
  }: {
    data: {
      configured: boolean;
      providers: OAuthProviderStatus[];
      usage: OAuthUsageRow[];
      quota: OAuthQuotaSnapshot[];
      loadError?: string;
    };
  } = $props();

  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let refreshing = $state<boolean>(false);
  let showConnect = $state<boolean>(false);
  let managing = $state<{ providerId: string; providerName: string; account: string } | null>(null);
  // The account whose connectivity-test dialog is open (providers page "Test"
  // button). Carries the row's effective models so the dialog's picker offers only
  // routable ids — no extra fetch.
  let testing = $state<{
    providerId: string;
    providerName: string;
    account: string;
    models: string[];
  } | null>(null);
  let confirming = $state<{ providerId: string; account: string } | null>(null);
  let disconnecting = $state<boolean>(false);
  // Accounts whose inline schedule edit is in flight (keyed provider/account) — used
  // to disable the control while saving without blocking the rest of the table.
  let savingSchedule = $state<Record<string, boolean>>({});
  // Accounts whose "Reset usage" click is in flight (keyed provider/account) — clears
  // the auto-park cooldown (#291).
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
  } | null>(null);
  // True while the confirmed consume is in flight (disables the dialog's buttons).
  let resettingLimit = $state<boolean>(false);
  // Transient success line after a credit reset (e.g. "Reset 2 window(s)"); cleared on
  // the next action. Errors continue to use the shared `error` banner.
  let resetNotice = $state<string | null>(null);

  const keyOf = (providerId: string, account: string): string => `${providerId}/${account}`;
  const ACTIVE_LIMIT_RECOVERY_THRESHOLD = 95;

  // One table row per connected account, flattened across providers, joined to its
  // usage + quota snapshot (both fail-open: a missing entry renders "—").
  let usageByKey = $derived(new Map(data.usage.map((u) => [keyOf(u.providerId, u.account), u])));
  let quotaByKey = $derived(new Map(data.quota.map((q) => [keyOf(q.providerId, q.account), q])));
  let rows = $derived(
    data.providers.flatMap((p) => p.accounts.map((account) => ({ provider: p, account }))),
  );

  function providerName(id: string): string {
    return data.providers.find((p) => p.id === id)?.name ?? id;
  }

  // A short "platform · auth" pill so the supply-chain shape is legible at a glance
  // (Claude Max / Codex / Copilot + how it authenticates) without exposing the model
  // market (Principle 6 — provider aliases stay internal).
  function typeBadge(p: OAuthProviderStatus): string {
    if (p.id === 'anthropic') return `${$t('Claude Max')} · OAuth`;
    if (p.id === 'openai-codex') return `Codex · OAuth`;
    if (p.id === 'github-copilot') return `Copilot · ${$t('Device')}`;
    return p.flow === 'device_code' ? $t('Device') : 'OAuth';
  }

  // How many model pills to render inline before collapsing the rest into a "+N"
  // pill (Copilot can expose 20+; the full list rides in the cell's title tooltip).
  const MODELS_SHOWN = 3;

  // Compact egress-proxy label ("socks5 · 10.0.0.1:1080"), or null when the account
  // connects directly. The gateway already REDACTED the password (only `hasPassword`
  // crosses), so nothing secret is rendered.
  function proxyLabel(p: OAuthAccount['proxy']): string | null {
    if (!p) return null;
    return `${p.type} · ${p.host}:${p.port}`;
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

  // Friendly window labels (provider-specific keys → display).
  function windowLabel(key: string): string {
    const map: Record<string, string> = {
      '5h': '5h',
      '7d': '7d',
      '7d-opus': '7d · Opus',
      '7d-sonnet': '7d · Sonnet',
      // Codex windows: `primary` is the 5-hour rolling window (windowMinutes 300),
      // `secondary` is the weekly limit (windowMinutes 10080) — matching the Codex UI.
      primary: '5h',
      secondary: $t('Weekly'),
    };
    return map[key] ?? key;
  }

  // Color ramp mirrors claude-relay: calm under 75%, warning to 90%, danger beyond.
  function barColor(pct: number): string {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 75) return 'bg-amber-500';
    return 'bg-indigo-500';
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
      if (w.usedPercent < threshold || w.resetsAtMs == null || w.resetsAtMs <= now) {
        continue;
      }
      if (chosen == null || w.resetsAtMs < (chosen.resetsAtMs ?? Number.POSITIVE_INFINITY)) {
        chosen = w;
      }
    }
    return chosen;
  }

  // Is this account auto-parked by a usage limit right now? Prefer the nearest
  // near-full quota window over the short generic 429 fallback, so an Anthropic 5h
  // limit reported as 98-99% still shows the real reset instead of "0m".
  function usageLimitStatus(
    q: OAuthQuotaSnapshot | undefined,
  ): { untilMs: number; label: string | null } | null {
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
      label = windowLabel(recoveryWindow.key);
    }
    return untilMs == null ? null : { untilMs, label };
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
    void invalidateAll();
  }

  // Manual refresh: re-run the page load (status + today's usage + quota windows in
  // parallel). Usage counters are read live; the Anthropic quota PULL stays behind
  // the gateway's 5-min debounce (the upstream endpoint rate-limits aggressively),
  // so within that window the bars re-render from the cached snapshot. The load
  // itself never throws (fail-open) — `loadError` carries the only failure signal.
  async function refresh(): Promise<void> {
    refreshing = true;
    error = null;
    try {
      await invalidateAll();
      error = data.loadError ?? null;
    } finally {
      refreshing = false;
    }
  }

  function onManaged(): void {
    managing = null;
    void invalidateAll();
  }

  // Inline schedule edits reuse the existing PUT seam; on success the route hot-rebuilds
  // the pool, so we invalidateAll to reflect the live priority/parked state. A 503
  // "saved but not applied" (or any error) surfaces via `error` without losing the page.
  async function savePriority(providerId: string, account: string, raw: string): Promise<void> {
    // Reject what the Manage dialog + API also reject: priority is a NON-NEGATIVE
    // integer. `Number` (not parseInt) so "1.9" fails instead of silently truncating
    // to 1, and "-1" is refused (a negative priority would always win pool scheduling).
    const priority = Number(raw);
    if (!Number.isInteger(priority) || priority < 0) {
      error = $t('Priority must be a non-negative integer');
      return;
    }
    const k = keyOf(providerId, account);
    savingSchedule = { ...savingSchedule, [k]: true };
    error = null;
    try {
      await setAccountSchedule(providerId, account, { priority });
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update scheduling');
    } finally {
      savingSchedule = { ...savingSchedule, [k]: false };
    }
  }

  async function toggleSchedulable(
    providerId: string,
    account: string,
    schedulable: boolean,
  ): Promise<void> {
    const k = keyOf(providerId, account);
    savingSchedule = { ...savingSchedule, [k]: true };
    error = null;
    try {
      await setAccountSchedule(providerId, account, { schedulable });
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update scheduling');
    } finally {
      savingSchedule = { ...savingSchedule, [k]: false };
    }
  }

  // "Reset usage": clear the auto-park cooldown so the account rejoins the pool on the
  // next request. Cooldown-only — the operator's schedulable park is untouched. On
  // success invalidateAll re-reads the (now-cleared) snapshot so the pill disappears.
  async function resetUsage(providerId: string, account: string): Promise<void> {
    const k = keyOf(providerId, account);
    resetting = { ...resetting, [k]: true };
    error = null;
    try {
      await resetUsageLimit(providerId, account);
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to reset usage limit');
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
    const { providerId, account, autoReset } = confirmingReset;
    resettingLimit = true;
    error = null;
    resetNotice = null;
    try {
      // Persist the auto-reset opt-in first, decoupled from the consume below: even if
      // the reset fails (no credit / network), the operator's "do this automatically
      // from now on" choice still sticks. Best-effort — a save failure never blocks the
      // reset (they can still toggle it in the Manage dialog).
      try {
        await setAccountSchedule(providerId, account, { autoReset });
      } catch {
        /* non-fatal: the manual reset is the primary action */
      }
      const result = await consumeCodexResetCredit(providerId, account);
      confirmingReset = null;
      await invalidateAll();
      resetNotice =
        result.windowsReset != null
          ? $t('Reset {n} window(s)', { n: result.windowsReset })
          : $t('Reset limit consumed');
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to reset limit');
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
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Subscription Providers')}</h1>
      <p class="section-desc">
        {$t(
          'Connect Claude, ChatGPT, or GitHub Copilot subscriptions so Helm can route to them. You can connect several accounts per provider.',
        )}
      </p>
    </div>
    <div class="flex w-full shrink-0 gap-2 sm:w-auto">
      <button
        type="button"
        class="btn-secondary flex-1 sm:flex-none"
        disabled={refreshing}
        onclick={refresh}>{refreshing ? $t('Refreshing…') : $t('Refresh')}</button
      >
      <button
        type="button"
        class="btn-primary flex-1 sm:flex-none"
        disabled={!data.configured}
        onclick={() => (showConnect = true)}>{$t('Connect')}</button
      >
    </div>
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
  {/if}

  {#if resetNotice}
    <p class="alert-success" role="status">{resetNotice}</p>
  {/if}

  {#if !data.configured}
    <p class="alert-warn">
      {$t('OAuth login is disabled. Set HELM_OAUTH_ENC_KEY (32 bytes) and restart to enable it.')}
    </p>
  {/if}

  {#if showConnect}
    <ConnectProviderDialog
      providers={data.providers}
      onconnected={onConnected}
      onclose={() => (showConnect = false)}
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

  {#if rows.length === 0}
    <div class="empty-state">
      <p>
        {$t(
          'No subscriptions connected yet. Click Connect to link a Claude, ChatGPT, or Copilot account.',
        )}
      </p>
    </div>
  {:else}
    <div class="cards-table-frame">
      <table class="cards-table">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2">{$t('Provider')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
            <th class="px-3 py-2">{$t('Proxy')}</th>
            <th class="px-3 py-2">{$t('Models')}</th>
            <th class="px-3 py-2">{$t('Today')}</th>
            <th class="px-3 py-2">{$t('Quota')}</th>
            <th class="px-3 py-2">{$t('Priority')}</th>
            <th class="px-3 py-2">{$t('Schedulable')}</th>
            <th class="px-3 py-2">{$t('Expires')}</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (keyOf(row.provider.id, row.account.account))}
            {@const k = keyOf(row.provider.id, row.account.account)}
            {@const usage = usageByKey.get(k)}
            {@const quota = quotaByKey.get(k)}
            {@const saving = savingSchedule[k] === true}
            {@const isCodex = row.provider.id === 'openai-codex'}
            {@const codexCredits = isCodex ? (quota?.resetCredits ?? null) : null}
            {@const usageLimit = usageLimitStatus(quota)}
            {@const usageLimitRecovery = usageLimit ? autoRecoverIn(usageLimit.untilMs) : ''}
            <tr class="align-top" data-testid="provider-account-row">
              <!-- Provider / account + type badge -->
              <td data-label={$t('Provider')} class="px-3 py-3">
                <div class="font-medium text-ink-body">{row.provider.name}</div>
                <code class="font-mono text-xs text-ink-strong">{row.account.account}</code>
                <div class="mt-1 flex flex-wrap items-center gap-1">
                  <span class="badge-neutral">{typeBadge(row.provider)}</span>
                  {#if isCodex && row.account.autoReset}
                    <span
                      class="badge-ok"
                      data-testid="auto-reset-badge"
                      title={$t(
                        'Auto-resets the weekly limit once it saturates (at most once per hour)',
                      )}>{$t('Auto-reset')}</span
                    >
                  {/if}
                </div>
              </td>

              <!-- Status (+ parked pill) -->
              <td data-label={$t('Status')} class="px-3 py-3">
                {#if row.account.healthy}
                  <span class="badge-ok">{$t('connected')}</span>
                {:else}
                  <span class="badge-error">{$t('needs reconnect')}</span>
                {/if}
                {#if !row.account.schedulable}
                  <div class="mt-1"><span class="badge-neutral">{$t('parked')}</span></div>
                {/if}
                {#if usageLimit}
                  <div class="mt-1">
                    <span class="badge-error">{$t('Rate limited')}</span>
                    {#if usageLimitRecovery}
                      <div class="text-[10px] text-ink-muted">
                        {usageLimit.label
                          ? `${usageLimit.label} · ${usageLimitRecovery}`
                          : usageLimitRecovery}
                      </div>
                    {/if}
                  </div>
                {/if}
              </td>

              <!-- Egress proxy (redacted; "Direct" when none) -->
              <td data-label={$t('Proxy')} class="px-3 py-3 text-xs">
                {#if proxyLabel(row.account.proxy)}
                  <span class="badge-neutral font-mono" title={proxyTitle(row.account.proxy)}
                    >{proxyLabel(row.account.proxy)}</span
                  >
                {:else}
                  <span class="text-ink-muted">{$t('Direct')}</span>
                {/if}
              </td>

              <!-- Effective routable models (network-free; pills capped +N) -->
              <td data-label={$t('Models')} class="px-3 py-3">
                {#if row.account.models.length > 0}
                  {@const shown = row.account.models.slice(0, MODELS_SHOWN)}
                  {@const extra = row.account.models.length - shown.length}
                  <div
                    class="flex max-w-full flex-wrap gap-1 lg:w-48"
                    title={row.account.models.join('\n')}
                  >
                    {#each shown as m (m)}
                      <span class="badge-neutral font-mono text-[10px]">{m}</span>
                    {/each}
                    {#if extra > 0}
                      <span class="badge-neutral text-[10px]">+{extra}</span>
                    {/if}
                  </div>
                {:else}
                  <span class="text-xs text-ink-muted">—</span>
                {/if}
              </td>

              <!-- Today's usage -->
              <td data-label={$t('Today')} class="px-3 py-3 text-xs">
                {#if usage && usage.requests > 0}
                  <div class="text-ink-body">
                    {$t('{n} req', { n: formatCount(usage.requests) })}
                  </div>
                  <div class="text-ink-muted">{formatTokens(usage.tokens)} tok</div>
                  <div class="text-ink-muted">{formatUsd(usage.costUsd)}</div>
                  <div class="text-ink-muted">{usage.rpm} RPM</div>
                {:else}
                  <span class="text-ink-muted">—</span>
                {/if}
              </td>

              <!-- Quota / session windows (+ Codex reset-credit count) -->
              <td data-label={$t('Quota')} class="px-3 py-3">
                {#if quota && quota.windows.length > 0}
                  <div class="flex w-full flex-col gap-1.5 lg:w-40">
                    {#each quota.windows as w (w.key)}
                      <div>
                        <div class="flex items-center justify-between text-xs text-ink-muted">
                          <span>{windowLabel(w.key)}</span>
                          <span>{Math.round(w.usedPercent)}%</span>
                        </div>
                        <div class="progress-track">
                          <div
                            class={`progress-bar ${barColor(w.usedPercent)}`}
                            style={`width:${Math.min(100, Math.max(2, w.usedPercent))}%`}
                          ></div>
                        </div>
                        {#if resetIn(w.resetsAtMs)}
                          <div class="text-[10px] text-ink-muted">{resetIn(w.resetsAtMs)}</div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if codexCredits != null}
                  <div
                    class="text-[10px] text-ink-muted"
                    class:mt-1={quota && quota.windows.length > 0}
                  >
                    {$t('{n} reset credits', { n: codexCredits })}
                  </div>
                {/if}
                {#if !(quota && quota.windows.length > 0) && codexCredits == null}
                  <span class="text-xs text-ink-muted">—</span>
                {/if}
              </td>

              <!-- Priority (inline, lower = served first) -->
              <td data-label={$t('Priority')} class="px-3 py-3">
                <input
                  type="number"
                  min="0"
                  step="1"
                  class="min-h-11 w-16 rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50 md:min-h-0"
                  value={row.account.priority}
                  disabled={saving}
                  aria-label={$t('Priority')}
                  onchange={(e) =>
                    savePriority(row.provider.id, row.account.account, e.currentTarget.value)}
                />
              </td>

              <!-- Schedulable (inline toggle) -->
              <td data-label={$t('Schedulable')} class="px-3 py-3">
                <input
                  type="checkbox"
                  class="h-5 w-5 disabled:opacity-50 md:h-4 md:w-4"
                  checked={row.account.schedulable}
                  disabled={saving}
                  aria-label={$t('Schedulable')}
                  onchange={(e) =>
                    toggleSchedulable(
                      row.provider.id,
                      row.account.account,
                      e.currentTarget.checked,
                    )}
                />
              </td>

              <!-- Token expiry -->
              <td data-label={$t('Expires')} class="px-3 py-3 text-ink-muted"
                >{expiryLabel(row.account)}</td
              >

              <!-- Actions -->
              <td data-label={$t('Actions')} class="px-3 py-3 lg:text-right">
                <div class="grid grid-cols-2 gap-2 sm:inline-flex sm:flex-wrap lg:flex-nowrap">
                  <button
                    type="button"
                    class="btn-secondary"
                    onclick={() =>
                      (testing = {
                        providerId: row.provider.id,
                        providerName: row.provider.name,
                        account: row.account.account,
                        models: row.account.models,
                      })}>{$t('Test')}</button
                  >
                  <button
                    type="button"
                    class="btn-secondary"
                    onclick={() =>
                      (managing = {
                        providerId: row.provider.id,
                        providerName: row.provider.name,
                        account: row.account.account,
                      })}>{$t('Manage')}</button
                  >
                  {#if usageLimit}
                    <button
                      type="button"
                      class="btn-secondary"
                      disabled={resetting[k] === true}
                      onclick={() => resetUsage(row.provider.id, row.account.account)}
                      >{resetting[k] === true ? $t('Resetting…') : $t('Reset usage')}</button
                    >
                  {/if}
                  {#if isCodex}
                    <button
                      type="button"
                      class="btn-secondary"
                      disabled={codexCredits == null || codexCredits <= 0}
                      title={codexCredits == null
                        ? $t('Reset-credit count unavailable')
                        : codexCredits <= 0
                          ? $t('No reset credits available')
                          : $t('Consume one credit to restore the rate-limit window')}
                      onclick={() =>
                        (confirmingReset = {
                          providerId: row.provider.id,
                          account: row.account.account,
                          credits: codexCredits ?? 0,
                          autoReset: row.account.autoReset ?? false,
                        })}
                      >{codexCredits != null && codexCredits > 0
                        ? $t('Reset limit ({n})', { n: codexCredits })
                        : $t('Reset limit')}</button
                    >
                  {/if}
                  <button
                    type="button"
                    class="btn-danger-outline col-span-2 sm:col-span-1"
                    disabled={disconnecting}
                    onclick={() =>
                      (confirming = { providerId: row.provider.id, account: row.account.account })}
                    >{$t('Disconnect')}</button
                  >
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

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
</section>
