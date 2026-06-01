<script lang="ts">
  import { untrack } from 'svelte';
  import { type ApiKeyView, revokeKey, updateKeyRateLimit } from '$lib/api/keys.js';
  import CreateKeyDialog from '$lib/components/CreateKeyDialog.svelte';
  import { t } from '$lib/i18n';

  // API key management view. HARD security line (CLAUDE.md 原则7 / docs/06): the
  // list shows ONLY the display prefix + sha256-backed reference — never plaintext.
  // The plaintext is shown once by the create dialog at mint time, then wiped.
  // Revocation is a SOFT disable (server flips disabled:true) — the row is kept,
  // never removed or rewritten in place (轮转/吊销审计可追溯). This view is a pure
  // consumer of /admin/api/* — it owns no auth logic and persists no credentials.
  let { data }: { data: { keys: ApiKeyView[]; lanes: string[] } } = $props();

  let keys = $state<ApiKeyView[]>(untrack(() => data.keys));
  const lanes = untrack(() => data.lanes);

  let error = $state<string | null>(null);
  let showCreate = $state<boolean>(false);
  // The key_id currently pending a revoke confirmation, if any.
  let confirmingRevoke = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  // The display prefix of the key pending revoke confirmation — purely for copy.
  let confirmingPrefix = $derived(keys.find((k) => k.key_id === confirmingRevoke)?.prefix ?? '');

  // Inline per-key rate-limit editing. `editingLimits` holds the key_id under edit
  // (one row at a time); the two inputs are raw strings ('' = clear → inherit).
  let editingLimits = $state<string | null>(null);
  // number | null: null = clear → inherit the system default; a number input binds
  // to number|null (empty field => null), so no string parsing is needed.
  let editRpm = $state<number | null>(null);
  let editTpm = $state<number | null>(null);
  let savingLimits = $state<string | null>(null);

  // Render a stored limit for display: a number as-is (0 → "unlimited"), null as
  // the inherit/"default" copy.
  function limitLabel(v: number | null): string {
    if (v === null) return $t('Default');
    return v === 0 ? $t('Unlimited') : String(v);
  }

  function startEditLimits(key: ApiKeyView): void {
    error = null;
    editingLimits = key.key_id;
    editRpm = key.rate_limit_rpm;
    editTpm = key.rate_limit_tpm;
  }

  function cancelEditLimits(): void {
    editingLimits = null;
  }

  async function saveLimits(keyId: string): Promise<void> {
    error = null;
    savingLimits = keyId;
    // Svelte 5 binds an emptied number input to `undefined` (not null); normalize
    // so a cleared field is sent as an explicit null (clear → inherit default),
    // never omitted by JSON.stringify (which would silently keep the old value).
    const rpm = editRpm ?? null;
    const tpm = editTpm ?? null;
    try {
      await updateKeyRateLimit(keyId, { rpm, tpm });
      keys = keys.map((k) =>
        k.key_id === keyId ? { ...k, rate_limit_rpm: rpm, rate_limit_tpm: tpm } : k,
      );
      editingLimits = null;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update rate limit');
    } finally {
      savingLimits = null;
    }
  }

  function onCreated(view: ApiKeyView): void {
    // Append the new key by its redacted view (prefix only). It is also re-fetched
    // on next load; here we just reflect it immediately. NEVER any plaintext.
    keys = [...keys, view];
  }

  function askRevoke(keyId: string): void {
    error = null;
    confirmingRevoke = keyId;
  }

  function cancelRevoke(): void {
    confirmingRevoke = null;
  }

  async function confirmRevoke(): Promise<void> {
    const keyId = confirmingRevoke;
    if (!keyId) return;
    error = null;
    revoking = keyId;
    try {
      await revokeKey(keyId);
      // Soft disable: flip the local row to disabled, NEVER remove it.
      keys = keys.map((k) => (k.key_id === keyId ? { ...k, disabled: true } : k));
      confirmingRevoke = null;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to revoke key');
    } finally {
      revoking = null;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="page-title">{$t('API Keys')}</h1>
      <p class="section-desc">
        {$t(
          'An API key authenticates a client and can cap the top lane it is allowed to reach. Keys are stored as a hash plus a short display prefix — the full key is shown only once, at creation.',
        )}
      </p>
    </div>
    <button type="button" class="btn-primary shrink-0" onclick={() => (showCreate = true)}
      >{$t('New key')}</button
    >
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if showCreate}
    <CreateKeyDialog {lanes} oncreated={onCreated} onclose={() => (showCreate = false)} />
  {/if}

  {#if keys.length === 0}
    <div class="empty-state">
      <p>{$t('No API keys yet. Create one to let a client authenticate against the gateway.')}</p>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="table-base">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2">{$t('Key (prefix)')}</th>
            <th class="px-3 py-2">{$t('Role')}</th>
            <th class="px-3 py-2">{$t('Caps')}</th>
            <th class="px-3 py-2">{$t('Rate limit')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each keys as key (key.key_id)}
            <tr data-testid="key-row" class="table-row align-top">
              <td class="px-3 py-2">
                <code class="font-mono text-ink-strong">{key.prefix}</code>
              </td>
              <td class="px-3 py-2">
                <span class="text-ink-body">{key.role}</span>
                {#if key.role === 'root'}
                  <p
                    data-testid="root-warning"
                    class="mt-1 w-44 whitespace-normal text-xs text-amber-700"
                  >
                    {$t('Management plane only — do not feed production traffic.')}
                  </p>
                {/if}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                <div>{$t('Max lane')}: {key.max_lane ?? $t('No cap')}</div>
                <div>{$t('Allowed lanes')}: {key.allowed_lanes?.join(', ') || $t('No cap')}</div>
                <div>{$t('Custom model')}: {key.allow_custom_model ? $t('yes') : $t('no')}</div>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {#if editingLimits === key.key_id}
                  <div class="flex flex-col gap-2">
                    <label class="flex items-center gap-2">
                      <span class="w-12 text-xs">{$t('RPM')}</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={$t('RPM')}
                        placeholder={$t('Default')}
                        class="w-24 rounded border border-slate-300 px-2 py-1"
                        bind:value={editRpm}
                      />
                    </label>
                    <label class="flex items-center gap-2">
                      <span class="w-12 text-xs">{$t('TPM')}</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={$t('TPM')}
                        placeholder={$t('Default')}
                        class="w-24 rounded border border-slate-300 px-2 py-1"
                        bind:value={editTpm}
                      />
                    </label>
                    <div class="flex gap-2">
                      <button
                        type="button"
                        class="btn-primary-sm"
                        disabled={savingLimits === key.key_id}
                        onclick={() => saveLimits(key.key_id)}>{$t('Save')}</button
                      >
                      <button type="button" class="btn-secondary" onclick={cancelEditLimits}
                        >{$t('Cancel')}</button
                      >
                    </div>
                  </div>
                {:else}
                  <div>{$t('RPM')}: {limitLabel(key.rate_limit_rpm)}</div>
                  <div>{$t('TPM')}: {limitLabel(key.rate_limit_tpm)}</div>
                  {#if !key.disabled}
                    <button
                      type="button"
                      class="mt-1 text-xs text-indigo-600 hover:underline"
                      onclick={() => startEditLimits(key)}>{$t('Edit limits')}</button
                    >
                  {/if}
                {/if}
              </td>
              <td class="px-3 py-2">
                {#if key.disabled}
                  <span class="badge-neutral">{$t('disabled')}</span>
                {:else}
                  <span class="badge-ok">{$t('active')}</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-right">
                {#if !key.disabled}
                  <button
                    type="button"
                    class="btn-danger-outline"
                    disabled={revoking === key.key_id}
                    onclick={() => askRevoke(key.key_id)}>{$t('Revoke')}</button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if confirmingRevoke}
    <div class="alert-warn" role="dialog" aria-label={$t('Confirm revoke')}>
      <p class="text-sm text-amber-800">
        {$t('Revoke key')}
        <code class="font-mono">{confirmingPrefix}</code>{$t(
          '? It will be disabled (kept for audit, not deleted). Mint a fresh key to rotate.',
        )}
      </p>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={revoking === confirmingRevoke}
          onclick={cancelRevoke}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="btn-danger"
          disabled={revoking === confirmingRevoke}
          onclick={confirmRevoke}
          >{revoking === confirmingRevoke ? $t('Revoking…') : $t('Confirm revoke')}</button
        >
      </div>
    </div>
  {/if}
</section>
