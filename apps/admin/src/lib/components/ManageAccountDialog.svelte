<script lang="ts">
  import {
    type AccountProxyInput,
    type ProxyType,
    getAccountModels,
    getAccountProxy,
    getAccountSchedule,
    setAccountModels,
    setAccountProxy,
    setAccountSchedule,
  } from '$lib/api/oauth.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Per-account management dialog (account-pool feature, issue #38 follow-up).
  // Groups every per-account control of ONE connected subscription account into a
  // single sectioned card — Models / Proxy / Schedule — instead of three separate
  // inline panels on the table. Pure consumer (CLAUDE.md Principle 1): the gateway
  // owns the encrypted settings; this dialog only reads/writes via the admin API.
  // It bubbles a `onsaved` once any section persisted (the page invalidates so the
  // Lanes catalog reflects the new exposure / pool membership) and `onclose` to
  // dismiss. The dialog is remounted per account ({#if} in the page), so the per-
  // section state below is a fresh editing buffer each time.
  let {
    providerId,
    providerName,
    account,
    onsaved,
    onclose,
  }: {
    providerId: string;
    providerName: string;
    account: string;
    onsaved: () => void;
    onclose: () => void;
  } = $props();

  type Section = 'models' | 'proxy' | 'schedule';
  let section = $state<Section>('models');
  // Set once a section persists, so the parent invalidates exactly when needed.
  let dirty = false;

  function close(): void {
    if (dirty) onsaved();
    else onclose();
  }

  // ── Models ──────────────────────────────────────────────────────────────────
  // An EDITABLE list of model ids this account exposes to Lanes. Discovery (live
  // for Copilot/Anthropic, curated for Codex) only SEEDS suggestions — the saved
  // list is authoritative, so the operator can add ids discovery missed (stale
  // catalogs), edit, or remove. "Pull from provider" merges in current suggestions.
  let modelsLoading = $state<boolean>(true);
  let modelsSaving = $state<boolean>(false);
  let modelsError = $state<string | null>(null);
  let suggestions = $state<string[]>([]); // discovered — offered via "Pull"
  let models = $state<string[]>([]); // the authoritative, editable list
  let newModel = $state<string>('');
  // Whether this provider has a live list-models API. Codex doesn't, so "Pull
  // from provider" is hidden for it (there is nothing live to pull).
  let canPull = $state<boolean>(false);

  async function loadModels(): Promise<void> {
    modelsError = null;
    modelsLoading = true;
    suggestions = [];
    models = [];
    canPull = false;
    try {
      const res = await getAccountModels(providerId, account);
      suggestions = res.available;
      models = [...res.enabled];
      canPull = res.canPull;
    } catch (e) {
      modelsError = e instanceof Error ? e.message : $t('Failed to load models');
    } finally {
      modelsLoading = false;
    }
  }

  function addModel(): void {
    const id = newModel.trim();
    if (id && !models.includes(id)) models = [...models, id];
    newModel = '';
  }

  function removeModel(index: number): void {
    models = models.filter((_, i) => i !== index);
  }

  // Merge any discovered suggestion not already in the list (keeps the operator's
  // edits, just tops up with what the provider currently reports).
  function pullFromProvider(): void {
    const merged = [...models];
    for (const s of suggestions) if (!merged.includes(s.trim())) merged.push(s);
    models = merged;
  }

  async function saveModels(): Promise<void> {
    modelsError = null;
    modelsSaving = true;
    try {
      const clean = [...new Set(models.map((m) => m.trim()).filter((m) => m.length > 0))];
      await setAccountModels(providerId, account, clean);
      models = clean;
      dirty = true;
    } catch (e) {
      modelsError = e instanceof Error ? e.message : $t('Failed to save models');
    } finally {
      modelsSaving = false;
    }
  }

  // ── Proxy ─────────────────────────────────────────────────────────────────────
  // Pin an http/https/socks5 proxy so this account's upstream traffic egresses from
  // a distinct IP (avoids ban-correlation when several accounts share a host).
  // `proxyHasStored` reflects a password the gateway redacted from the read; leaving
  // the field blank on save preserves it.
  let proxyLoading = $state<boolean>(true);
  let proxySaving = $state<boolean>(false);
  let proxyError = $state<string | null>(null);
  let proxyType = $state<ProxyType>('http');
  let proxyHost = $state<string>('');
  let proxyPort = $state<string>('');
  let proxyUser = $state<string>('');
  let proxyPass = $state<string>('');
  let proxyHasStored = $state<boolean>(false);
  let proxyConfigured = $state<boolean>(false);

  async function loadProxy(): Promise<void> {
    proxyError = null;
    proxyLoading = true;
    proxyType = 'http';
    proxyHost = '';
    proxyPort = '';
    proxyUser = '';
    proxyPass = '';
    proxyHasStored = false;
    proxyConfigured = false;
    try {
      const p = await getAccountProxy(providerId, account);
      if (p) {
        proxyType = p.type;
        proxyHost = p.host;
        proxyPort = String(p.port);
        proxyUser = p.username ?? '';
        proxyHasStored = p.hasPassword;
        proxyConfigured = true;
      }
    } catch (e) {
      proxyError = e instanceof Error ? e.message : $t('Failed to load proxy');
    } finally {
      proxyLoading = false;
    }
  }

  async function saveProxy(): Promise<void> {
    proxyError = null;
    const port = Number(proxyPort);
    if (!proxyHost.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      proxyError = $t('Enter a host and a port between 1 and 65535.');
      return;
    }
    proxySaving = true;
    try {
      const input: AccountProxyInput = {
        type: proxyType,
        host: proxyHost.trim(),
        port,
        ...(proxyUser.trim() ? { username: proxyUser.trim() } : {}),
        // Send the password ONLY when the operator typed one (blank preserves the
        // stored secret the gateway redacted from the read).
        ...(proxyPass ? { password: proxyPass } : {}),
      };
      await setAccountProxy(providerId, account, input);
      proxyConfigured = true;
      proxyHasStored = proxyHasStored || proxyPass.length > 0;
      proxyPass = '';
      dirty = true;
    } catch (e) {
      proxyError = e instanceof Error ? e.message : $t('Failed to save proxy');
    } finally {
      proxySaving = false;
    }
  }

  async function clearProxy(): Promise<void> {
    proxyError = null;
    proxySaving = true;
    try {
      await setAccountProxy(providerId, account, null);
      proxyConfigured = false;
      proxyHasStored = false;
      proxyHost = '';
      proxyPort = '';
      proxyUser = '';
      proxyPass = '';
      dirty = true;
    } catch (e) {
      proxyError = e instanceof Error ? e.message : $t('Failed to clear proxy');
    } finally {
      proxySaving = false;
    }
  }

  // ── Schedule ──────────────────────────────────────────────────────────────────
  // When a provider has several accounts the gateway pools them: a lower priority
  // is served first, round-robin (LRU) within an equal priority; an unschedulable
  // account is parked (kept connected, never routed).
  let scheduleLoading = $state<boolean>(true);
  let scheduleSaving = $state<boolean>(false);
  let scheduleError = $state<string | null>(null);
  let priority = $state<string>('50');
  let schedulable = $state<boolean>(true);
  // Codex only: auto-consume a reset credit the moment the weekly window saturates.
  const isCodex = $derived(providerId === 'openai-codex');
  let autoReset = $state<boolean>(false);

  async function loadSchedule(): Promise<void> {
    scheduleError = null;
    scheduleLoading = true;
    priority = '50';
    schedulable = true;
    autoReset = false;
    try {
      const s = await getAccountSchedule(providerId, account);
      priority = String(s.priority);
      schedulable = s.schedulable;
      autoReset = s.autoReset;
    } catch (e) {
      scheduleError = e instanceof Error ? e.message : $t('Failed to load schedule');
    } finally {
      scheduleLoading = false;
    }
  }

  async function saveSchedule(): Promise<void> {
    scheduleError = null;
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0) {
      scheduleError = $t('Priority must be a whole number ≥ 0.');
      return;
    }
    scheduleSaving = true;
    try {
      await setAccountSchedule(providerId, account, { priority: p, schedulable, autoReset });
      dirty = true;
    } catch (e) {
      scheduleError = e instanceof Error ? e.message : $t('Failed to save schedule');
    } finally {
      scheduleSaving = false;
    }
  }

  // (Re)load every section whenever the TARGET ACCOUNT changes — not just at mount.
  // The page may reuse this dialog for a different account without unmounting it, so
  // a one-shot load would leave the previous account's models/proxy/schedule on
  // screen. Tracking providerId+account here re-fetches on every switch.
  $effect(() => {
    void providerId;
    void account;
    void loadModels();
    void loadProxy();
    void loadSchedule();
  });
</script>

<Modal label={$t('Manage account')} onclose={close}>
  <div class="flex flex-col gap-4">
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="section-header">{$t('Manage account')}</h2>
        <p class="field-help">
          {providerName} · <code class="font-mono">{account}</code>
        </p>
      </div>
      <button type="button" class="btn-icon shrink-0" aria-label={$t('Close')} onclick={close}>
        <svg
          class="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.8"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </header>

    <!-- Section switcher: one tab per control group so the dialog stays compact. -->
    <div
      class="flex gap-2 border-b border-slate-200"
      role="tablist"
      aria-label={$t('Manage account')}
    >
      <button
        type="button"
        role="tab"
        class="tab-btn"
        aria-selected={section === 'models'}
        onclick={() => (section = 'models')}>{$t('Models')}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn"
        aria-selected={section === 'proxy'}
        onclick={() => (section = 'proxy')}>{$t('Proxy')}</button
      >
      <button
        type="button"
        role="tab"
        class="tab-btn"
        aria-selected={section === 'schedule'}
        onclick={() => (section = 'schedule')}>{$t('Schedule')}</button
      >
    </div>

    {#if section === 'models'}
      <div class="flex flex-col gap-3">
        <p class="field-help">
          {$t(
            'The models this account exposes to Lanes. This list is authoritative — add, edit, or remove ids freely. Use “Pull from provider” to seed it with what the provider currently reports.',
          )}
        </p>
        {#if modelsError}
          <p class="alert-error" role="alert">{modelsError}</p>
        {:else if modelsLoading}
          <p class="text-sm text-ink-muted">{$t('Loading models…')}</p>
        {:else}
          <div class="flex flex-col gap-0.5">
            {#each models as _model, i (i)}
              <div
                class="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-slate-100"
              >
                <input
                  type="text"
                  class="input flex-1 font-mono text-xs"
                  bind:value={models[i]}
                  spellcheck="false"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="btn-danger-outline shrink-0"
                  aria-label={$t('Remove model')}
                  onclick={() => removeModel(i)}>{$t('Remove')}</button
                >
              </div>
            {/each}
            {#if models.length === 0}
              <p class="text-sm text-ink-muted">
                {$t('No models yet. Add one below or pull from the provider.')}
              </p>
            {/if}
          </div>

          <div class="flex items-center gap-2">
            <input
              type="text"
              class="input flex-1 font-mono text-xs"
              placeholder={$t('Add a model id…')}
              bind:value={newModel}
              spellcheck="false"
              autocomplete="off"
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addModel();
                }
              }}
            />
            <button type="button" class="btn-secondary shrink-0" onclick={addModel}
              >{$t('Add')}</button
            >
          </div>

          <div class="card-actions">
            {#if canPull}
              <button
                type="button"
                class="btn-secondary"
                disabled={suggestions.length === 0}
                onclick={pullFromProvider}
                >{$t('Pull from provider ({n})', { n: suggestions.length })}</button
              >
            {/if}
            <button
              type="button"
              class="btn-primary-sm"
              disabled={modelsSaving}
              onclick={saveModels}>{modelsSaving ? $t('Saving…') : $t('Save')}</button
            >
          </div>
        {/if}
      </div>
    {:else if section === 'proxy'}
      <div class="flex flex-col gap-3">
        <p class="field-help">
          {$t(
            'Route this account’s upstream traffic through a proxy so it egresses from a distinct IP. Leave unset for a direct connection.',
          )}
        </p>
        {#if proxyError}
          <p class="alert-error" role="alert">{proxyError}</p>
        {/if}
        {#if proxyLoading}
          <p class="text-sm text-ink-muted">{$t('Loading proxy…')}</p>
        {:else}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="field">
              <span class="field-label">{$t('Type')}</span>
              <select class="select" bind:value={proxyType}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{$t('Host')}</span>
              <input class="input" type="text" placeholder="10.0.0.1" bind:value={proxyHost} />
            </label>
            <label class="field">
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
            <label class="field">
              <span class="field-label">{$t('Username (optional)')}</span>
              <input class="input" type="text" bind:value={proxyUser} />
            </label>
            <label class="field">
              <span class="field-label">{$t('Password (optional)')}</span>
              <input
                class="input"
                type="password"
                placeholder={proxyHasStored ? $t('•••••• (unchanged)') : ''}
                bind:value={proxyPass}
              />
            </label>
          </div>
          <div class="card-actions">
            {#if proxyConfigured}
              <button
                type="button"
                class="btn-danger-outline"
                disabled={proxySaving}
                onclick={clearProxy}>{$t('Clear proxy')}</button
              >
            {/if}
            <button type="button" class="btn-primary-sm" disabled={proxySaving} onclick={saveProxy}
              >{proxySaving ? $t('Saving…') : $t('Save')}</button
            >
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex flex-col gap-3">
        <p class="field-help">
          {$t(
            'When a provider has several accounts, Helm pools them: a lower priority is served first, with round-robin within an equal priority. Parking an account keeps it connected but out of routing.',
          )}
        </p>
        {#if scheduleError}
          <p class="alert-error" role="alert">{scheduleError}</p>
        {/if}
        {#if scheduleLoading}
          <p class="text-sm text-ink-muted">{$t('Loading schedule…')}</p>
        {:else}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="field">
              <span class="field-label">{$t('Priority (lower = preferred)')}</span>
              <input
                class="input"
                type="number"
                min="0"
                step="1"
                placeholder="50"
                bind:value={priority}
              />
            </label>
            <label class="checkbox-field self-end pb-2">
              <input type="checkbox" class="checkbox" bind:checked={schedulable} />
              <span class="text-sm text-ink-body">{$t('Schedulable (in rotation)')}</span>
            </label>
          </div>
          {#if isCodex}
            <label class="checkbox-field" data-testid="auto-reset-toggle">
              <input type="checkbox" class="checkbox" bind:checked={autoReset} />
              <span class="text-sm text-ink-body"
                >{$t('Auto-reset the weekly limit when it hits 100%')}</span
              >
            </label>
            <p class="field-help">
              {$t(
                'When the weekly limit saturates, Helm automatically spends one reset credit to restore it (at most once per hour). Reset credits are limited, so leave this off if you want to spend them manually.',
              )}
            </p>
          {/if}
          <div class="card-actions">
            <button
              type="button"
              class="btn-primary-sm"
              disabled={scheduleSaving}
              onclick={saveSchedule}>{scheduleSaving ? $t('Saving…') : $t('Save')}</button
            >
          </div>
        {/if}
      </div>
    {/if}
  </div>
</Modal>
