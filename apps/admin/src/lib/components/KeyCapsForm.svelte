<script module lang="ts">
  import type { ApiKeyView } from '$lib/api/keys.js';

  // Shared editing buffer for every per-key cap. Both key dialogs (create + edit)
  // own ONE of these and render the same <KeyCapsForm> over it, so the two forms
  // can never drift apart. null = "leave unset" (inherit default / no cap).
  export type KeyCaps = {
    allowedLanes: string[];
    allowCustomModel: boolean;
    rpm: number | null;
    tpm: number | null;
    concurrencyLimit: number | null;
    budgetRequests: number | null;
    budgetTokens: number | null;
    budgetSpend: number | null;
    budgetWindow: number | null;
    overBudgetBehavior: 'degrade' | 'reject';
    degradeLane: string;
    memoryMode: 'off' | 'observe' | 'inject';
    memoryProject: string;
    memoryThreadSource: 'header' | 'auto';
  };

  /** Fresh buffer for the create dialog — nothing capped, everything default. */
  export function emptyKeyCaps(): KeyCaps {
    return {
      allowedLanes: [],
      allowCustomModel: false,
      rpm: null,
      tpm: null,
      concurrencyLimit: null,
      budgetRequests: null,
      budgetTokens: null,
      budgetSpend: null,
      budgetWindow: null,
      overBudgetBehavior: 'degrade',
      degradeLane: '',
      memoryMode: 'off',
      memoryProject: '',
      // Mirrors the keystore mint-default: a new key derives its thread automatically
      // (issue #97). The operator can switch to 'header' to opt out.
      memoryThreadSource: 'auto',
    };
  }

  /** Pre-filled buffer for the edit dialog, projected from the redacted view. */
  export function keyCapsFromView(key: ApiKeyView): KeyCaps {
    return {
      allowedLanes: [...(key.allowed_lanes ?? [])],
      allowCustomModel: key.allow_custom_model,
      rpm: key.rate_limit_rpm,
      tpm: key.rate_limit_tpm,
      concurrencyLimit: key.concurrency_limit,
      budgetRequests: key.budget_requests,
      budgetTokens: key.budget_tokens,
      budgetSpend: key.budget_spend_usd,
      budgetWindow: key.budget_window_seconds,
      overBudgetBehavior: key.over_budget_behavior,
      degradeLane: key.degrade_lane ?? '',
      memoryMode: key.memory_mode,
      memoryProject: key.memory_project_id ?? '',
      memoryThreadSource: key.memory_thread_source,
    };
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';

  // Progressive disclosure: the two fields that define what the key can REACH
  // (lanes + passthrough) are always visible; the tuning groups most operators
  // never touch (rates, budgets, memory) are collapsed <details> sections, each
  // with a one-line state summary so a closed section is never a mystery.
  let {
    form = $bindable(),
    lanes,
    expandConfigured = false,
  }: {
    form: KeyCaps;
    lanes: string[];
    expandConfigured?: boolean;
  } = $props();

  // Initial open state, computed ONCE at mount: the edit dialog passes
  // expandConfigured so sections holding real values start open (hiding an
  // active cap behind a closed fold would invite blind edits); the create
  // dialog starts with everything folded.
  let openRates = $state(
    untrack(
      () =>
        expandConfigured && (form.rpm != null || form.tpm != null || form.concurrencyLimit != null),
    ),
  );
  let openBudget = $state(
    untrack(
      () =>
        expandConfigured &&
        (form.budgetRequests != null ||
          form.budgetTokens != null ||
          form.budgetSpend != null ||
          form.budgetWindow != null),
    ),
  );
  let openMemory = $state(untrack(() => expandConfigured && form.memoryMode !== 'off'));

  function toggleLane(lane: string, checked: boolean): void {
    form.allowedLanes = checked
      ? [...form.allowedLanes, lane]
      : form.allowedLanes.filter((l) => l !== lane);
  }

  // One-line state recaps shown on the closed section headers.
  const ratesSummary = $derived.by(() => {
    const parts: string[] = [];
    if (form.rpm != null) parts.push(`RPM ${form.rpm}`);
    if (form.tpm != null) parts.push(`TPM ${form.tpm}`);
    if (form.concurrencyLimit != null)
      parts.push($t('Concurrency {n}', { n: form.concurrencyLimit }));
    return parts.length > 0 ? parts.join(' · ') : $t('Using system defaults');
  });
  const budgetSummary = $derived.by(() => {
    const parts: string[] = [];
    if (form.budgetRequests != null) parts.push($t('{n} req', { n: form.budgetRequests }));
    if (form.budgetTokens != null) parts.push($t('{n} tokens', { n: form.budgetTokens }));
    if (form.budgetSpend != null) parts.push(`$${form.budgetSpend}`);
    if (parts.length === 0) return $t('No budget');
    parts.push(form.overBudgetBehavior === 'degrade' ? $t('degrade') : $t('reject'));
    return parts.join(' · ');
  });
  const memorySummary = $derived.by(() => {
    if (form.memoryMode === 'off') return $t('Off');
    const parts = [form.memoryMode === 'observe' ? $t('Observe') : $t('Inject')];
    if (form.memoryThreadSource === 'auto') parts.push($t('auto thread'));
    if (form.memoryProject.length > 0) parts.push(form.memoryProject);
    return parts.join(' · ');
  });
</script>

{#snippet sectionHead(title: string, open: boolean, summary: string)}
  <svg
    class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform {open ? 'rotate-90' : ''}"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
  <span class="field-label">{title}</span>
  <span class="badge-neutral">{$t('Optional')}</span>
  {#if !open}
    <span class="ml-auto truncate pl-2 text-xs text-slate-500">{summary}</span>
  {/if}
{/snippet}

<!-- Basics: what the key can reach. Always visible. -->
<fieldset class="flex flex-col gap-1 text-sm">
  <legend class="field-label">{$t('Allowed lanes')}</legend>
  <div class="flex flex-wrap gap-3">
    {#each lanes as lane (lane)}
      <label class="flex items-center gap-1.5">
        <input
          type="checkbox"
          class="checkbox"
          checked={form.allowedLanes.includes(lane)}
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

<div class="flex flex-col gap-1">
  <label class="checkbox-field">
    <input
      type="checkbox"
      class="checkbox"
      bind:checked={form.allowCustomModel}
      aria-label={$t('allow custom model')}
    />
    <span class="text-ink-body">{$t('Allow explicit client-specified model passthrough')}</span>
  </label>
  <span class="field-help"
    >{$t(
      'Lets this client bypass lanes and target a specific model by name. Leave off to keep every request routed through lanes.',
    )}</span
  >
</div>

<!-- Optional tuning, folded by default. -->
<details class="form-section" bind:open={openRates}>
  <summary class="form-section-summary">
    {@render sectionHead($t('Rate & concurrency'), openRates, ratesSummary)}
  </summary>
  <div class="form-section-body">
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
          bind:value={form.rpm}
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
          bind:value={form.tpm}
        />
      </label>
    </div>
    <span class="field-help"
      >{$t(
        'Per-key rate limits. Leave blank to use the system default. 0 means unlimited for that dimension.',
      )}</span
    >
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Max concurrent requests')}</span>
      <input
        type="number"
        min="1"
        step="1"
        aria-label={$t('Max concurrent requests')}
        placeholder={$t('Unlimited')}
        class="input"
        bind:value={form.concurrencyLimit}
      />
      <span class="field-help"
        >{$t(
          'Cap how many requests this key may run at once. Extra requests queue when request queueing is enabled in System Settings. Leave blank for unlimited.',
        )}</span
      >
    </label>
  </div>
</details>

<details class="form-section" bind:open={openBudget}>
  <summary class="form-section-summary">
    {@render sectionHead($t('Usage budgets'), openBudget, budgetSummary)}
  </summary>
  <div class="form-section-body">
    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Max requests')}</span>
        <input
          type="number"
          min="1"
          step="1"
          aria-label={$t('Max requests')}
          placeholder={$t('No cap')}
          class="input"
          bind:value={form.budgetRequests}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Max tokens')}</span>
        <input
          type="number"
          min="1"
          step="1"
          aria-label={$t('Max tokens')}
          placeholder={$t('No cap')}
          class="input"
          bind:value={form.budgetTokens}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Max spend (USD)')}</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          aria-label={$t('Max spend (USD)')}
          placeholder={$t('No cap')}
          class="input"
          bind:value={form.budgetSpend}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Window (seconds)')}</span>
        <input
          type="number"
          min="1"
          step="1"
          aria-label={$t('Window (seconds)')}
          placeholder={$t('Default')}
          class="input"
          bind:value={form.budgetWindow}
        />
      </label>
    </div>
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('When over budget')}</span>
      <select
        bind:value={form.overBudgetBehavior}
        aria-label={$t('When over budget')}
        class="select"
      >
        <option value="degrade">{$t('Degrade to a cheaper lane')}</option>
        <option value="reject">{$t('Reject (429)')}</option>
      </select>
    </label>
    {#if form.overBudgetBehavior === 'degrade'}
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Degrade lane')}</span>
        <select bind:value={form.degradeLane} aria-label={$t('Degrade lane')} class="select">
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
  </div>
</details>

<details class="form-section" bind:open={openMemory}>
  <summary class="form-section-summary">
    {@render sectionHead($t('Memory defaults'), openMemory, memorySummary)}
  </summary>
  <div class="form-section-body">
    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Memory mode')}</span>
        <select class="select" aria-label={$t('Memory mode')} bind:value={form.memoryMode}>
          <option value="off">{$t('Off')}</option>
          <option value="observe">{$t('Observe (record only)')}</option>
          <option value="inject">{$t('Inject (record + hydrate)')}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Thread source')}</span>
        <select
          class="select"
          aria-label={$t('Thread source')}
          bind:value={form.memoryThreadSource}
        >
          <option value="header">{$t('Header only (x-thread-id)')}</option>
          <option value="auto">{$t('Auto (derive from client signals)')}</option>
        </select>
      </label>
    </div>
    <label class="flex flex-col gap-1 text-sm">
      <span class="field-label">{$t('Default project id')}</span>
      <input
        type="text"
        aria-label={$t('Default project id')}
        placeholder={$t('None')}
        class="input"
        bind:value={form.memoryProject}
      />
    </label>
    <span class="field-help"
      >{$t(
        'Server-side memory defaults for clients that cannot send dynamic headers (Claude Code, Codex). Explicit x-memory-* request headers always override. Auto thread source derives the conversation from signals the client already sends (prompt_cache_key, metadata.user_id, x-session-key).',
      )}</span
    >
  </div>
</details>
