<script lang="ts">
  import { untrack } from 'svelte';
  import { saveClassifier, type ClassifierConfig } from '$lib/api/classifier.js';
  import DimensionTable from '$lib/components/DimensionTable.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests). The
  // page runs NO classification logic (原则1): it only flips eval on/off, edits
  // the confidence threshold within [0,1], and renders the read-only rule
  // dimensions / eval details. It writes back via the API client only.
  let { data }: { data: { classifier: ClassifierConfig } } = $props();

  const cfg = untrack(() => data.classifier);

  // The two editable knobs.
  let evalEnabled = $state(untrack(() => cfg.eval.enabled));
  let thresholdText = $state(untrack(() => String(cfg.rules.confidence_threshold)));

  let error = $state<string | null>(null);
  let saving = $state(false);

  // Validation: threshold must parse to a finite number in [0,1] (fail-closed,
  // 原则2 — the UI never guesses a legal value for the operator).
  // `bind:value` on a number input yields a number (or NaN when blank/invalid);
  // normalize to a string for parsing so validation is robust either way.
  const thresholdStr = $derived(String(thresholdText));
  const thresholdValue = $derived(Number(thresholdStr));
  const thresholdValid = $derived(
    thresholdStr.trim() !== '' &&
      thresholdStr.trim().toLowerCase() !== 'nan' &&
      Number.isFinite(thresholdValue) &&
      thresholdValue >= 0 &&
      thresholdValue <= 1,
  );

  async function handleSave(): Promise<void> {
    if (!thresholdValid) return; // hard guard: never write an out-of-range value
    error = null;
    saving = true;
    try {
      const saved = await saveClassifier({
        eval_enabled: evalEnabled,
        confidence_threshold: thresholdValue,
      });
      // Reflect the persisted view.
      evalEnabled = saved.eval.enabled;
      thresholdText = String(saved.rules.confidence_threshold);
    } catch (e) {
      // fail-closed: surface the error and leave the displayed config unchanged.
      error = e instanceof Error ? e.message : 'Failed to save classifier config';
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-6 px-4 py-6 md:px-8">
  <header>
    <h1 class="text-2xl font-semibold text-slate-900">{$t('Classifier')}</h1>
    <p class="text-sm text-slate-500">
      {$t(
        'Layer-1 rules are always on (deterministic, zero-cost). Toggle the optional Layer-2 eval and tune the confidence threshold below it.',
      )}
    </p>
  </header>

  {#if error}
    <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {error}
    </p>
  {/if}

  <!-- Editable knobs -->
  <div class="flex flex-col gap-4 rounded border border-slate-200 p-4">
    <label class="flex items-center gap-3">
      <input type="checkbox" name="eval_enabled" bind:checked={evalEnabled} />
      <span class="text-sm font-medium text-slate-800">Enable Layer-2 eval</span>
      <span class="text-xs text-slate-500">(off by default; cached; fails open to balanced)</span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm font-medium text-slate-800">Confidence threshold</span>
      <input
        type="number"
        name="confidence_threshold"
        step="0.01"
        min="0"
        max="1"
        bind:value={thresholdText}
        class="w-32 rounded border border-slate-300 px-2 py-1 text-sm"
        class:border-red-400={!thresholdValid}
        aria-invalid={!thresholdValid}
      />
      <span class="text-xs text-slate-500">Below this, requests fall through to Layer-2.</span>
      {#if !thresholdValid}
        <span class="text-xs text-red-600" role="alert">
          Threshold must be a number between 0 and 1.
        </span>
      {/if}
    </label>

    <div>
      <button
        type="button"
        onclick={handleSave}
        disabled={!thresholdValid || saving}
        class="rounded bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>

  <!-- Read-only: rule dimensions -->
  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-slate-900">Rule dimensions</h2>
    <p class="text-xs text-slate-500">
      Read-only. Weights/boundaries are data in <code>classifier.yaml</code>; edit there and restart
      to retune.
    </p>
    <DimensionTable dimensions={cfg.rules.dimensions} />
    {#if cfg.rules.boundaries}
      <div data-testid="boundaries" class="mt-2 text-sm text-slate-600">
        <span class="font-medium text-slate-700">Tier boundaries:</span>
        {#each Object.entries(cfg.rules.boundaries) as [tier, value] (tier)}
          <span class="ml-2 font-mono">{tier}={value}</span>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Read-only: eval details -->
  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-slate-900">Eval details</h2>
    <dl data-testid="eval-details" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
      <dt class="text-slate-500">Model</dt>
      <dd class="font-mono text-slate-800">{cfg.eval.model}</dd>
      <dt class="text-slate-500">Temperature</dt>
      <dd class="tabular-nums text-slate-800">{cfg.eval.temperature}</dd>
      <dt class="text-slate-500">Max tokens</dt>
      <dd class="tabular-nums text-slate-800">{cfg.eval.max_tokens}</dd>
      <dt class="text-slate-500">Timeout (ms)</dt>
      <dd class="tabular-nums text-slate-800">{cfg.eval.timeout_ms}</dd>
      <dt class="text-slate-500">On failure</dt>
      <dd class="text-slate-800">{cfg.eval.on_failure}</dd>
      <dt class="text-slate-500">Cache</dt>
      <dd class="text-slate-800">
        {cfg.eval.cache.enabled ? 'on' : 'off'} · ttl {cfg.eval.cache.ttl_sec}s
      </dd>
    </dl>
  </div>
</section>
