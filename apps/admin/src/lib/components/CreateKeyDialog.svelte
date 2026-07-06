<script lang="ts">
  import {
    type ApiKeyView,
    type CreateKeyInput,
    createKey,
    type CreatedKey,
  } from '$lib/api/keys.js';
  import ConnectClientDialog from '$lib/components/ConnectClientDialog.svelte';
  import KeyCapsForm, { emptyKeyCaps } from '$lib/components/KeyCapsForm.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Create-key dialog: owns the caps form AND the plaintext reveal. The plaintext
  // is wiped from component state on close; if the server has at-rest encryption
  // configured it can also store encrypted recovery material for later admin reveal.
  // The dialog bubbles the redacted view (prefix only, NO plaintext) up via
  // `oncreated`.
  let {
    lanes,
    oncreated,
    onclose,
  }: {
    lanes: string[];
    oncreated: (key: ApiKeyView) => void;
    onclose: () => void;
  } = $props();

  type Role = 'root' | 'user';

  let role = $state<Role>('user');
  // Optional human-readable label so the operator can tell which project/client this
  // key belongs to later (the prefix alone is opaque). Trimmed; blank => unnamed.
  let name = $state<string>('');
  // Every per-key cap lives in the shared buffer rendered by <KeyCapsForm>
  // (identical structure to the edit dialog). null/empty = leave unset.
  let form = $state(emptyKeyCaps());

  let error = $state<string | null>(null);
  let creating = $state<boolean>(false);

  // The minted plaintext + its key_id live ONLY in this transient state and are
  // cleared on close. While set, the form is replaced by the one-time reveal.
  let revealed = $state<CreatedKey | null>(null);
  let copied = $state<boolean>(false);
  // The "Connect a client" guide, opened from the reveal step with the fresh
  // plaintext injected (one-time). It is a child of THIS component so the secret
  // never leaves the dialog that owns it — never lifted to the page or persisted
  // (CLAUDE.md 原则7 / docs/06). Wiped alongside `revealed` on confirmSaved.
  let showConnect = $state<boolean>(false);

  async function handleCreate(): Promise<void> {
    error = null;
    creating = true;
    const input: CreateKeyInput = {
      role,
      allow_custom_model: form.allowCustomModel,
      allow_fast_mode: form.allowFastMode,
    };
    const trimmedName = name.trim();
    if (trimmedName.length > 0) input.name = trimmedName;
    if (form.allowedLanes.length > 0) input.allowed_lanes = [...form.allowedLanes];
    if (form.blockedModels.length > 0) input.blocked_models = [...form.blockedModels];
    // Send a rate limit only when the operator set one; blank => inherit default.
    // `!= null` also catches the `undefined` Svelte 5 gives an emptied number input.
    if (form.rpm != null) input.rate_limit_rpm = form.rpm;
    if (form.tpm != null) input.rate_limit_tpm = form.tpm;
    // Usage budgets: send only the dimensions the operator set (blank => no cap).
    if (form.budgetRequests != null) input.budget_requests = form.budgetRequests;
    if (form.budgetTokens != null) input.budget_tokens = form.budgetTokens;
    if (form.budgetSpend != null) input.budget_spend_usd = form.budgetSpend;
    if (form.budgetWindow != null) input.budget_window_seconds = form.budgetWindow;
    input.over_budget_behavior = form.overBudgetBehavior;
    if (form.degradeLane.length > 0) input.degrade_lane = form.degradeLane;
    // Concurrency limit: send only when set (blank => unlimited).
    if (form.concurrencyLimit != null) input.concurrency_limit = form.concurrencyLimit;
    if (form.memoryMode !== 'off') input.memory_mode = form.memoryMode;
    if (form.memoryProject.length > 0) input.memory_project_id = form.memoryProject;
    // Send only when the operator opts out of the default ('auto'); omitted => the
    // keystore mints 'auto'.
    if (form.memoryThreadSource !== 'auto') input.memory_thread_source = form.memoryThreadSource;
    try {
      revealed = await createKey(input);
    } catch (e) {
      error = e instanceof Error ? e.message : $t('Failed to create key');
    } finally {
      creating = false;
    }
  }

  async function copyPlaintext(): Promise<void> {
    if (!revealed) return;
    try {
      await navigator.clipboard?.writeText(revealed.plaintext);
      copied = true;
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); operator can select
      // the text manually. Do not surface the secret in an error message.
      copied = false;
    }
  }

  // Operator confirms they stored the secret. Bubble the redacted view up (prefix
  // is unknown to the client — POST returns only key_id+plaintext — so we project
  // a minimal view from the chosen caps; the page will refresh prefixes from the
  // server list). Then WIPE the plaintext and close.
  function confirmSaved(): void {
    if (revealed) {
      const view: ApiKeyView = {
        key_id: revealed.key_id,
        // Server-minted display prefix (non-sensitive), carried on the create
        // response. NEVER a slice of the plaintext.
        prefix: revealed.prefix,
        role,
        name: name.trim().length > 0 ? name.trim() : null,
        allowed_lanes: form.allowedLanes.length > 0 ? [...form.allowedLanes] : null,
        allow_custom_model: form.allowCustomModel,
        blocked_models: form.blockedModels.length > 0 ? [...form.blockedModels] : null,
        allow_fast_mode: form.allowFastMode,
        disabled: false,
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
      oncreated(view);
    }
    // Wipe transient secret state from the component.
    revealed = null;
    copied = false;
    showConnect = false;
    onclose();
  }
</script>

<!-- While the plaintext is revealed the modal is non-dismissible: no scrim, Escape
     ignored. The operator must click "I saved it" (confirmSaved) to bubble the
     redacted view and wipe the secret — see CLAUDE.md 原则7 / docs/06. -->
<Modal label={$t('Create API key')} {onclose} dismissible={!revealed}>
  {#if revealed}
    <h2 class="section-header">{$t('Your new API key')}</h2>
    <p class="mt-1 text-sm text-amber-700">
      {#if revealed.recoverable === false}
        {$t(
          'Copy it now — key reveal encryption is not configured, so it cannot be recovered later.',
        )}
      {:else}
        {$t('Copy it now and keep it private. You can reveal it later from API Keys.')}
      {/if}
    </p>
    <div class="mt-3 flex items-center gap-2">
      <code
        data-testid="plaintext-reveal"
        class="flex-1 break-all rounded bg-slate-100 px-3 py-2 font-mono text-sm text-ink-strong"
        >{revealed.plaintext}</code
      >
      <button type="button" class="btn-primary-sm" onclick={copyPlaintext}
        >{copied ? $t('Copied') : $t('Copy')}</button
      >
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={() => (showConnect = true)}
        >{$t('Connect a client')}</button
      >
      <button type="button" class="btn-success" onclick={confirmSaved}>{$t('I saved it')}</button>
    </div>

    {#if showConnect}
      <ConnectClientDialog
        plaintextKey={revealed.plaintext}
        onclose={() => (showConnect = false)}
      />
    {/if}
  {:else}
    <h2 class="section-header">{$t('Create API key')}</h2>

    {#if error}
      <p class="alert-error mt-2" role="alert">
        {error}
      </p>
    {/if}

    <div class="mt-3 flex flex-col gap-3">
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

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Role')}</span>
        <select bind:value={role} aria-label={$t('role')} class="select">
          <option value="user">user</option>
          <option value="root">root</option>
        </select>
        <span class="field-help"
          >{$t(
            'user keys authenticate normal client traffic. root keys are for the management plane only.',
          )}</span
        >
        {#if role === 'root'}
          <span class="text-xs text-amber-700"
            >{$t(
              'Root keys are for the bootstrap/management plane only — do not feed production traffic.',
            )}</span
          >
        {/if}
      </label>

      <KeyCapsForm bind:form {lanes} />
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
      <button type="button" class="btn-primary" disabled={creating} onclick={handleCreate}
        >{$t('Create key')}</button
      >
    </div>
  {/if}
</Modal>
