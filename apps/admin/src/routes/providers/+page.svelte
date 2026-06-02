<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    completeManualPaste,
    type OAuthProviderStatus,
    pollDeviceCode,
    logoutOAuth,
    startDeviceCode,
    startManualPaste,
  } from '$lib/api/oauth.js';
  import { t } from '$lib/i18n';

  // Subscription OAuth login (issue #38). Pure consumer (Principle 1): the gateway
  // owns the flow + token storage; this page only drives it. Two flows:
  //   - manual_paste (Claude Pro/Max): open the authorize URL, paste the redirect.
  //   - device_code (Copilot): show a user code, poll until authorized.
  let { data }: { data: { configured: boolean; providers: OAuthProviderStatus[]; loadError?: string } } =
    $props();

  let error = $state<string | null>(untrack(() => data.loadError ?? null));
  let busy = $state<string | null>(null); // provider id currently mid-flow

  // manual-paste working state.
  let manual = $state<{ provider: string; sessionId: string; authorizeUrl: string } | null>(null);
  let pasteValue = $state('');

  // device-code working state.
  let device = $state<{
    provider: string;
    sessionId: string;
    userCode: string;
    verificationUri: string;
  } | null>(null);
  let devicePolling = $state(false);

  function fmtExpiry(ms: number | null): string {
    if (ms == null) return '—';
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  async function refresh(): Promise<void> {
    await invalidateAll();
  }

  // ── manual-paste (Anthropic) ──────────────────────────────────────────────
  async function beginManual(provider: string): Promise<void> {
    error = null;
    busy = provider;
    try {
      const start = await startManualPaste(provider);
      manual = { provider, sessionId: start.sessionId, authorizeUrl: start.authorizeUrl };
      pasteValue = '';
      window.open(start.authorizeUrl, '_blank', 'noopener');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to start login';
    } finally {
      busy = null;
    }
  }

  async function submitManual(): Promise<void> {
    if (!manual) return;
    error = null;
    busy = manual.provider;
    try {
      await completeManualPaste(manual.provider, {
        sessionId: manual.sessionId,
        redirectInput: pasteValue.trim(),
      });
      manual = null;
      pasteValue = '';
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to complete login';
    } finally {
      busy = null;
    }
  }

  // ── device-code (Copilot) ─────────────────────────────────────────────────
  async function beginDevice(provider: string): Promise<void> {
    error = null;
    busy = provider;
    try {
      const start = await startDeviceCode(provider);
      device = {
        provider,
        sessionId: start.sessionId,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
      };
      window.open(start.verificationUri, '_blank', 'noopener');
      void pollDevice();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to start device login';
    } finally {
      busy = null;
    }
  }

  async function pollDevice(): Promise<void> {
    if (!device || devicePolling) return;
    devicePolling = true;
    try {
      // Poll until authorized or the session expires (the gateway 400s on expiry).
      while (device) {
        await new Promise((r) => setTimeout(r, 5000));
        if (!device) break;
        const { status } = await pollDeviceCode(device.provider, { sessionId: device.sessionId });
        if (status === 'done') {
          device = null;
          await refresh();
          break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Device login failed';
      device = null;
    } finally {
      devicePolling = false;
    }
  }

  async function disconnect(provider: string, account: string): Promise<void> {
    error = null;
    busy = provider;
    try {
      await logoutOAuth(provider, account);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to disconnect';
    } finally {
      busy = null;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-2">
    <h1 class="page-title">{$t('Subscription Providers')}</h1>
    <p class="section-desc">
      {$t('Connect a Claude Pro/Max or GitHub Copilot subscription so Helm can route to it.')}
    </p>
  </header>

  {#if error}
    <div class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </div>
  {/if}

  {#if !data.configured}
    <div class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      {$t('OAuth login is disabled: set HELM_OAUTH_ENC_KEY (32 bytes) to enable encrypted token storage.')}
    </div>
  {/if}

  <div class="flex flex-col gap-3">
    {#each data.providers as p (p.id)}
      <article class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="font-medium text-zinc-900">{p.name}</h2>
            <p class="text-xs text-zinc-500">
              {p.flow === 'manual_paste' ? $t('Browser login + paste redirect URL') : $t('Device code')}
            </p>
          </div>
          {#if data.configured}
            <button
              class="btn-primary"
              disabled={busy === p.id}
              onclick={() => (p.flow === 'manual_paste' ? beginManual(p.id) : beginDevice(p.id))}
            >
              {busy === p.id ? $t('Working…') : $t('Connect')}
            </button>
          {/if}
        </div>

        {#if p.accounts.length > 0}
          <ul class="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3">
            {#each p.accounts as acct (acct.account)}
              <li class="flex items-center justify-between text-sm">
                <span class="text-zinc-700">
                  <span class="font-mono">{acct.account}</span>
                  <span class="ml-2 text-xs text-zinc-400">
                    {$t('expires')}: {fmtExpiry(acct.expiresAt)}
                  </span>
                </span>
                <button
                  class="text-xs text-red-600 hover:underline"
                  disabled={busy === p.id}
                  onclick={() => disconnect(p.id, acct.account)}
                >
                  {$t('Disconnect')}
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-xs text-zinc-400">{$t('Not connected')}</p>
        {/if}

        <!-- manual-paste step (Anthropic) -->
        {#if manual && manual.provider === p.id}
          <div class="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3">
            <p class="text-xs text-zinc-600">
              {$t('A login tab opened. After approving, paste the full redirect URL (or code) here:')}
            </p>
            <a class="text-xs text-blue-600 hover:underline" href={manual.authorizeUrl} target="_blank" rel="noopener">
              {$t('Reopen login page')}
            </a>
            <textarea
              class="w-full rounded border border-zinc-300 p-2 font-mono text-xs"
              rows="2"
              bind:value={pasteValue}
              placeholder="http://localhost:53692/callback?code=…&state=…"
            ></textarea>
            <div class="flex gap-2">
              <button class="btn-primary" disabled={busy === p.id || !pasteValue.trim()} onclick={submitManual}>
                {$t('Finish')}
              </button>
              <button class="text-xs text-zinc-500 hover:underline" onclick={() => (manual = null)}>
                {$t('Cancel')}
              </button>
            </div>
          </div>
        {/if}

        <!-- device-code step (Copilot) -->
        {#if device && device.provider === p.id}
          <div class="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3">
            <p class="text-xs text-zinc-600">
              {$t('Enter this code at')}
              <a class="text-blue-600 hover:underline" href={device.verificationUri} target="_blank" rel="noopener">
                {device.verificationUri}
              </a>
            </p>
            <p class="font-mono text-lg tracking-widest text-zinc-900">{device.userCode}</p>
            <p class="text-xs text-zinc-400">
              {devicePolling ? $t('Waiting for authorization…') : ''}
            </p>
            <button class="text-xs text-zinc-500 hover:underline" onclick={() => (device = null)}>
              {$t('Cancel')}
            </button>
          </div>
        {/if}
      </article>
    {/each}
  </div>
</section>
