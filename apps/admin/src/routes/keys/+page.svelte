<script lang="ts">
  import { untrack } from 'svelte';
  import { base } from '$app/paths';
  import {
    type ApiKeyView,
    type CreatedKey,
    deleteKey,
    type KeyUsage,
    revealKey,
    type RevealedKey,
    revokeKey,
    rotateKey,
  } from '$lib/api/keys.js';
  import ConnectClientDialog from '$lib/components/ConnectClientDialog.svelte';
  import CreateKeyDialog from '$lib/components/CreateKeyDialog.svelte';
  import EditKeyDialog from '$lib/components/EditKeyDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { durationParts, formatCount, formatTokens, formatUsd } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // API key management view. HARD security line (CLAUDE.md Principle 7 / docs/06): the
  // list shows ONLY the display prefix + sha256-backed reference — never plaintext.
  // Plaintext appears only in transient create/reveal/rotate modal state, then is
  // wiped. Revocation is a SOFT disable (server flips disabled:true); rotation
  // preserves the key row and history. This view is a pure consumer of
  // /admin/api/* — it owns no auth logic and persists no credentials.
  let { data }: { data: { keys: ApiKeyView[]; lanes: string[]; usage: KeyUsage[] } } = $props();

  // The auto-minted internal LLM key (server-managed, re-minted each startup, backs the
  // memory/eval self-HTTP calls). It is read-only here: revoking/deleting/editing it would
  // break internal LLM calls, so the server refuses (403) and this view hides the actions.
  const INTERNAL_KEY_ID = 'k_internal';

  let keys = $state<ApiKeyView[]>(untrack(() => data.keys));
  const lanes = untrack(() => data.lanes);

  // Today's per-key usage, keyed by key_id for O(1) row lookup. A key absent from
  // the map saw no traffic today → the cell renders "—". Display-only (refreshed
  // on the next load); never mutated by the local create/revoke edits.
  const usageById = $derived(new Map(data.usage.map((u) => [u.key_id, u])));

  // Detail-page link for one key — the per-key stats + scoped request list.
  const detailHref = (keyId: string): string => `${base}/keys/${encodeURIComponent(keyId)}`;

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
  // Reveal/rotate expose plaintext intentionally, but only inside these transient
  // modal states. The normal key list remains prefix-only.
  let revealing = $state<string | null>(null);
  let revealedKey = $state<(RevealedKey & { prefix: string }) | null>(null);
  let unavailableRevealKey = $state<ApiKeyView | null>(null);
  let revealCopied = $state<boolean>(false);
  let confirmingRotate = $state<string | null>(null);
  let rotating = $state<string | null>(null);
  let rotatedKey = $state<CreatedKey | null>(null);
  let rotatedCopied = $state<boolean>(false);

  // The display prefix of the key pending revoke confirmation — purely for copy.
  let confirmingPrefix = $derived(keys.find((k) => k.key_id === confirmingRevoke)?.prefix ?? '');
  // The display prefix of the key pending delete confirmation — purely for copy.
  let confirmingDeletePrefix = $derived(
    keys.find((k) => k.key_id === confirmingDelete)?.prefix ?? '',
  );
  let confirmingRotatePrefix = $derived(
    keys.find((k) => k.key_id === confirmingRotate)?.prefix ?? '',
  );
  let unavailableRevealPrefix = $derived(unavailableRevealKey?.prefix ?? '');

  // The key currently being edited in the Edit dialog (null = closed). All caps
  // are editable there EXCEPT the immutable identity and role (see EditKeyDialog).
  let editingKey = $state<ApiKeyView | null>(null);

  // Render a stored limit for display: a number compacted (a 2,000,000 TPM cap
  // reads "2M", not a 7-digit wall), 0 → "unlimited", null → the inherit/"default"
  // copy.
  function limitLabel(v: number | null): string {
    if (v === null) return $t('Default');
    return v === 0 ? $t('Unlimited') : formatCount(v);
  }

  // Budget rolling window, coarsened to the largest sensible unit ("1h", "30d") —
  // raw seconds ("2592000s") are unreadable. Shares durationParts with the
  // providers page so every duration label agrees on the >24h ⇒ days rule.
  function windowText(seconds: number): string {
    const p = durationParts(seconds * 1000);
    if (p.unit === 'dh') return p.h > 0 ? `${p.d}d ${p.h}h` : `${p.d}d`;
    if (p.unit === 'hm') return p.m > 0 ? `${p.h}h ${p.m}m` : `${p.h}h`;
    return `${p.m}m`;
  }

  // Compact per-key usage-budget summary for the list (docs/06). Shows only the
  // dimensions that have a cap; empty = no budget. The over-budget behavior
  // (degrade lane / reject) is appended so operators see the cost-control posture.
  function budgetParts(key: ApiKeyView): string[] {
    const parts: string[] = [];
    if (key.budget_requests !== null) parts.push(`${formatCount(key.budget_requests)} req`);
    if (key.budget_tokens !== null) parts.push(`${formatTokens(key.budget_tokens)} tok`);
    if (key.budget_spend_usd !== null) parts.push(formatUsd(key.budget_spend_usd));
    // The rolling window only matters once a cap exists (no cap = no budget at all).
    if (parts.length > 0 && key.budget_window_seconds !== null) {
      parts.push(windowText(key.budget_window_seconds));
    }
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

  async function copySecret(value: string, kind: 'reveal' | 'rotate'): Promise<void> {
    try {
      await navigator.clipboard?.writeText(value);
      if (kind === 'reveal') revealCopied = true;
      else rotatedCopied = true;
    } catch {
      if (kind === 'reveal') revealCopied = false;
      else rotatedCopied = false;
    }
  }

  async function handleReveal(key: ApiKeyView): Promise<void> {
    error = null;
    unavailableRevealKey = null;
    revealing = key.key_id;
    revealCopied = false;
    try {
      const revealed = await revealKey(key.key_id);
      revealedKey = { ...revealed, prefix: key.prefix };
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === 'FullKeyUnavailableError' ||
          e.message.includes('full key is not available') ||
          e.message.includes('full-key recovery'))
      ) {
        unavailableRevealKey = key;
        return;
      }
      error = e instanceof Error ? e.message : $t('Failed to reveal key');
    } finally {
      revealing = null;
    }
  }

  function askRotate(keyId: string): void {
    error = null;
    confirmingRotate = keyId;
  }

  function cancelRotate(): void {
    confirmingRotate = null;
  }

  function rotateUnavailableKey(): void {
    const keyId = unavailableRevealKey?.key_id;
    unavailableRevealKey = null;
    if (keyId) askRotate(keyId);
  }

  async function confirmRotate(): Promise<void> {
    const keyId = confirmingRotate;
    if (!keyId) return;
    error = null;
    rotating = keyId;
    rotatedCopied = false;
    try {
      const rotated = await rotateKey(keyId);
      keys = keys.map((k) => (k.key_id === keyId ? { ...k, prefix: rotated.prefix } : k));
      confirmingRotate = null;
      rotatedKey = rotated;
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to rotate key');
    } finally {
      rotating = null;
    }
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
  <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="page-title">{$t('API Keys')}</h1>
      <p class="section-desc">
        {$t(
          'An API key authenticates a client and can be restricted to a specific set of lanes. Keys authenticate by hash; recoverable rows can be revealed or rotated from this page.',
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
    <div class="cards-table-frame">
      <table class="cards-table">
        <thead class="table-head">
          <tr>
            <th class="px-3 py-2">{$t('Name')}</th>
            <th class="px-3 py-2">{$t('Key (prefix)')}</th>
            <th class="px-3 py-2">{$t('Role')}</th>
            <th class="px-3 py-2">{$t('Caps')}</th>
            <th class="px-3 py-2">{$t('Rate limit')}</th>
            <th class="px-3 py-2">{$t('Budget')}</th>
            <th class="px-3 py-2">{$t('Memory')}</th>
            <th class="px-3 py-2">{$t('Usage (today)')}</th>
            <th class="px-3 py-2">{$t('Status')}</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each keys as key (key.key_id)}
            <tr data-testid="key-row" class="align-top">
              <td data-label={$t('Name')} class="px-3 py-2">
                <a class="link-inline font-medium" href={detailHref(key.key_id)}>
                  {#if key.name}
                    <span class="text-ink-strong">{key.name}</span>
                  {:else}
                    <span class="text-ink-muted">{$t('Unnamed')}</span>
                  {/if}
                </a>
              </td>
              <td data-label={$t('Key (prefix)')} class="px-3 py-2">
                <code class="font-mono text-ink-strong">{key.prefix}</code>
              </td>
              <td data-label={$t('Role')} class="px-3 py-2">
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
              <td data-label={$t('Caps')} class="px-3 py-2 text-ink-muted">
                <div>{$t('Allowed lanes')}: {key.allowed_lanes?.join(', ') || $t('No cap')}</div>
                <div>{$t('Custom model')}: {key.allow_custom_model ? $t('yes') : $t('no')}</div>
                <div>{$t('Fast mode')}: {key.allow_fast_mode ? $t('yes') : $t('no')}</div>
              </td>
              <td data-label={$t('Rate limit')} class="px-3 py-2 text-ink-muted">
                <div>{$t('RPM')}: {limitLabel(key.rate_limit_rpm)}</div>
                <div>{$t('TPM')}: {limitLabel(key.rate_limit_tpm)}</div>
                <!-- Concurrency null = unlimited (NOT inherit), unlike the rate limits above. -->
                <div>
                  {$t('Concurrency')}: {key.concurrency_limit ?? $t('Unlimited')}
                </div>
              </td>
              <td data-label={$t('Budget')} class="px-3 py-2 text-ink-muted">
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
              <td data-label={$t('Memory')} class="px-3 py-2 text-ink-muted">
                {#if key.memory_mode === 'off'}
                  <span>{$t('Off')}</span>
                {:else}
                  <div>
                    <span>{key.memory_mode === 'observe' ? $t('Observe') : $t('Inject')}</span>
                    {#if key.memory_thread_source === 'auto'}
                      <span class="text-xs">· {$t('auto thread')}</span>
                    {/if}
                  </div>
                  {#if key.memory_project_id}
                    <div class="text-xs"><span>{key.memory_project_id}</span></div>
                  {/if}
                {/if}
              </td>
              <td data-label={$t('Usage (today)')} class="px-3 py-2 text-ink-muted">
                {#if usageById.get(key.key_id)}
                  {@const u = usageById.get(key.key_id)}
                  <div class="text-ink-body">
                    {formatCount(u?.requests ?? 0)}
                    {$t('req')}{#if (u?.error_count ?? 0) > 0}
                      · <span class="text-rose-600"
                        >{formatCount(u?.error_count ?? 0)}
                        {$t('err')}</span
                      >{/if}
                  </div>
                  <div class="text-xs">
                    {formatUsd(u?.cost_usd)} · {formatTokens(u?.total_tokens ?? 0)}
                    {$t('tok')}
                  </div>
                {:else}
                  <span title={$t('No traffic today')}>—</span>
                {/if}
              </td>
              <td data-label={$t('Status')} class="px-3 py-2">
                {#if key.disabled}
                  <span class="badge-neutral">{$t('disabled')}</span>
                {:else}
                  <span class="badge-ok">{$t('active')}</span>
                {/if}
              </td>
              <td data-label={$t('Actions')} class="px-3 py-2 lg:text-right">
                <div class="flex justify-end gap-2">
                  <a class="btn-secondary" href={detailHref(key.key_id)}>{$t('Details')}</a>
                  {#if key.key_id === INTERNAL_KEY_ID}
                    <!-- system-managed internal key: read-only, no edit/revoke/delete -->
                  {:else}
                    <button
                      type="button"
                      class="btn-secondary"
                      disabled={revealing === key.key_id}
                      onclick={() => handleReveal(key)}
                      >{revealing === key.key_id ? $t('Revealing…') : $t('View full key')}</button
                    >
                  {/if}
                  {#if key.key_id === INTERNAL_KEY_ID}
                    <!-- system-managed internal key: read-only, no edit/revoke/delete -->
                  {:else if !key.disabled}
                    <button
                      type="button"
                      class="btn-secondary"
                      disabled={rotating === key.key_id}
                      onclick={() => askRotate(key.key_id)}>{$t('Rotate')}</button
                    >
                    <button type="button" class="btn-secondary" onclick={() => startEdit(key)}
                      >{$t('Edit')}</button
                    >
                    <button
                      type="button"
                      class="btn-danger-outline"
                      disabled={revoking === key.key_id}
                      onclick={() => askRevoke(key.key_id)}>{$t('Revoke')}</button
                    >
                  {:else}
                    <button
                      type="button"
                      class="btn-danger-outline"
                      disabled={deleting === key.key_id}
                      onclick={() => askDelete(key.key_id)}>{$t('Delete')}</button
                    >
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if unavailableRevealKey}
    <Modal label={$t('Full key unavailable')} onclose={() => (unavailableRevealKey = null)}>
      <h2 class="section-header">{$t('Full key unavailable')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t(
          'This key was created before full-key recovery was enabled. Helm only stored a hash, so the old full value cannot be reconstructed.',
        )}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        <code class="font-mono">{unavailableRevealPrefix}</code>{' '}{$t(
          'can be rotated to generate a new full key for the same key id and request history. The current value will stop working only after the next confirmation step.',
        )}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          onclick={() => (unavailableRevealKey = null)}>{$t('Cancel')}</button
        >
        <button type="button" class="btn-danger" onclick={rotateUnavailableKey}
          >{$t('Rotate this key')}</button
        >
      </div>
    </Modal>
  {/if}

  {#if revealedKey}
    <Modal label={$t('Full API key')} onclose={() => (revealedKey = null)}>
      <h2 class="section-header">{$t('Full API key')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t('This value grants access as')}
        <code class="font-mono">{revealedKey.prefix}</code>{$t('. Keep it private.')}
      </p>
      <div class="mt-3 flex items-center gap-2">
        <code
          data-testid="revealed-key-value"
          class="flex-1 break-all rounded bg-slate-100 px-3 py-2 font-mono text-sm text-ink-strong"
          >{revealedKey.plaintext}</code
        >
        <button
          type="button"
          class="btn-primary-sm"
          onclick={() => revealedKey && copySecret(revealedKey.plaintext, 'reveal')}
          >{revealCopied ? $t('Copied') : $t('Copy')}</button
        >
      </div>
      <div class="mt-4 flex justify-end">
        <button type="button" class="btn-secondary" onclick={() => (revealedKey = null)}
          >{$t('Close')}</button
        >
      </div>
    </Modal>
  {/if}

  {#if confirmingRotate}
    <Modal
      label={$t('Rotate key')}
      onclose={cancelRotate}
      dismissible={rotating !== confirmingRotate}
    >
      <h2 class="section-header">{$t('Rotate key')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t('Rotate key')}
        <code class="font-mono">{confirmingRotatePrefix}</code>{$t(
          '? The current value stops working immediately. Key id, name, caps, and request history stay in place.',
        )}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={rotating === confirmingRotate}
          onclick={cancelRotate}>{$t('Cancel')}</button
        >
        <button
          type="button"
          class="btn-danger"
          disabled={rotating === confirmingRotate}
          onclick={confirmRotate}
          >{rotating === confirmingRotate ? $t('Rotating…') : $t('Rotate key')}</button
        >
      </div>
    </Modal>
  {/if}

  {#if rotatedKey}
    <Modal
      label={$t('Replacement key created')}
      onclose={() => (rotatedKey = null)}
      dismissible={false}
    >
      <h2 class="section-header">{$t('Replacement key created')}</h2>
      <p class="mt-2 text-sm text-amber-800">
        {$t('Copy this new API key. It replaces the previous value for the same key.')}
      </p>
      {#if rotatedKey.recoverable === false}
        <p class="mt-1 text-sm text-amber-800">
          {$t('Key reveal encryption is not configured, so this value cannot be recovered later.')}
        </p>
      {/if}
      <div class="mt-3 flex items-center gap-2">
        <code
          data-testid="rotated-key-value"
          class="flex-1 break-all rounded bg-slate-100 px-3 py-2 font-mono text-sm text-ink-strong"
          >{rotatedKey.plaintext}</code
        >
        <button
          type="button"
          class="btn-primary-sm"
          onclick={() => rotatedKey && copySecret(rotatedKey.plaintext, 'rotate')}
          >{rotatedCopied ? $t('Copied') : $t('Copy')}</button
        >
      </div>
      <div class="mt-4 flex justify-end">
        <button type="button" class="btn-success" onclick={() => (rotatedKey = null)}
          >{$t('Done')}</button
        >
      </div>
    </Modal>
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
