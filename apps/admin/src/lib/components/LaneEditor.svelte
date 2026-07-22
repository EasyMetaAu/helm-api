<script lang="ts">
  import { untrack } from 'svelte';
  import { type Lane, REASONING_EFFORTS, type ReasoningEffort } from '$lib/api/lanes.js';
  import type { ModelOption } from '$lib/api/models.js';
  import { t } from '$lib/i18n';

  // Single-lane editor. Pure form: it owns NO routing/classification logic
  // (that lives in headless core) — only client-side form validation:
  // non-empty primary and numeric latency.
  // `models` is the routable-alias catalog (config.providers[].models[].alias),
  // offered as combobox suggestions on the primary + fallback inputs so the
  // operator picks a real alias instead of hand-typing one (a typo would silently
  // break a fallback chain). Defaulted to [] — when empty the inputs degrade to
  // plain text, so the editor never depends on the catalog being present.
  // `laneNames` is the set of all configured lane names: a chain element may be
  // a model alias OR another lane name (core's expandChain flattens lane refs,
  // see docs/04). We surface the OTHER lanes as suggestions too — minus this
  // lane's own name, since a lane targeting itself is meaningless (the expander
  // would just dedupe it). Labelled in the datalist so they read distinctly from
  // model aliases.
  let {
    lane,
    models = [],
    laneNames = [],
    canDelete = true,
    onchange,
    ondelete = () => {},
  }: {
    lane: Lane;
    models?: ModelOption[];
    laneNames?: string[];
    canDelete?: boolean;
    onchange: (lane: Lane) => void;
    ondelete?: (name: string) => void;
  } = $props();

  // Local editable copy seeded from the prop's initial value. Each edit emits a
  // complete lane into the page-level working set; a failed save leaves those
  // unsaved values visible so the operator can correct or retry them.
  const initial = untrack(() => lane);
  let primary = $state(initial.primary);
  let fallback = $state<string[]>([...initial.fallback]);
  let requireTools = $state(initial.constraints.require_tools);
  let requireJson = $state(initial.constraints.require_json);
  let maxLatency = $state<number | null>(initial.constraints.max_latency_ms ?? null);
  // Lane-forced reasoning effort; '' = unforced (the request-driven default).
  let reasoningEffort = $state<ReasoningEffort | ''>(initial.reasoning_effort ?? '');
  let newFallback = $state('');
  let draggingIndex = $state<number | null>(null);
  let stopPointerDrag: (() => void) | null = null;
  let fallbackList: HTMLUListElement | undefined;

  // Per-card <datalist> id (each lane renders its own editor). Drives the
  // combobox on both the primary and fallback-add inputs.
  const modelsListId = `lane-models-${initial.name}`;
  // Other lanes this lane may chain to — its own name is excluded (no self-loops).
  const laneOptions = $derived(laneNames.filter((n) => n !== initial.name));

  // Secondary label shown beside each model option in the datalist: the exposing
  // subscription account(s) for OAuth models (e.g. "default", "default, mylukin"),
  // else the provider name (the `provider/` prefix) for configured models — so
  // every option carries a source hint, not just the subscription ones.
  function modelLabel(alias: string, accounts: string[]): string | undefined {
    if (accounts.length > 0) return accounts.join(', ');
    const slash = alias.indexOf('/');
    return slash > 0 ? alias.slice(0, slash) : undefined;
  }

  // Every lane needs a non-empty primary to be coherent; no lane name is special.
  const trimmedPrimary = $derived(primary.trim());
  const primaryEmpty = $derived(trimmedPrimary.length === 0);

  function emit(): void {
    const next: Lane = {
      ...initial,
      primary: trimmedPrimary,
      fallback: [...fallback],
      constraints: {
        ...initial.constraints,
        require_tools: requireTools,
        require_json: requireJson,
        max_latency_ms: maxLatency,
      },
    };
    if (reasoningEffort) next.reasoning_effort = reasoningEffort;
    else delete next.reasoning_effort;
    onchange(next);
  }

  function addFallback(): void {
    const v = newFallback.trim();
    if (v.length === 0) return;
    fallback = [...fallback, v];
    newFallback = '';
    emit();
  }

  function removeFallback(i: number): void {
    fallback = fallback.filter((_, idx) => idx !== i);
    emit();
  }

  function moveFallback(from: number, to: number): void {
    if (from === to || from < 0 || from >= fallback.length || to < 0 || to >= fallback.length) {
      return;
    }
    const next = [...fallback];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    fallback = next;
    emit();
  }

  function handleDragStart(index: number, event: DragEvent): void {
    draggingIndex = index;
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function finishDrag(): void {
    stopPointerDrag?.();
    stopPointerDrag = null;
    draggingIndex = null;
  }

  function handleDrop(index: number, event: DragEvent): void {
    event.preventDefault();
    const from = draggingIndex ?? Number(event.dataTransfer?.getData('text/plain'));
    if (Number.isInteger(from)) moveFallback(from, index);
    finishDrag();
  }

  function targetIndex(clientY: number): number {
    const items = Array.from(fallbackList?.children ?? []);
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return items.length - 1;
  }

  function handlePointerStart(index: number, event: PointerEvent): void {
    if (event.button !== 0 || fallback.length < 2) return;
    finishDrag();
    event.preventDefault();
    draggingIndex = index;
    const pointerId = event.pointerId;
    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId || draggingIndex === null) return;
      next.preventDefault();
      const to = targetIndex(next.clientY);
      if (to >= 0 && to !== draggingIndex) {
        moveFallback(draggingIndex, to);
        draggingIndex = to;
      }
    };
    const onUp = (next: PointerEvent) => {
      if (next.pointerId === pointerId) finishDrag();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    stopPointerDrag = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }

  function handleDragKeydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFallback(index, index - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFallback(index, index + 1);
    }
  }
</script>

<section class="card flex flex-col gap-3" data-testid="lane-card">
  <header class="flex items-center justify-between gap-3">
    <h2 class="section-header">{lane.name}</h2>
    <div class="flex items-center gap-2">
      {#if lane.purpose}
        <span class="badge-neutral">{lane.purpose}</span>
      {/if}
      <button
        type="button"
        class="btn-danger-outline"
        disabled={!canDelete}
        onclick={() => ondelete(initial.name)}>{$t('Delete')}</button
      >
    </div>
  </header>

  <label class="flex flex-col gap-1">
    <span class="field-label">{$t('Primary')}</span>
    <input
      name="primary"
      class="input"
      list={modelsListId}
      value={primary}
      oninput={(event) => {
        primary = event.currentTarget.value;
        emit();
      }}
    />
    <span class="field-help">
      {$t('The model this lane uses first. Tried before any fallback.')}
    </span>
  </label>

  <!-- Shared suggestion list for the primary + fallback comboboxes: other lanes
       (labelled, so they read as tiers) followed by the model-alias catalog.
       Empty when neither is loaded → the inputs behave as plain text fields. -->
  <datalist id={modelsListId}>
    {#each laneOptions as ln (ln)}
      <option value={ln} label={$t('lane')}></option>
    {/each}
    {#each models as { alias, accounts } (alias)}
      <!-- label = the subscription account(s) backing this model (e.g. "default" /
           "default, mylukin"); for configured providers with no account it falls
           back to the provider name, so every option shows a source hint. -->
      <option value={alias} label={modelLabel(alias, accounts)}></option>
    {/each}
  </datalist>

  <fieldset class="flex flex-col gap-1">
    <legend class="field-label">{$t('Fallback (ordered)')}</legend>
    <span class="field-help">
      {$t('Tried top to bottom when the primary fails. Order is the try order.')}
    </span>
    <ul class="flex flex-col gap-1" bind:this={fallbackList}>
      {#each fallback as f, i (i + ':' + f)}
        <li
          class={`flex items-center gap-2 rounded bg-slate-50 px-2 py-1 text-sm ${draggingIndex === i ? 'opacity-60 ring-2 ring-slate-300' : ''}`}
          data-testid="fallback-item"
          ondragover={(event) => event.preventDefault()}
          ondrop={(event) => handleDrop(i, event)}
        >
          <button
            type="button"
            class="btn-icon shrink-0 cursor-grab text-slate-400 hover:text-slate-700 active:cursor-grabbing"
            aria-label={$t('drag to reorder fallback')}
            title={$t('drag to reorder fallback')}
            disabled={fallback.length < 2}
            draggable={fallback.length > 1}
            ondragstart={(event) => handleDragStart(i, event)}
            ondragend={finishDrag}
            onpointerdown={(event) => handlePointerStart(i, event)}
            onkeydown={(event) => handleDragKeydown(i, event)}
          >
            <svg viewBox="0 0 20 20" class="h-4 w-4" fill="currentColor" aria-hidden="true">
              <path
                d="M7 5.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0 4.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm-1.25 6a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm9.75-10.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM14.25 11.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm1.25 3.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"
              />
            </svg>
          </button>
          <span class="badge-fallback">{i + 1}</span>
          <span class="flex-1">{f}</span>
          <button
            type="button"
            class="btn-icon"
            aria-label={`remove ${f}`}
            onclick={() => removeFallback(i)}>✕</button
          >
        </li>
      {/each}
      {#if fallback.length === 0}
        <li class="text-sm text-ink-muted">
          {$t('No fallback models yet. Add one below.')}
        </li>
      {/if}
    </ul>
    <div class="flex gap-2">
      <input
        class="input flex-1"
        placeholder={$t('model or lane')}
        list={modelsListId}
        data-testid="fallback-add-input"
        bind:value={newFallback}
      />
      <button type="button" class="btn-secondary" onclick={addFallback}>{$t('Add fallback')}</button
      >
    </div>
  </fieldset>

  <div class="flex flex-col gap-2">
    <span class="field-label">{$t('Constraints')}</span>
    <span class="field-help">
      {$t('Optional requirements a model must meet for this lane to use it.')}
    </span>
    <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
      <label class="checkbox-field">
        <input
          type="checkbox"
          class="checkbox"
          checked={requireTools}
          onchange={(event) => {
            requireTools = event.currentTarget.checked;
            emit();
          }}
        />
        <span>{$t('Require tools')}</span>
      </label>
      <label class="checkbox-field">
        <input
          type="checkbox"
          class="checkbox"
          checked={requireJson}
          onchange={(event) => {
            requireJson = event.currentTarget.checked;
            emit();
          }}
        />
        <span>{$t('Require JSON')}</span>
      </label>
    </div>
    <label class="field">
      <span class="field-label">{$t('Max latency (ms)')}</span>
      <input
        type="number"
        min="1"
        class="input-sm w-32"
        value={maxLatency ?? ''}
        oninput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          maxLatency = v === '' ? null : Number(v);
          emit();
        }}
      />
    </label>
  </div>

  <label class="field flex flex-col gap-1">
    <span class="field-label">{$t('Forced reasoning effort')}</span>
    <select
      class="input-sm w-44"
      data-testid="reasoning-effort"
      value={reasoningEffort}
      onchange={(event) => {
        reasoningEffort = event.currentTarget.value as ReasoningEffort | '';
        emit();
      }}
    >
      <option value="">{$t('Unset (client decides)')}</option>
      {#each REASONING_EFFORTS as eff (eff)}
        <option value={eff}>{eff}</option>
      {/each}
    </select>
    <span class="field-help">
      {$t('When set, overrides the client reasoning effort for every request on this lane.')}
    </span>
  </label>

  {#if primaryEmpty}
    <p class="alert-error" role="alert">
      {$t('Primary is required and cannot be empty.')}
    </p>
  {/if}
</section>
