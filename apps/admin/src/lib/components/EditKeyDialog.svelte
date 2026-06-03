<script lang="ts">
  import { untrack } from 'svelte';
  import { type ApiKeyView, type UpdateKeyInput, updateKey } from '$lib/api/keys.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Edit-key dialog: edits every per-key cap of an EXISTING key in one place. The
  // immutable identity (key value/hash/prefix) is shown read-only and NEVER sent;
  // `role` is read-only too — it cannot be edited (rotate by revoke + re-mint), so
  // the edit path can never escalate a user key to root (CLAUDE.md 原则7 / docs/06).
  // The dialog bubbles the updated redacted view up via `onsaved` (prefix only,
  // NEVER any plaintext).
  let {
    key,
    lanes,
    onsaved,
    onclose,
  }: {
    key: ApiKeyView;
    lanes: string[];
    onsaved: (key: ApiKeyView) => void;
    onclose: () => void;
  } = $props();

  // Pre-fill the form from the current key — captured ONCE at mount. The dialog is
  // remounted per edit ({#if editingKey} in the page), so untracking the initial
  // read is correct (matches the +page.svelte `data.keys` pattern) and the form
  // stays the editing buffer thereafter.
  // Allowed-lanes whitelist as a Set for cheap toggle/lookup; [] => no cap (null).
  let allowedLanes = $state<Set<string>>(untrack(() => new Set(key.allowed_lanes ?? [])));
  let allowCustomModel = $state<boolean>(untrack(() => key.allow_custom_model));
  // number | null: a number input binds to number|null (empty field => null), so
  // no string parsing is needed. null = clear → inherit the system default.
  let rpmInput = $state<number | null>(untrack(() => key.rate_limit_rpm));
  let tpmInput = $state<number | null>(untrack(() => key.rate_limit_tpm));

  let error = $state<string | null>(null);
  let saving = $state<boolean>(false);

  function toggleLane(lane: string, checked: boolean): void {
    const next = new Set(allowedLanes);
    if (checked) next.add(lane);
    else next.delete(lane);
    allowedLanes = next;
  }

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    // Send the WHOLE editable set (explicit null clears a cap) — overwrite intent.
    // `?? null` also catches the `undefined` Svelte 5 gives an emptied number input.
    const selected = [...allowedLanes];
    const patch: UpdateKeyInput = {
      allowed_lanes: selected.length > 0 ? selected : null,
      allow_custom_model: allowCustomModel,
      rate_limit_rpm: rpmInput ?? null,
      rate_limit_tpm: tpmInput ?? null,
    };
    try {
      await updateKey(key.key_id, patch);
      // Project the updated redacted view (role/prefix carried over unchanged).
      onsaved({
        ...key,
        allowed_lanes: patch.allowed_lanes ?? null,
        allow_custom_model: allowCustomModel,
        rate_limit_rpm: patch.rate_limit_rpm ?? null,
        rate_limit_tpm: patch.rate_limit_tpm ?? null,
      });
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to update key');
    } finally {
      saving = false;
    }
  }
</script>

<Modal label={$t('Edit key')} {onclose}>
  <h2 class="section-header">{$t('Edit key')}</h2>

  {#if error}
    <p class="alert-error mt-2" role="alert">
      {error}
    </p>
  {/if}

  <div class="mt-3 flex flex-col gap-3">
    <!-- Immutable identity: shown for reference, never editable. -->
    <div class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Key (prefix)')}</span>
      <code class="font-mono text-ink-strong">{key.prefix}</code>
    </div>
    <div class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Role')}</span>
      <span class="text-ink-body">{key.role}</span>
      <span class="field-help"
        >{$t(
          'Role is fixed for the life of a key — rotate by revoking and minting a new one.',
        )}</span
      >
    </div>

    <fieldset class="flex flex-col gap-1 text-sm">
      <legend class="field-label">{$t('Allowed lanes')}</legend>
      <div class="flex flex-wrap gap-3">
        {#each lanes as lane (lane)}
          <label class="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={allowedLanes.has(lane)}
              onchange={(e) => toggleLane(lane, e.currentTarget.checked)}
            />
            <span class="text-ink-body">{lane}</span>
          </label>
        {/each}
      </div>
      <span class="field-help"
        >{$t(
          'Restrict this key to a specific set of lanes. Leave all unchecked to allow any lane (no whitelist).',
        )}</span
      >
    </fieldset>

    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        bind:checked={allowCustomModel}
        aria-label={$t('allow custom model')}
      />
      <span class="text-ink-body">{$t('Allow explicit client-specified model passthrough')}</span>
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Requests per minute (RPM)')}</span>
        <input
          type="number"
          min="0"
          step="1"
          aria-label={$t('Requests per minute (RPM)')}
          placeholder={$t('Default')}
          class="select"
          bind:value={rpmInput}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Tokens per minute (TPM)')}</span>
        <input
          type="number"
          min="0"
          step="1"
          aria-label={$t('Tokens per minute (TPM)')}
          placeholder={$t('Default')}
          class="select"
          bind:value={tpmInput}
        />
      </label>
    </div>
    <span class="field-help"
      >{$t(
        'Per-key rate limits. Leave blank to use the system default. 0 means unlimited for that dimension.',
      )}</span
    >
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
    <button type="button" class="btn-primary" disabled={saving} onclick={handleSave}
      >{$t('Save changes')}</button
    >
  </div>
</Modal>
