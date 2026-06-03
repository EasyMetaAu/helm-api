<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    logoutOAuth,
    setAccountSchedule,
    type OAuthAccount,
    type OAuthProviderStatus,
    type OAuthQuotaSnapshot,
    type OAuthUsageRow,
  } from '$lib/api/oauth.js';
  import ConnectProviderDialog from '$lib/components/ConnectProviderDialog.svelte';
  import ManageAccountDialog from '$lib/components/ManageAccountDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
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
  let showConnect = $state<boolean>(false);
  let managing = $state<{ providerId: string; providerName: string; account: string } | null>(null);
  let confirming = $state<{ providerId: string; account: string } | null>(null);
  let disconnecting = $state<boolean>(false);
  // Accounts whose inline schedule edit is in flight (keyed provider/account) — used
  // to disable the control while saving without blocking the rest of the table.
  let savingSchedule = $state<Record<string, boolean>>({});

  const keyOf = (providerId: string, account: string): string => `${providerId}/${account}`;

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

  // The access token is short-lived and auto-renewed by the gateway, so a lapsed one
  // is NOT an alarm — show "auto-renews"; when valid, the remaining time hints at the
  // next renewal.
  function expiryLabel(a: OAuthAccount): string {
    if (a.expiresAt == null) return $t('auto-renews');
    const ms = a.expiresAt - Date.now();
    if (ms <= 0) return $t('auto-renews');
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? $t('in {h}h {m}m', { h, m }) : $t('in {m}m', { m });
  }

  // Compact token formatting (240.09M / 18.2k / 412) so a dense cell stays readable.
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // Cost is null for flat-rate subscriptions (unpriced) — show "—", not "$0".
  function fmtCost(n: number | null): string {
    if (n == null) return '—';
    return n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
  }

  // Friendly window labels (provider-specific keys → display).
  function windowLabel(key: string): string {
    const map: Record<string, string> = {
      '5h': '5h',
      '7d': '7d',
      '7d-opus': '7d · Opus',
      primary: $t('Primary'),
      secondary: $t('Secondary'),
    };
    return map[key] ?? key;
  }

  // Color ramp mirrors claude-relay: calm under 75%, warning to 90%, danger beyond.
  function barColor(pct: number): string {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 75) return 'bg-amber-500';
    return 'bg-indigo-500';
  }

  // "resets in 3h 12m" countdown from an absolute reset timestamp; null/elapsed ⇒ "".
  function resetIn(ms: number | null): string {
    if (ms == null) return '';
    const left = ms - Date.now();
    if (left <= 0) return '';
    const h = Math.floor(left / 3_600_000);
    const m = Math.floor((left % 3_600_000) / 60_000);
    return h > 0 ? $t('resets in {h}h {m}m', { h, m }) : $t('resets in {m}m', { m });
  }

  function onConnected(): void {
    showConnect = false;
    void invalidateAll();
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
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="page-title">{$t('Subscription Providers')}</h1>
      <p class="section-desc">
        {$t(
          'Connect Claude, ChatGPT, or GitHub Copilot subscriptions so Helm can route to them. You can connect several accounts per provider.',
        )}
      </p>
    </div>
    <button
      type="button"
      class="btn-primary shrink-0"
      disabled={!data.configured}
      onclick={() => (showConnect = true)}>{$t('Connect')}</button
    >
  </header>

  {#if error}
    <p class="alert-error" role="alert">{error}</p>
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

  {#if rows.length === 0}
    <div class="empty-state">
      <p>
        {$t(
          'No subscriptions connected yet. Click Connect to link a Claude, ChatGPT, or Copilot account.',
        )}
      </p>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="table-base">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2">{$t('Provider')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
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
            <tr class="table-row align-top">
              <!-- Provider / account + type badge -->
              <td class="px-3 py-3">
                <div class="font-medium text-ink-body">{row.provider.name}</div>
                <code class="font-mono text-xs text-ink-strong">{row.account.account}</code>
                <div class="mt-1"><span class="badge-neutral">{typeBadge(row.provider)}</span></div>
              </td>

              <!-- Status (+ parked pill) -->
              <td class="px-3 py-3">
                {#if row.account.healthy}
                  <span class="badge-ok">{$t('connected')}</span>
                {:else}
                  <span class="badge-error">{$t('needs reconnect')}</span>
                {/if}
                {#if !row.account.schedulable}
                  <div class="mt-1"><span class="badge-neutral">{$t('parked')}</span></div>
                {/if}
              </td>

              <!-- Today's usage -->
              <td class="px-3 py-3 text-xs">
                {#if usage && usage.requests > 0}
                  <div class="text-ink-body">{$t('{n} req', { n: usage.requests })}</div>
                  <div class="text-ink-muted">{fmtTokens(usage.tokens)} tok</div>
                  <div class="text-ink-muted">{fmtCost(usage.costUsd)}</div>
                  <div class="text-ink-muted">{usage.rpm} RPM</div>
                {:else}
                  <span class="text-ink-muted">—</span>
                {/if}
              </td>

              <!-- Quota / session windows -->
              <td class="px-3 py-3">
                {#if quota && quota.windows.length > 0}
                  <div class="flex w-40 flex-col gap-1.5">
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
                {:else}
                  <span class="text-xs text-ink-muted">—</span>
                {/if}
              </td>

              <!-- Priority (inline, lower = served first) -->
              <td class="px-3 py-3">
                <input
                  type="number"
                  min="0"
                  step="1"
                  class="w-16 rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
                  value={row.account.priority}
                  disabled={saving}
                  aria-label={$t('Priority')}
                  onchange={(e) =>
                    savePriority(row.provider.id, row.account.account, e.currentTarget.value)}
                />
              </td>

              <!-- Schedulable (inline toggle) -->
              <td class="px-3 py-3">
                <input
                  type="checkbox"
                  class="h-4 w-4 disabled:opacity-50"
                  checked={row.account.schedulable}
                  disabled={saving}
                  aria-label={$t('Schedulable')}
                  onchange={(e) =>
                    toggleSchedulable(row.provider.id, row.account.account, e.currentTarget.checked)}
                />
              </td>

              <!-- Token expiry -->
              <td class="px-3 py-3 text-ink-muted">{expiryLabel(row.account)}</td>

              <!-- Actions -->
              <td class="px-3 py-3 text-right">
                <div class="inline-flex gap-2">
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
                  <button
                    type="button"
                    class="btn-danger-outline"
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
</section>
