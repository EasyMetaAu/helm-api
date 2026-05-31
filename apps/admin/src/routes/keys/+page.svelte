<script lang="ts">
  import { untrack } from 'svelte';
  import { type ApiKeyView, revokeKey } from '$lib/api/keys.js';
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
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold text-slate-900">{$t('API Keys')}</h1>
      <p class="text-sm text-slate-500">
        {$t(
          'Keys are stored as a hash plus a short display prefix — the full key is shown only once, at creation.',
        )}
      </p>
    </div>
    <button
      type="button"
      class="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      onclick={() => (showCreate = true)}>{$t('New key')}</button
    >
  </header>

  {#if error}
    <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  {/if}

  {#if showCreate}
    <CreateKeyDialog {lanes} oncreated={onCreated} onclose={() => (showCreate = false)} />
  {/if}

  <div class="overflow-hidden rounded-lg border border-slate-200">
    <table class="w-full text-left text-sm">
      <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th class="px-4 py-2">{$t('Key (prefix)')}</th>
          <th class="px-4 py-2">{$t('Role')}</th>
          <th class="px-4 py-2">{$t('Caps')}</th>
          <th class="px-4 py-2">{$t('Status')}</th>
          <th class="px-4 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {#each keys as key (key.key_id)}
          <tr data-testid="key-row" class="border-t border-slate-100 align-top">
            <td class="px-4 py-3">
              <code class="font-mono text-slate-900">{key.prefix}</code>
            </td>
            <td class="px-4 py-3">
              <span class="text-slate-700">{key.role}</span>
              {#if key.role === 'root'}
                <p data-testid="root-warning" class="mt-1 text-xs text-amber-700">
                  {$t('Management plane only — do not feed production traffic.')}
                </p>
              {/if}
            </td>
            <td class="px-4 py-3 text-slate-600">
              <div>max_lane: {key.max_lane ?? '—'}</div>
              <div>allowed_lanes: {key.allowed_lanes?.join(', ') || '—'}</div>
              <div>allow_custom_model: {key.allow_custom_model ? $t('yes') : $t('no')}</div>
            </td>
            <td class="px-4 py-3">
              {#if key.disabled}
                <span class="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600"
                  >{$t('disabled')}</span
                >
              {:else}
                <span
                  class="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                  >{$t('active')}</span
                >
              {/if}
            </td>
            <td class="px-4 py-3 text-right">
              {#if !key.disabled}
                <button
                  type="button"
                  class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
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

  {#if confirmingRevoke}
    <div
      class="rounded-lg border border-amber-300 bg-amber-50 p-4"
      role="dialog"
      aria-label={$t('Confirm revoke')}
    >
      <p class="text-sm text-amber-800">
        {$t(
          'Revoke this key? It will be disabled (kept for audit, not deleted). Mint a fresh key to rotate.',
        )}
      </p>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          class="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-white"
          onclick={cancelRevoke}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
          onclick={confirmRevoke}>{$t('Confirm revoke')}</button
        >
      </div>
    </div>
  {/if}
</section>
