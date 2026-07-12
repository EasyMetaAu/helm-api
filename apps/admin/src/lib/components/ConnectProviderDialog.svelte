<script lang="ts">
  import { untrack } from 'svelte';
  import {
    type AccountProxyInput,
    completeManualPaste,
    type OAuthProviderStatus,
    pollDeviceCode,
    type ProxyType,
    startDeviceCode,
    startManualPaste,
  } from '$lib/api/oauth.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Connect-subscription dialog (issue #38). Mirrors CreateKeyDialog's shape so the
  // OAuth flow feels native to the admin UI. Pick a provider + an account label,
  // then run the provider's flow: manual_paste (Claude / Codex — open sign-in,
  // paste the redirect URL) or device_code (Copilot — show a code, poll). You can
  // connect several accounts per provider; each is keyed by its label.
  let {
    providers,
    onconnected,
    onclose,
  }: {
    providers: OAuthProviderStatus[];
    onconnected: () => void;
    onclose: () => void;
  } = $props();

  let providerId = $state<string>(untrack(() => providers[0]?.id ?? ''));
  let account = $state<string>('');
  let enterprise = $state<string>('');
  let error = $state<string | null>(null);
  let busy = $state<boolean>(false);
  let step = $state<'form' | 'manual' | 'device'>('form');

  // flow state
  let sessionId = $state<string>('');
  let authorizeUrl = $state<string>('');
  let paste = $state<string>('');
  let userCode = $state<string>('');
  let verificationUri = $state<string>('');

  // Optional egress proxy entered up-front (issue #38). Pinned to the login session
  // server-side so the VERY FIRST network call of the flow — and the persisted
  // account — already egress through it, never the operator's real IP. Off ⇒ direct.
  let useProxy = $state<boolean>(false);
  let proxyType = $state<ProxyType>('http');
  let proxyHost = $state<string>('');
  let proxyPort = $state<string>('');
  let proxyUser = $state<string>('');
  let proxyPass = $state<string>('');

  // Build the AccountProxyInput from the form, or null when proxy is off. Returns
  // `false` when ON but the host/port are invalid (caller surfaces an error and
  // aborts BEFORE any network call — fail-closed, no silent real-IP fallback).
  function buildProxy(): AccountProxyInput | null | false {
    if (!useProxy) return null;
    const port = Number(proxyPort);
    if (!proxyHost.trim() || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    return {
      type: proxyType,
      host: proxyHost.trim(),
      port,
      ...(proxyUser.trim() ? { username: proxyUser.trim() } : {}),
      ...(proxyPass ? { password: proxyPass } : {}),
    };
  }

  let selected = $derived(providers.find((p) => p.id === providerId));

  // Anthropic's manual-paste flow lands on a hosted console page that SHOWS the auth
  // code to copy (no dead-localhost redirect), so its copy/paste wording differs from
  // the other manual-paste provider (Codex), which still pastes a redirect URL.
  let isAnthropic = $derived(providerId === 'anthropic');
  let isXai = $derived(providerId === 'xai');

  // Suggest a unique label for the chosen provider: first is "default", then
  // account-2, account-3… (used when the operator leaves the field blank).
  let suggestion = $derived.by(() => {
    const used = new Set(selected?.accounts.map((a) => a.account) ?? []);
    if (!used.has('default')) return 'default';
    let i = 2;
    while (used.has(`account-${i}`)) i += 1;
    return `account-${i}`;
  });

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function start(): Promise<void> {
    error = null;
    const proxy = buildProxy();
    if (proxy === false) {
      error = $t('Enter a proxy host and a port between 1 and 65535.');
      return;
    }
    busy = true;
    const acct = account.trim() || suggestion;
    try {
      if (selected?.flow === 'manual_paste') {
        const s = await startManualPaste(providerId, proxy ?? undefined);
        sessionId = s.sessionId;
        authorizeUrl = s.authorizeUrl;
        account = acct;
        step = 'manual';
        window.open(s.authorizeUrl, '_blank', 'noopener');
      } else {
        const s = await startDeviceCode(
          providerId,
          enterprise.trim() || undefined,
          proxy ?? undefined,
        );
        sessionId = s.sessionId;
        userCode = s.userCode;
        verificationUri = s.verificationUri;
        account = acct;
        step = 'device';
        window.open(s.verificationUri, '_blank', 'noopener');
        void poll(s.sessionId, s.intervalMs, s.expiresAt);
      }
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  async function finishManual(): Promise<void> {
    error = null;
    busy = true;
    try {
      await completeManualPaste(providerId, { sessionId, redirectInput: paste.trim(), account });
      onconnected();
      onclose();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  async function poll(sid: string, initialDelayMs: number, expiresAt: number): Promise<void> {
    let delayMs = initialDelayMs;
    while (step === 'device' && sessionId === sid) {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(delayMs, remainingMs)));
      if (step !== 'device' || sessionId !== sid) break;
      if (Date.now() >= expiresAt) break;
      try {
        const { status } = await pollDeviceCode(providerId, { sessionId: sid, account });
        if (status === 'done') {
          onconnected();
          onclose();
          break;
        }
        if (status === 'slow_down') delayMs += 5000;
      } catch (e) {
        error = msg(e);
        break;
      }
    }
  }
</script>

<Modal label={$t('Connect a subscription')} {onclose}>
  <h2 class="section-header">{$t('Connect a subscription')}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">{error}</p>
  {/if}

  {#if step === 'form'}
    <div class="mt-3 flex flex-col gap-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Provider')}</span>
        <select bind:value={providerId} class="select" aria-label={$t('Provider')}>
          {#each providers as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <span class="field-help">
          {#if selected?.flow !== 'manual_paste'}
            {isXai
              ? $t('Authorize xAI with a one-time device code.')
              : $t('Enter a one-time device code on GitHub to authorize.')}
          {:else if isAnthropic}
            {$t('Sign in in your browser, then paste the authorization code back here.')}
          {:else}
            {$t('Sign in in your browser, then paste the redirect URL back here.')}
          {/if}
        </span>
      </label>

      {#if isXai}
        <p
          class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900"
          role="note"
        >
          {$t(
            'Experimental: use only with your own subscription. xAI does not publish a third-party OAuth contract for this flow.',
          )}
        </p>
      {/if}

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Account label')}</span>
        <input class="input" bind:value={account} placeholder={suggestion} autocomplete="off" />
        <span class="field-help">
          {$t('A name to tell multiple accounts of the same provider apart (e.g. work, personal).')}
        </span>
      </label>

      {#if selected?.flow === 'device_code' && providerId === 'github-copilot'}
        <label class="flex flex-col gap-1 text-sm">
          <span class="field-label">{$t('GitHub Enterprise domain (optional)')}</span>
          <input
            class="input"
            bind:value={enterprise}
            placeholder="github.com"
            autocomplete="off"
          />
        </label>
      {/if}

      <!-- Egress proxy (issue #38): collected up-front so the FIRST sign-in call
           already tunnels through it — the operator's real IP is never exposed. -->
      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="checkbox" bind:checked={useProxy} />
          <span class="field-label">{$t('Use a proxy (optional)')}</span>
        </label>
        {#if useProxy}
          <span class="field-help">
            {$t(
              "Routes the gateway's calls to this provider (token exchange, refresh, API traffic) and is saved to this account. The sign-in page you open in your browser is not proxied.",
            )}
          </span>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="field-label">{$t('Type')}</span>
              <select class="select" bind:value={proxyType}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="field-label">{$t('Host')}</span>
              <input class="input" type="text" placeholder="10.0.0.1" bind:value={proxyHost} />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="field-label">{$t('Port')}</span>
              <input
                class="input"
                type="number"
                min="1"
                max="65535"
                placeholder="1080"
                bind:value={proxyPort}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="field-label">{$t('Username (optional)')}</span>
              <input class="input" type="text" autocomplete="off" bind:value={proxyUser} />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="field-label">{$t('Password (optional)')}</span>
              <input class="input" type="password" autocomplete="off" bind:value={proxyPass} />
            </label>
          </div>
        {/if}
      </div>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
      <button type="button" class="btn-primary" disabled={busy || !providerId} onclick={start}>
        {busy ? $t('Starting…') : $t('Start sign-in')}
      </button>
    </div>
  {:else if step === 'manual'}
    <ol class="mt-3 ml-4 list-decimal text-sm text-ink-body">
      <li>{$t('A sign-in page opened in a new tab — approve access there.')}</li>
      <li>
        {isAnthropic
          ? $t('Copy the authorization code shown on the page, and paste it below.')
          : $t('Copy the full URL it redirects to, and paste it below.')}
      </li>
    </ol>
    <a
      class="mt-1 inline-block text-xs text-blue-600 hover:underline"
      href={authorizeUrl}
      target="_blank"
      rel="noopener"
    >
      {$t("Didn't open? Reopen the sign-in page")}
    </a>
    <textarea
      class="input mt-2 font-mono text-xs"
      rows="2"
      bind:value={paste}
      placeholder={isAnthropic
        ? $t('Paste the authorization code')
        : 'http://localhost/...?code=…&state=…'}
    ></textarea>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
      <button
        type="button"
        class="btn-success"
        disabled={busy || !paste.trim()}
        onclick={finishManual}
      >
        {busy ? $t('Finishing…') : $t('Finish')}
      </button>
    </div>
  {:else}
    <p class="mt-3 text-sm text-ink-body">
      {$t('Enter this code at')}
      <a class="text-blue-600 hover:underline" href={verificationUri} target="_blank" rel="noopener"
        >{verificationUri}</a
      >:
    </p>
    <p
      class="mt-2 select-all text-center font-mono text-2xl font-semibold tracking-[0.3em] text-ink-strong"
    >
      {userCode}
    </p>
    <div class="mt-4 flex items-center justify-between">
      <span class="inline-flex items-center gap-2 text-xs text-ink-muted">
        <span class="h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
        {$t('Waiting for authorization…')}
      </span>
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
    </div>
  {/if}
</Modal>
