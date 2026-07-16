<script lang="ts">
  import { untrack } from 'svelte';
  import { type ApiKeyView, type UpdateKeyInput, updateKey } from '$lib/api/keys.js';
  import KeyCapsForm, { keyCapsFromView } from '$lib/components/KeyCapsForm.svelte';
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

  // Pre-fill the shared caps buffer from the current key — captured ONCE at mount.
  // The dialog is remounted per edit ({#if editingKey} in the page), so untracking
  // the initial read is correct (matches the +page.svelte `data.keys` pattern) and
  // the buffer stays the editing state thereafter. <KeyCapsForm expandConfigured>
  // starts any section that holds real values open, so active caps are never
  // hidden behind a closed fold.
  let form = $state(untrack(() => keyCapsFromView(key)));
  // Editable human-readable label (unlike role/prefix, which are immutable). Trimmed
  // on save; blank => cleared back to unnamed. Captured once at mount (see above).
  let name = $state(untrack(() => key.name ?? ''));

  let error = $state<string | null>(null);
  let saving = $state<boolean>(false);

  async function handleSave(): Promise<void> {
    error = null;
    saving = true;
    // Send the editable set (explicit null clears a cap). allowed_lanes is the one
    // tri-state exception: omit it when untouched so a legacy deny-all [] is not
    // silently widened to unrestricted null while editing an unrelated field.
    // `?? null` also catches the `undefined` Svelte 5 gives an emptied number input.
    const patch: UpdateKeyInput = {
      name: name.trim().length > 0 ? name.trim() : null,
      allow_custom_model: form.allowCustomModel,
      blocked_models: form.blockedModels.length > 0 ? [...form.blockedModels] : null,
      allow_fast_mode: form.allowFastMode,
      rate_limit_rpm: form.rpm ?? null,
      rate_limit_tpm: form.tpm ?? null,
      budget_requests: form.budgetRequests ?? null,
      budget_tokens: form.budgetTokens ?? null,
      budget_spend_usd: form.budgetSpend ?? null,
      budget_window_seconds: form.budgetWindow ?? null,
      over_budget_behavior: form.overBudgetBehavior,
      degrade_lane: form.degradeLane.length > 0 ? form.degradeLane : null,
      concurrency_limit: form.concurrencyLimit ?? null,
      memory_mode: form.memoryMode,
      memory_project_id: form.memoryProject.length > 0 ? form.memoryProject : null,
      memory_thread_source: form.memoryThreadSource,
    };
    if (form.allowedLanesTouched) {
      patch.allowed_lanes = form.allowedLanes.length > 0 ? [...form.allowedLanes] : null;
    }
    try {
      await updateKey(key.key_id, patch);
      // Project the updated redacted view (role/prefix carried over unchanged).
      onsaved({
        ...key,
        name: patch.name ?? null,
        allowed_lanes: form.allowedLanesTouched ? (patch.allowed_lanes ?? null) : key.allowed_lanes,
        allow_custom_model: form.allowCustomModel,
        blocked_models: patch.blocked_models ?? null,
        allow_fast_mode: form.allowFastMode,
        rate_limit_rpm: patch.rate_limit_rpm ?? null,
        rate_limit_tpm: patch.rate_limit_tpm ?? null,
        budget_requests: patch.budget_requests ?? null,
        budget_tokens: patch.budget_tokens ?? null,
        budget_spend_usd: patch.budget_spend_usd ?? null,
        budget_window_seconds: patch.budget_window_seconds ?? null,
        over_budget_behavior: form.overBudgetBehavior,
        degrade_lane: patch.degrade_lane ?? null,
        concurrency_limit: patch.concurrency_limit ?? null,
        memory_mode: form.memoryMode,
        memory_project_id: patch.memory_project_id ?? null,
        memory_thread_source: form.memoryThreadSource,
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
    <div class="flex items-baseline gap-4 text-sm">
      <div class="flex flex-col gap-1">
        <span class="field-label">{$t('Key (prefix)')}</span>
        <code class="font-mono text-ink-strong">{key.prefix}</code>
      </div>
      <div class="flex flex-col gap-1">
        <span class="field-label">{$t('Role')}</span>
        <span class="text-ink-body">{key.role}</span>
      </div>
    </div>
    <span class="field-help"
      >{$t('Role is fixed for the life of a key — rotate by revoking and minting a new one.')}</span
    >

    <!-- Name IS editable (unlike the identity above). Blank clears it to unnamed. -->
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Name')}</span>
      <input
        type="text"
        maxlength="100"
        aria-label={$t('Name')}
        placeholder={$t('Optional')}
        class="input"
        bind:value={name}
      />
      <span class="field-help"
        >{$t(
          'A label to help you recognize this key later — e.g. the project it belongs to.',
        )}</span
      >
    </label>

    <KeyCapsForm bind:form {lanes} expandConfigured />
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
    <button type="button" class="btn-primary" disabled={saving} onclick={handleSave}
      >{$t('Save changes')}</button
    >
  </div>
</Modal>
