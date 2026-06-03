<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { logoutOAuth, type OAuthAccount, type OAuthProviderStatus } from '$lib/api/oauth.js';
  import ConnectProviderDialog from '$lib/components/ConnectProviderDialog.svelte';
  import ManageAccountDialog from '$lib/components/ManageAccountDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Subscription OAuth login (issue #38). Pure consumer (Principle 1): the gateway
  // owns the flow + encrypted token storage; this page just lists connected
  // accounts, opens the Connect dialog, and the per-account Manage dialog (model
  // curation / egress proxy / pool scheduling). Multiple accounts per provider are
  // supported (the store is keyed by provider + account label).
  let {
    data,
  }: { data: { configured: boolean; providers: OAuthProviderStatus[]; loadError?: string } } =
    $props();

  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let showConnect = $state<boolean>(false);
  // The account whose Manage dialog is open ({#if} remounts it per selection so the
  // dialog's per-section editing buffers reset cleanly each time).
  let managing = $state<{ providerId: string; providerName: string; account: string } | null>(null);
  let confirming = $state<{ providerId: string; account: string } | null>(null);
  let disconnecting = $state<boolean>(false);

  // One table row per connected account, flattened across providers.
  let rows = $derived(
    data.providers.flatMap((p) => p.accounts.map((account) => ({ provider: p, account }))),
  );

  function providerName(id: string): string {
    return data.providers.find((p) => p.id === id)?.name ?? id;
  }

  // The access token is short-lived and auto-renewed by the gateway, so a lapsed
  // one is NOT an alarm — show "auto-renews" rather than a scary "expired". When
  // valid, show the remaining time as a hint of when it next renews.
  function expiryLabel(a: OAuthAccount): string {
    if (a.expiresAt == null) return $t('auto-renews');
    const ms = a.expiresAt - Date.now();
    if (ms <= 0) return $t('auto-renews');
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? $t('in {h}h {m}m', { h, m }) : $t('in {m}m', { m });
  }

  function onConnected(): void {
    showConnect = false;
    void invalidateAll();
  }

  // The Manage dialog persists each section itself; on close it tells us whether any
  // section changed so we invalidate exactly once (the Lanes catalog / pool reflect
  // the new model exposure + schedulable membership).
  function onManaged(): void {
    managing = null;
    void invalidateAll();
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
            <th class="px-3 py-2">{$t('Account')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
            <th class="px-3 py-2">{$t('Expires')}</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.provider.id + '/' + row.account.account)}
            <tr class="table-row">
              <td class="px-3 py-2 text-ink-body">{row.provider.name}</td>
              <td class="px-3 py-2">
                <code class="font-mono text-ink-strong">{row.account.account}</code>
              </td>
              <td class="px-3 py-2">
                {#if row.account.healthy}
                  <span class="badge-ok">{$t('connected')}</span>
                {:else}
                  <span class="badge-neutral">{$t('needs reconnect')}</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-ink-muted">{expiryLabel(row.account)}</td>
              <td class="px-3 py-2 text-right">
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
