<script lang="ts">
  import { untrack } from 'svelte';
  import {
    completeManualPaste,
    type OAuthProviderStatus,
    pollDeviceCode,
    startDeviceCode,
    startManualPaste,
  } from '$lib/api/oauth.js';
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

  let selected = $derived(providers.find((p) => p.id === providerId));

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
    busy = true;
    const acct = account.trim() || suggestion;
    try {
      if (selected?.flow === 'manual_paste') {
        const s = await startManualPaste(providerId);
        sessionId = s.sessionId;
        authorizeUrl = s.authorizeUrl;
        account = acct;
        step = 'manual';
        window.open(s.authorizeUrl, '_blank', 'noopener');
      } else {
        const s = await startDeviceCode(providerId, enterprise.trim() || undefined);
        sessionId = s.sessionId;
        userCode = s.userCode;
        verificationUri = s.verificationUri;
        account = acct;
        step = 'device';
        window.open(s.verificationUri, '_blank', 'noopener');
        void poll(s.sessionId);
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

  async function poll(sid: string): Promise<void> {
    while (step === 'device' && sessionId === sid) {
      await new Promise((r) => setTimeout(r, 5000));
      if (step !== 'device' || sessionId !== sid) break;
      try {
        const { status } = await pollDeviceCode(providerId, { sessionId: sid, account });
        if (status === 'done') {
          onconnected();
          onclose();
          break;
        }
      } catch (e) {
        error = msg(e);
        break;
      }
    }
  }
</script>

<div class="dialog" role="dialog" aria-label={$t('Connect a subscription')}>
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
          {selected?.flow === 'manual_paste'
            ? $t('Sign in in your browser, then paste the redirect URL back here.')
            : $t('Enter a one-time device code on GitHub to authorize.')}
        </span>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Account label')}</span>
        <input class="input" bind:value={account} placeholder={suggestion} autocomplete="off" />
        <span class="field-help">
          {$t('A name to tell multiple accounts of the same provider apart (e.g. work, personal).')}
        </span>
      </label>

      {#if selected?.flow === 'device_code'}
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
      <li>{$t('Copy the full URL it redirects to, and paste it below.')}</li>
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
      placeholder="http://localhost/...?code=…&state=…"
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
</div>
