<script lang="ts">
  import { untrack } from 'svelte';
  import { type ApiKeyView, deleteKey, revokeKey } from '$lib/api/keys.js';
  import ConnectClientDialog from '$lib/components/ConnectClientDialog.svelte';
  import CreateKeyDialog from '$lib/components/CreateKeyDialog.svelte';
  import EditKeyDialog from '$lib/components/EditKeyDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // API key management view. HARD security line (CLAUDE.md Principle 7 / docs/06): the
  // list shows ONLY the display prefix + sha256-backed reference — never plaintext.
  // The plaintext is shown once by the create dialog at mint time, then wiped.
  // Revocation is a SOFT disable (server flips disabled:true) — the row is kept,
  // never removed or rewritten in place (rotation/revocation stays auditable). This view is a pure
  // consumer of /admin/api/* — it owns no auth logic and persists no credentials.
  let { data }: { data: { keys: ApiKeyView[]; lanes: string[] } } = $props();

  let keys = $state<ApiKeyView[]>(untrack(() => data.keys));
  const lanes = untrack(() => data.lanes);

  let error = $state<string | null>(null);
  let showCreate = $state<boolean>(false);
  // The "Connect a client" guide, opened from the header with no minted key (so it
  // shows a <your-helm-key> placeholder). The post-creation flow opens its own
  // instance pre-filled with the fresh plaintext (see CreateKeyDialog).
  let showConnect = $state<boolean>(false);
  // The key_id currently pending a revoke confirmation, if any.
  let confirmingRevoke = $state<string | null>(null);
  let revoking = $state<string | null>(null);
  // The key_id currently pending a permanent-delete confirmation, if any.
  let confirmingDelete = $state<string | null>(null);
  let deleting = $state<string | null>(null);

  // The display prefix of the key pending revoke confirmation — purely for copy.
  let confirmingPrefix = $derived(keys.find((k) => k.key_id === confirmingRevoke)?.prefix ?? '');
  // The display prefix of the key pending delete confirmation — purely for copy.
  let confirmingDeletePrefix = $derived(
    keys.find((k) => k.key_id === confirmingDelete)?.prefix ?? '',
  );

  // The key currently being edited in the Edit dialog (null = closed). All caps
  // are editable there EXCEPT the immutable identity and role (see EditKeyDialog).
  let editingKey = $state<ApiKeyView | null>(null);

  // Render a stored limit for display: a number as-is (0 → "unlimited"), null as
  // the inherit/"default" copy.
  function limitLabel(v: number | null): string {
    if (v === null) return $t('Default');
    return v === 0 ? $t('Unlimited') : String(v);
  }

  // Compact per-key usage-budget summary for the list (docs/06). Shows only the
  // dimensions that have a cap; empty = no budget. The over-budget behavior
  // (degrade lane / reject) is appended so operators see the cost-control posture.
  function budgetParts(key: ApiKeyView): string[] {
    const parts: string[] = [];
    if (key.budget_requests !== null) parts.push(`${key.budget_requests} req`);
    if (key.budget_tokens !== null) parts.push(`${key.budget_tokens} tok`);
    if (key.budget_spend_usd !== null) parts.push(`$${key.budget_spend_usd}`);
    return parts;
  }

  function startEdit(key: ApiKeyView): void {
    error = null;
    editingKey = key;
  }

  function onSaved(view: ApiKeyView): void {
    // Reflect the edited caps in the row immediately (also re-fetched on next load).
    keys = keys.map((k) => (k.key_id === view.key_id ? view : k));
    editingKey = null;
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

  function askDelete(keyId: string): void {
    error = null;
    confirmingDelete = keyId;
  }

  function cancelDelete(): void {
    confirmingDelete = null;
  }

  async function confirmDelete(): Promise<void> {
    const keyId = confirmingDelete;
    if (!keyId) return;
    error = null;
    deleting = keyId;
    try {
      await deleteKey(keyId);
      // Permanent delete: drop the row entirely (never kept, unlike revoke).
      keys = keys.filter((k) => k.key_id !== keyId);
      confirmingDelete = null;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to delete key');
    } finally {
      deleting = null;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="page-title">{$t('API Keys')}</h1>
      <p class="section-desc">
        {$t(
          'An API key authenticates a client and can be restricted to a specific set of lanes. Keys are stored as a hash plus a short display prefix — the full key is shown only once, at creation.',
        )}
      </p>
    </div>
    <div class="flex shrink-0 gap-2">
      <button type="button" class="btn-secondary" onclick={() => (showConnect = true)}
        >{$t('Connect a client')}</button
      >
      <button type="button" class="btn-primary" onclick={() => (showCreate = true)}
        >{$t('New key')}</button
      >
    </div>
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  {#if showCreate}
    <CreateKeyDialog {lanes} oncreated={onCreated} onclose={() => (showCreate = false)} />
  {/if}

  {#if showConnect}
    <ConnectClientDialog onclose={() => (showConnect = false)} />
  {/if}

  {#if editingKey}
    <EditKeyDialog key={editingKey} {lanes} onsaved={onSaved} onclose={() => (editingKey = null)} />
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
            <th class="px-3 py-2">{$t('Name')}</th>
            <th class="px-3 py-2">{$t('Key (prefix)')}</th>
            <th class="px-3 py-2">{$t('Role')}</th>
            <th class="px-3 py-2">{$t('Caps')}</th>
            <th class="px-3 py-2">{$t('Rate limit')}</th>
            <th class="px-3 py-2">{$t('Budget')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each keys as key (key.key_id)}
            <tr data-testid="key-row" class="table-row align-top">
              <td class="px-3 py-2">
                {#if key.name}
                  <span class="text-ink-strong">{key.name}</span>
                {:else}
                  <span class="text-ink-muted">{$t('Unnamed')}</span>
                {/if}
              </td>
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
                <div>{$t('Allowed lanes')}: {key.allowed_lanes?.join(', ') || $t('No cap')}</div>
                <div>{$t('Custom model')}: {key.allow_custom_model ? $t('yes') : $t('no')}</div>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                <div>{$t('RPM')}: {limitLabel(key.rate_limit_rpm)}</div>
                <div>{$t('TPM')}: {limitLabel(key.rate_limit_tpm)}</div>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {#if budgetParts(key).length > 0}
                  <div>{budgetParts(key).join(' · ')}</div>
                  <div class="text-xs">
                    {key.over_budget_behavior === 'reject'
                      ? $t('reject')
                      : `→ ${key.degrade_lane ?? 'economy'}`}
                  </div>
                {:else}
                  <span>{$t('None')}</span>
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
                  <div class="flex justify-end gap-2">
                    <button type="button" class="btn-secondary" onclick={() => startEdit(key)}
                      >{$t('Edit')}</button
                    >
                    <button
                      type="button"
                      class="btn-danger-outline"
                      disabled={revoking === key.key_id}
                      onclick={() => askRevoke(key.key_id)}>{$t('Revoke')}</button
                    >
                  </div>
                {:else}
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="btn-danger-outline"
                      disabled={deleting === key.key_id}
                      onclick={() => askDelete(key.key_id)}>{$t('Delete')}</button
                    >
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if confirmingRevoke}
    <Modal
      label={$t('Confirm revoke')}
      onclose={cancelRevoke}
      dismissible={revoking !== confirmingRevoke}
    >
      <h2 class="section-header">{$t('Confirm revoke')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t('Revoke key')}
        <code class="font-mono">{confirmingPrefix}</code>{$t(
          '? It will be disabled (kept for audit, not deleted). Mint a fresh key to rotate.',
        )}
      </p>
      <div class="mt-4 flex justify-end gap-2">
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
    </Modal>
  {/if}

  {#if confirmingDelete}
    <Modal
      label={$t('Confirm delete')}
      onclose={cancelDelete}
      dismissible={deleting !== confirmingDelete}
    >
      <h2 class="section-header">{$t('Confirm delete')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t('Delete key')}
        <code class="font-mono">{confirmingDeletePrefix}</code>{$t(
          '? This permanently removes the revoked key. Past request logs keep an anonymized reference.',
        )}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={deleting === confirmingDelete}
          onclick={cancelDelete}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="btn-danger"
          disabled={deleting === confirmingDelete}
          onclick={confirmDelete}
          >{deleting === confirmingDelete ? $t('Deleting…') : $t('Confirm delete')}</button
        >
      </div>
    </Modal>
  {/if}
</section>
