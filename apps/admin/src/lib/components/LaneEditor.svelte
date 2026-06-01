<script lang="ts">
  import { untrack } from 'svelte';
  import type { Lane } from '$lib/api/lanes.js';
  import { t } from '$lib/i18n';

  // Single-lane editor. Pure form: it owns NO routing/classification logic
  // (that lives in headless core) — only client-side form validation:
  // non-empty primary, numeric latency, and the `balanced` guard from docs/04
  // (the classification-fallback terminal must always have a primary).
  // `models` is the routable-alias catalog (config.providers[].models[].alias),
  // offered as combobox suggestions on the primary + fallback inputs so the
  // operator picks a real alias instead of hand-typing one (a typo would silently
  // break a fallback chain). Defaulted to [] — when empty the inputs degrade to
  // plain text, so the editor never depends on the catalog being present.
  let {
    lane,
    models = [],
    onsave,
  }: {
    lane: Lane;
    models?: string[];
    onsave: (name: string, body: Lane) => void | Promise<void>;
  } = $props();

  // Local editable copy so a failed save never dirties the parent's data. We
  // intentionally seed from the prop's INITIAL value only (untrack) — the editor
  // then owns its own state; the parent re-keys on save to feed fresh props.
  const initial = untrack(() => lane);
  let primary = $state(initial.primary);
  let fallback = $state<string[]>([...initial.fallback]);
  let requireTools = $state(initial.constraints.require_tools);
  let requireJson = $state(initial.constraints.require_json);
  let maxLatency = $state<number | null>(initial.constraints.max_latency_ms ?? null);
  let newFallback = $state('');
  // Per-card success flag: set when the parent's save resolves without throwing.
  // It is the visible "success notice" the operator (and the e2e) waits for.
  let saved = $state(false);

  const isBalanced = initial.name === 'balanced';
  // Per-card <datalist> id (each lane renders its own editor). Drives the
  // combobox on both the primary and fallback-add inputs.
  const modelsListId = `lane-models-${initial.name}`;

  // Validation. `balanced` must keep a primary (docs/04 hard line); other lanes also
  // need a non-empty primary to be coherent. The hint text differs so ops sees
  // *why* balanced is special.
  const trimmedPrimary = $derived(primary.trim());
  const primaryEmpty = $derived(trimmedPrimary.length === 0);
  const valid = $derived(!primaryEmpty);

  function addFallback(): void {
    const v = newFallback.trim();
    if (v.length === 0) return;
    fallback = [...fallback, v];
    newFallback = '';
  }

  function removeFallback(i: number): void {
    fallback = fallback.filter((_, idx) => idx !== i);
  }

  function moveUp(i: number): void {
    if (i <= 0) return;
    const next = [...fallback];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    fallback = next;
  }

  function moveDown(i: number): void {
    if (i >= fallback.length - 1) return;
    const next = [...fallback];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    fallback = next;
  }

  async function handleSave(): Promise<void> {
    if (!valid) return;
    const body: Lane = {
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
    saved = false;
    // The parent owns user-facing error handling (page-level alert). It re-throws
    // on failure so the per-card success flag is flipped ONLY on a real success;
    // a rejected save leaves `saved` false (fail-closed UX).
    try {
      await onsave(initial.name, body);
      saved = true;
    } catch {
      saved = false;
    }
  }
</script>

<form
  class="card flex flex-col gap-3"
  data-testid="lane-card"
  onsubmit={(e) => {
    e.preventDefault();
    handleSave();
  }}
>
  <header class="flex items-baseline justify-between">
    <h2 class="section-header">{lane.name}</h2>
    {#if lane.purpose}
      <span class="badge-neutral">{lane.purpose}</span>
    {/if}
  </header>

  <label class="flex flex-col gap-1">
    <span class="field-label">{$t('Primary')}</span>
    <input name="primary" class="input" list={modelsListId} bind:value={primary} />
    <span class="field-help">
      {$t('The model this lane uses first. Tried before any fallback.')}
    </span>
  </label>

  <!-- Shared alias catalog for the primary + fallback comboboxes. Empty when no
       catalog was loaded → the inputs behave as plain text fields. -->
  <datalist id={modelsListId}>
    {#each models as alias (alias)}
      <option value={alias}></option>
    {/each}
  </datalist>

  <fieldset class="flex flex-col gap-1">
    <legend class="field-label">{$t('Fallback (ordered)')}</legend>
    <span class="field-help">
      {$t('Tried top to bottom when the primary fails. Order is the try order.')}
    </span>
    <ul class="flex flex-col gap-1">
      {#each fallback as f, i (i + ':' + f)}
        <li
          class="flex items-center gap-2 rounded bg-slate-50 px-2 py-1 text-sm"
          data-testid="fallback-item"
        >
          <span class="badge-fallback">{i + 1}</span>
          <span class="flex-1">{f}</span>
          <button
            type="button"
            class="btn-icon"
            aria-label={`move ${f} up`}
            onclick={() => moveUp(i)}
            disabled={i === 0}>↑</button
          >
          <button
            type="button"
            class="btn-icon"
            aria-label={`move ${f} down`}
            onclick={() => moveDown(i)}
            disabled={i === fallback.length - 1}>↓</button
          >
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
        placeholder={$t('model alias')}
        list={modelsListId}
        data-testid="fallback-add-input"
        bind:value={newFallback}
      />
      <button type="button" class="btn-secondary" onclick={addFallback}>{$t('Add fallback')}</button
      >
    </div>
  </fieldset>

  <div class="flex flex-col gap-1">
    <span class="field-label">{$t('Constraints')}</span>
    <span class="field-help">
      {$t('Optional requirements a model must meet for this lane to use it.')}
    </span>
    <div class="flex flex-wrap items-center gap-4 text-sm">
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={requireTools} />
        <span>{$t('Require tools')}</span>
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={requireJson} />
        <span>{$t('Require JSON')}</span>
      </label>
      <label class="flex items-center gap-2">
        <span>{$t('Max latency (ms)')}</span>
        <input
          type="number"
          min="1"
          class="input w-24"
          value={maxLatency ?? ''}
          oninput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            maxLatency = v === '' ? null : Number(v);
          }}
        />
      </label>
    </div>
  </div>

  {#if primaryEmpty}
    <p class="alert-error" role="alert">
      {#if isBalanced}
        {$t('The')}
        <strong>balanced</strong>
        {$t(
          'lane is the classification fallback terminal — its primary is required and cannot be empty.',
        )}
      {:else}
        {$t('Primary is required and cannot be empty.')}
      {/if}
    </p>
  {/if}

  <div class="flex items-center gap-3">
    <button type="submit" class="btn-primary" disabled={!valid}>{$t('Save')}</button>
    {#if saved}
      <span data-testid="lane-saved" role="status" class="badge-ok">{$t('Saved')}</span>
    {/if}
  </div>
</form>
