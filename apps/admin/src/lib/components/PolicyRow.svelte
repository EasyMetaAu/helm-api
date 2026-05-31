<script lang="ts">
  import { untrack } from 'svelte';
  import {
    COMPLEXITY_OPTIONS,
    type Policy,
    type PolicyMatch,
    TASK_TYPE_OPTIONS,
  } from '$lib/api/policies.js';
  import { t } from '$lib/i18n';

  // Single ordered policy row: a pure "condition → action" editor. It owns NO
  // matching logic (first-match resolution lives in headless core, 原则1/原则5);
  // it only enforces enum constraints (no free text) and the use_lane/max_lane
  // mutual exclusion, then bubbles changes up so the parent owns the ordered list.
  let {
    policy,
    index,
    total,
    lanes,
    onchange,
    onremove,
    onmove,
  }: {
    policy: Policy;
    index: number;
    total: number;
    lanes: string[];
    onchange: (next: Policy) => void;
    onremove: (index: number) => void;
    onmove: (from: number, to: number) => void;
  } = $props();

  type Action = 'use_lane' | 'max_lane';

  // Own an editable copy seeded from the initial prop. The component accumulates
  // edits locally and bubbles the WHOLE policy up on every change, so the parent
  // (which owns the ordered list) need not feed props back synchronously between
  // two edits. Action is mutually exclusive (docs/04: use_lane OR max_lane).
  const initial = untrack(() => policy);
  let match = $state<PolicyMatch>({ ...initial.match });
  let useLane = $state<string>(initial.use_lane ?? '');
  let maxLane = $state<string>(initial.max_lane ?? '');
  let action = $state<Action>(
    initial.max_lane != null && initial.use_lane == null ? 'max_lane' : 'use_lane',
  );

  const isCatchAll = $derived(Object.keys(match).length === 0);

  // Assemble the current policy and bubble it up. Only the active action field is
  // included so the saved body never carries both (mutual exclusion).
  function emit(): void {
    const next: Policy = { ...initial, match: { ...match } };
    if (action === 'use_lane') {
      next.use_lane = useLane === '' ? undefined : useLane;
      next.max_lane = undefined;
    } else {
      next.max_lane = maxLane === '' ? undefined : maxLane;
      next.use_lane = undefined;
    }
    onchange(next);
  }

  function emitMatch(patch: Partial<PolicyMatch>): void {
    match = { ...match, ...patch };
    // strip cleared keys so an empty selection ("") becomes an unset field
    for (const k of Object.keys(match) as (keyof PolicyMatch)[]) {
      const v = match[k];
      if (v === '' || v === undefined) delete match[k];
    }
    emit();
  }

  function setAction(next: Action): void {
    action = next;
    emit();
  }

  function setLane(next: Action, value: string): void {
    action = next;
    if (next === 'use_lane') useLane = value;
    else maxLane = value;
    emit();
  }
</script>

<div class="card flex flex-col gap-3" data-testid="policy-row">
  <header class="flex items-center gap-2">
    <span
      class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white"
      data-testid="policy-index"
      aria-label={$t('priority')}>{index + 1}</span
    >
    <span class="text-xs text-ink-muted"
      >{$t('first match wins — lower number = higher priority')}</span
    >
    <span class="flex-1"></span>
    <button
      type="button"
      class="btn-icon"
      aria-label={$t('move up')}
      onclick={() => onmove(index, index - 1)}
      disabled={index === 0}>↑</button
    >
    <button
      type="button"
      class="btn-icon"
      aria-label={$t('move down')}
      onclick={() => onmove(index, index + 1)}
      disabled={index === total - 1}>↓</button
    >
    <button
      type="button"
      class="rounded px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
      aria-label={$t('remove')}
      onclick={() => onremove(index)}>{$t('Remove')}</button
    >
  </header>

  {#if isCatchAll}
    <p class="alert-warn text-xs" data-testid="catch-all-warning" role="note">
      {$t(
        'Empty match = catch-all. It matches every request and, by first-match order, swallows any rule below it — keep it last.',
      )}
    </p>
  {/if}

  <fieldset class="flex flex-col gap-3">
    <legend class="field-label">{$t('When a request matches ALL of:')}</legend>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Task type')}</span>
        <select
          class="select"
          value={match.task_type ?? ''}
          onchange={(e) => emitMatch({ task_type: e.currentTarget.value })}
        >
          <option value="">{$t('(any)')}</option>
          {#each TASK_TYPE_OPTIONS as opt (opt)}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Complexity')}</span>
        <select
          class="select"
          value={match.complexity ?? ''}
          onchange={(e) => emitMatch({ complexity: e.currentTarget.value })}
        >
          <option value="">{$t('(any)')}</option>
          {#each COMPLEXITY_OPTIONS as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>

      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          checked={match.needs_json === true}
          onchange={(e) => emitMatch({ needs_json: e.currentTarget.checked ? true : undefined })}
        />
        <span class="flex flex-col">
          <span class="field-label">{$t('Requires JSON output')}</span>
          <span class="field-help">{$t('Match requests that ask for a JSON response.')}</span>
        </span>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('User ID')}</span>
        <input
          class="input"
          value={match.user_id ?? ''}
          oninput={(e) => emitMatch({ user_id: e.currentTarget.value })}
        />
        <span class="field-help">{$t('Match a single end-user by their ID.')}</span>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="field-label">{$t('Organization ID')}</span>
        <input
          class="input"
          value={match.org_id ?? ''}
          oninput={(e) => emitMatch({ org_id: e.currentTarget.value })}
        />
        <span class="field-help">{$t('Match every request from one organization.')}</span>
      </label>
    </div>
  </fieldset>

  <fieldset class="flex flex-col gap-2">
    <legend class="field-label">{$t('Then do one of:')}</legend>
    <p class="field-help">
      {$t(
        'Force lane sends matching requests to that lane. Cap lane sets the highest lane allowed — requests may use a cheaper one, but never a higher tier.',
      )}
    </p>

    <div class="flex flex-wrap items-start gap-6">
      <label class="flex flex-col gap-1 text-sm">
        <span
          class="field-label"
          class:text-ink-strong={action === 'use_lane'}
          class:text-ink-faint={action !== 'use_lane'}>{$t('Force lane')}</span
        >
        <select
          aria-label={$t('use lane')}
          class="select disabled:bg-slate-100 disabled:opacity-50"
          disabled={action !== 'use_lane'}
          value={useLane}
          onclick={() => setAction('use_lane')}
          onchange={(e) => setLane('use_lane', e.currentTarget.value)}
        >
          <option value="">{$t('(select lane)')}</option>
          {#each lanes as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span
          class="field-label"
          class:text-ink-strong={action === 'max_lane'}
          class:text-ink-faint={action !== 'max_lane'}>{$t('Cap lane (maximum)')}</span
        >
        <select
          aria-label={$t('max lane')}
          class="select disabled:bg-slate-100 disabled:opacity-50"
          disabled={action !== 'max_lane'}
          value={maxLane}
          onclick={() => setAction('max_lane')}
          onchange={(e) => setLane('max_lane', e.currentTarget.value)}
        >
          <option value="">{$t('(select lane)')}</option>
          {#each lanes as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>
    </div>
  </fieldset>
</div>
