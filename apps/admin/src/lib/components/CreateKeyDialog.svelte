<script lang="ts">
  import {
    type ApiKeyView,
    type CreateKeyInput,
    createKey,
    type CreatedKey,
  } from '$lib/api/keys.js';
  import Modal from '$lib/components/Modal.svelte';
  import { t } from '$lib/i18n';

  // Create-key dialog: owns the caps form AND the ONE-TIME plaintext reveal.
  // CLAUDE.md Principle 7 / docs/06: the plaintext is returned by the create response
  // exactly once, shown once, then wiped from component state on close — it is
  // never persisted, re-fetchable, or surfaced anywhere else. The dialog bubbles
  // the redacted view (prefix only, NO plaintext) up via `oncreated`.
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
  // Allowed-lanes whitelist as a Set for cheap toggle/lookup; [] => no cap (null).
  let allowedLanes = $state<Set<string>>(new Set());
  let allowCustomModel = $state<boolean>(false);
  // Per-key rate limits. null = leave unset → inherit the system default; a number
  // (0 = unlimited) sets an explicit override. A number input binds to number|null
  // (empty field => null), so no string parsing is needed.
  let rpmInput = $state<number | null>(null);
  let tpmInput = $state<number | null>(null);
  // Per-key usage budgets (docs/06). null = no cap for that dimension. windowInput
  // (seconds) sets the rolling window; blank => system default. behavior chooses
  // degrade (drop to a cheaper lane) vs reject (429). degradeLane blank => economy.
  let budgetRequestsInput = $state<number | null>(null);
  let budgetTokensInput = $state<number | null>(null);
  let budgetSpendInput = $state<number | null>(null);
  let budgetWindowInput = $state<number | null>(null);
  let overBudgetBehavior = $state<'degrade' | 'reject'>('degrade');
  let degradeLaneInput = $state<string>('');

  let error = $state<string | null>(null);
  let creating = $state<boolean>(false);

  function toggleLane(lane: string, checked: boolean): void {
    const next = new Set(allowedLanes);
    if (checked) next.add(lane);
    else next.delete(lane);
    allowedLanes = next;
  }
  // The minted plaintext + its key_id live ONLY in this transient state and are
  // cleared on close. While set, the form is replaced by the one-time reveal.
  let revealed = $state<CreatedKey | null>(null);
  let copied = $state<boolean>(false);

  async function handleCreate(): Promise<void> {
    error = null;
    creating = true;
    const input: CreateKeyInput = {
      role,
      allow_custom_model: allowCustomModel,
    };
    if (allowedLanes.size > 0) input.allowed_lanes = [...allowedLanes];
    // Send a rate limit only when the operator set one; blank => inherit default.
    // `!= null` also catches the `undefined` Svelte 5 gives an emptied number input.
    if (rpmInput != null) input.rate_limit_rpm = rpmInput;
    if (tpmInput != null) input.rate_limit_tpm = tpmInput;
    // Usage budgets: send only the dimensions the operator set (blank => no cap).
    if (budgetRequestsInput != null) input.budget_requests = budgetRequestsInput;
    if (budgetTokensInput != null) input.budget_tokens = budgetTokensInput;
    if (budgetSpendInput != null) input.budget_spend_usd = budgetSpendInput;
    if (budgetWindowInput != null) input.budget_window_seconds = budgetWindowInput;
    input.over_budget_behavior = overBudgetBehavior;
    if (degradeLaneInput.length > 0) input.degrade_lane = degradeLaneInput;
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
        allowed_lanes: allowedLanes.size > 0 ? [...allowedLanes] : null,
        allow_custom_model: allowCustomModel,
        disabled: false,
        rate_limit_rpm: rpmInput ?? null,
        rate_limit_tpm: tpmInput ?? null,
        budget_requests: budgetRequestsInput ?? null,
        budget_tokens: budgetTokensInput ?? null,
        budget_spend_usd: budgetSpendInput ?? null,
        budget_window_seconds: budgetWindowInput ?? null,
        over_budget_behavior: overBudgetBehavior,
        degrade_lane: degradeLaneInput.length > 0 ? degradeLaneInput : null,
      };
      oncreated(view);
    }
    // Wipe transient secret state from the component.
    revealed = null;
    copied = false;
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
      {$t(
        'Copy it now — this is the only time it will be shown. We store only a hash, so it cannot be recovered later.',
      )}
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
    <div class="mt-4 flex justify-end">
      <button type="button" class="btn-success" onclick={confirmSaved}>{$t('I saved it')}</button>
    </div>
  {:else}
    <h2 class="section-header">{$t('Create API key')}</h2>

    {#if error}
      <p class="alert-error mt-2" role="alert">
        {error}
      </p>
    {/if}

    <div class="mt-3 flex flex-col gap-3">
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

      <label class="checkbox-field">
        <input
          type="checkbox"
          class="checkbox"
          bind:checked={allowCustomModel}
          aria-label={$t('allow custom model')}
        />
        <span class="text-ink-body">{$t('Allow explicit client-specified model passthrough')}</span>
      </label>
      <span class="field-help"
        >{$t(
          'Lets this client bypass lanes and target a specific model by name. Leave off to keep every request routed through lanes.',
        )}</span
      >

      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="field-label">{$t('Requests per minute (RPM)')}</span>
          <input
            type="number"
            min="0"
            step="1"
            aria-label={$t('Requests per minute (RPM)')}
            placeholder={$t('Default')}
            class="input"
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
            class="input"
            bind:value={tpmInput}
          />
        </label>
      </div>
      <span class="field-help"
        >{$t(
          'Per-key rate limits. Leave blank to use the system default. 0 means unlimited for that dimension.',
        )}</span
      >

      <fieldset class="flex flex-col gap-1 text-sm">
        <legend class="field-label">{$t('Usage budgets')}</legend>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="field-label">{$t('Max requests')}</span>
            <input
              type="number"
              min="1"
              step="1"
              aria-label={$t('Max requests')}
              placeholder={$t('No cap')}
              class="input"
              bind:value={budgetRequestsInput}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="field-label">{$t('Max tokens')}</span>
            <input
              type="number"
              min="1"
              step="1"
              aria-label={$t('Max tokens')}
              placeholder={$t('No cap')}
              class="input"
              bind:value={budgetTokensInput}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="field-label">{$t('Max spend (USD)')}</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              aria-label={$t('Max spend (USD)')}
              placeholder={$t('No cap')}
              class="input"
              bind:value={budgetSpendInput}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="field-label">{$t('Window (seconds)')}</span>
            <input
              type="number"
              min="1"
              step="1"
              aria-label={$t('Window (seconds)')}
              placeholder={$t('Default')}
              class="input"
              bind:value={budgetWindowInput}
            />
          </label>
        </div>
        <label class="mt-1 flex flex-col gap-1">
          <span class="field-label">{$t('When over budget')}</span>
          <select bind:value={overBudgetBehavior} aria-label={$t('When over budget')} class="select">
            <option value="degrade">{$t('Degrade to a cheaper lane')}</option>
            <option value="reject">{$t('Reject (429)')}</option>
          </select>
        </label>
        {#if overBudgetBehavior === 'degrade'}
          <label class="mt-1 flex flex-col gap-1">
            <span class="field-label">{$t('Degrade lane')}</span>
            <select bind:value={degradeLaneInput} aria-label={$t('Degrade lane')} class="select">
              <option value="">{$t('Default (economy)')}</option>
              {#each lanes as lane (lane)}
                <option value={lane}>{lane}</option>
              {/each}
            </select>
          </label>
        {/if}
        <span class="field-help"
          >{$t(
            'Cap usage over a rolling window. Over budget, the key is degraded to a cheaper lane (cost-controlled, service continues) or rejected. Leave caps blank for no budget.',
          )}</span
        >
      </fieldset>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" onclick={onclose}>{$t('Cancel')}</button>
      <button type="button" class="btn-primary" disabled={creating} onclick={handleCreate}
        >{$t('Create key')}</button
      >
    </div>
  {/if}
</Modal>
