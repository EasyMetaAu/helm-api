<script lang="ts">
  import { untrack } from 'svelte';
  import {
    COMPLEXITY_OPTIONS,
    type Policy,
    type PolicyMatch,
    REASONING_EFFORTS,
    type ReasoningEffort,
    TASK_TYPE_OPTIONS,
  } from '$lib/api/policies.js';
  import { t } from '$lib/i18n';

  // Single ordered policy row: a pure "condition → action" editor. It owns NO
  // matching logic (first-match resolution lives in headless core, Principle 1/Principle 5);
  // it only enforces enum constraints (no free text), then bubbles changes up so
  // the parent owns the ordered list. Actions can force the matching requests onto
  // a lane and/or force reasoning effort; per-key `allowed_lanes` is the restrict knob.
  let {
    policy,
    index,
    total,
    lanes,
    dragging = false,
    dropTarget = false,
    onchange,
    onremove,
    onmove,
    ondragstart = () => {},
    ondragover = () => {},
    ondrop = () => {},
    ondragend = () => {},
    onpointerstart = () => {},
  }: {
    policy: Policy;
    index: number;
    total: number;
    lanes: string[];
    dragging?: boolean;
    dropTarget?: boolean;
    onchange: (next: Policy) => void;
    onremove: (index: number) => void;
    onmove: (from: number, to: number) => void;
    ondragstart?: (index: number, event: DragEvent) => void;
    ondragover?: (index: number, event: DragEvent) => void;
    ondrop?: (index: number, event: DragEvent) => void;
    ondragend?: () => void;
    onpointerstart?: (index: number, event: PointerEvent) => void;
  } = $props();

  // Own an editable copy seeded from the initial prop. The component accumulates
  // edits locally and bubbles the WHOLE policy up on every change, so the parent
  // (which owns the ordered list) need not feed props back synchronously between
  // two edits.
  const initial = untrack(() => policy);
  let match = $state<PolicyMatch>({ ...initial.match });
  let useLane = $state<string>(initial.use_lane ?? '');
  let reasoningEffort = $state<ReasoningEffort | ''>(initial.reasoning_effort ?? '');

  const isCatchAll = $derived(Object.keys(match).length === 0);

  // Assemble the current policy and bubble it up.
  function emit(): void {
    const next: Policy = { ...initial, match: { ...match } };
    next.use_lane = useLane === '' ? undefined : useLane;
    next.reasoning_effort = reasoningEffort === '' ? undefined : reasoningEffort;
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

  function setLane(value: string): void {
    useLane = value;
    emit();
  }

  function setReasoningEffort(value: string): void {
    reasoningEffort = value as ReasoningEffort | '';
    emit();
  }

  function handleDragKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onmove(index, index - 1);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      onmove(index, index + 1);
    }
  }
</script>

<div
  class={`card flex flex-col gap-3 transition-shadow ${
    dragging ? 'opacity-60 ring-2 ring-slate-300' : ''
  } ${dropTarget ? 'ring-2 ring-slate-400' : ''}`}
  data-testid="policy-row"
  role="group"
  aria-label={`${$t('priority')} ${index + 1}`}
  ondragover={(event) => ondragover(index, event)}
  ondrop={(event) => ondrop(index, event)}
>
  <header class="flex items-center gap-2">
    <button
      type="button"
      class="btn-icon shrink-0 cursor-grab text-slate-400 hover:text-slate-700 active:cursor-grabbing"
      aria-label={$t('drag to reorder policy')}
      title={$t('drag to reorder policy')}
      disabled={total < 2}
      data-testid="policy-drag-handle"
      ondragstart={(event) => ondragstart(index, event)}
      ondragend={ondragend}
      onpointerdown={(event) => onpointerstart(index, event)}
      onkeydown={handleDragKeydown}
    >
      <svg viewBox="0 0 20 20" class="h-4 w-4" fill="currentColor" aria-hidden="true">
        <path
          d="M7 5.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0 4.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm-1.25 6a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm9.75-10.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM14.25 11.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm1.25 3.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"
        />
      </svg>
    </button>
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
      class="btn-icon hover:bg-red-50 hover:text-red-600"
      aria-label={$t('remove')}
      onclick={() => onremove(index)}>✕</button
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

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label class="field">
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

      <label class="field">
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
    </div>

    <label class="checkbox-field items-start">
      <input
        type="checkbox"
        class="checkbox mt-0.5"
        checked={match.needs_json === true}
        onchange={(e) => emitMatch({ needs_json: e.currentTarget.checked ? true : undefined })}
      />
      <span class="flex flex-col">
        <span class="field-label">{$t('Requires JSON output')}</span>
        <span class="field-help">{$t('Match requests that ask for a JSON response.')}</span>
      </span>
    </label>
  </fieldset>

  <fieldset class="flex flex-col gap-2">
    <legend class="field-label">{$t('Then apply actions:')}</legend>
    <p class="field-help">{$t('Force lane sends matching requests to that lane.')}</p>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">{$t('Force lane')}</span>
        <select
          aria-label={$t('use lane')}
          class="select"
          value={useLane}
          onchange={(e) => setLane(e.currentTarget.value)}
        >
          <option value="">{$t('(select lane)')}</option>
          {#each lanes as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="field-label">{$t('Forced reasoning effort')}</span>
        <select
          aria-label={$t('policy reasoning effort')}
          class="select"
          value={reasoningEffort}
          onchange={(e) => setReasoningEffort(e.currentTarget.value)}
        >
          <option value="">{$t('Unset (lane/client decides)')}</option>
          {#each REASONING_EFFORTS as eff (eff)}
            <option value={eff}>{eff}</option>
          {/each}
        </select>
        <span class="field-help">
          {$t('Policy value overrides the selected lane and client reasoning effort.')}
        </span>
      </label>
    </div>
  </fieldset>
</div>
