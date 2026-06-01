<script lang="ts">
  import { untrack } from 'svelte';
  import { saveClassifier, type ClassifierConfig } from '$lib/api/classifier.js';
  import DimensionTable from '$lib/components/DimensionTable.svelte';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests). The
  // page runs NO classification logic (Principle 1): it only flips eval on/off, edits
  // the confidence threshold within [0,1], and renders the read-only rule
  // dimensions / eval details. It writes back via the API client only.
  let { data }: { data: { classifier: ClassifierConfig } } = $props();

  const cfg = untrack(() => data.classifier);

  // The two editable knobs.
  let evalEnabled = $state(untrack(() => cfg.eval.enabled));
  let thresholdText = $state(untrack(() => String(cfg.rules.confidence_threshold)));

  let error = $state<string | null>(null);
  let saving = $state(false);
  let saved = $state(false);

  // Validation: threshold must parse to a finite number in [0,1] (fail-closed,
  // Principle 2 — the UI never guesses a legal value for the operator).
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
    saved = false;
    saving = true;
    try {
      const result = await saveClassifier({
        eval_enabled: evalEnabled,
        confidence_threshold: thresholdValue,
      });
      // Reflect the persisted view.
      evalEnabled = result.eval.enabled;
      thresholdText = String(result.rules.confidence_threshold);
      saved = true;
    } catch (e) {
      // fail-closed: surface the error and leave the displayed config unchanged.
      error = e instanceof Error ? e.message : $t('Failed to save classifier config');
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4 px-4 py-6 md:px-8">
  <header class="flex flex-col gap-1">
    <h1 class="page-title">{$t('Classifier')}</h1>
    <p class="section-desc">
      {$t('The classifier decides which lane each request is routed to.')}
    </p>
    <p class="section-desc">
      {$t(
        'Layer-1 rules are always on (deterministic, zero-cost). Toggle the optional Layer-2 eval and tune the confidence threshold below it.',
      )}
    </p>
  </header>

  {#if error}
    <p class="alert-error" role="alert">
      {error}
    </p>
  {/if}

  <!-- Editable knobs -->
  <div class="card flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h2 class="section-header">{$t('Classifier settings')}</h2>
      <p class="section-desc">
        {$t('These two settings are saved to the gateway when you click Save.')}
      </p>
    </div>

    <label class="flex items-center gap-3">
      <input type="checkbox" class="checkbox" name="eval_enabled" bind:checked={evalEnabled} />
      <span class="field-label">{$t('Enable Layer-2 eval')}</span>
      <span class="badge-eval">{$t('Layer-2')}</span>
    </label>
    <p class="field-help">
      {$t(
        'Layer-2 runs a small model to classify requests that Layer-1 rules cannot decide confidently. Off by default. Results are cached, and if it fails the request falls back to the balanced lane.',
      )}
    </p>

    <label class="flex flex-col gap-1">
      <span class="field-label">{$t('Confidence threshold')}</span>
      <input
        type="number"
        name="confidence_threshold"
        step="0.01"
        min="0"
        max="1"
        bind:value={thresholdText}
        class="input w-32"
        class:border-red-300={!thresholdValid}
        aria-invalid={!thresholdValid}
      />
      <span class="field-help">
        {$t(
          'A value between 0 and 1. When Layer-1 rules are less confident than this, the request is passed to Layer-2 eval (if enabled).',
        )}
      </span>
      {#if !thresholdValid}
        <span class="text-xs text-red-600" role="alert">
          {$t('Threshold must be a number between 0 and 1.')}
        </span>
      {/if}
    </label>

    <div class="card-actions">
      {#if saved}
        <span class="badge-ok" role="status">{$t('Saved')}</span>
      {/if}
      <button
        type="button"
        onclick={handleSave}
        disabled={!thresholdValid || saving}
        class="btn-primary"
      >
        {saving ? $t('Saving…') : $t('Save')}
      </button>
    </div>
  </div>

  <!-- Read-only: rule dimensions. Title + intro stay visible; only the table is
       collapsed (collapsed by default — click the summary or toggle row to expand). -->
  <details class="card group flex flex-col gap-2">
    <summary
      class="flex cursor-pointer list-none flex-col gap-2 [&::-webkit-details-marker]:hidden"
    >
      <h2 class="section-header">{$t('Rule dimensions')}</h2>
      <p class="section-desc">
        {$t('How Layer-1 scores each request. Read-only here — these weights are data in')}
        <code>classifier.yaml</code>{$t('; edit that file and restart the gateway to retune.')}
      </p>
      <!-- Clear, full-width toggle affordance so operators know it expands. -->
      <span
        class="flex items-center gap-2 rounded-control border border-slate-200 bg-canvas px-3 py-2 text-sm text-ink-strong hover:bg-slate-100"
      >
        <svg
          class="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="group-open:hidden"
          >{$t('Show all {count} dimensions', { count: cfg.rules.dimensions.length })}</span
        >
        <span class="hidden group-open:inline">{$t('Collapse')}</span>
      </span>
    </summary>
    <div class="mt-2 flex flex-col gap-2">
      <DimensionTable dimensions={cfg.rules.dimensions} />
      {#if cfg.rules.boundaries}
        <div data-testid="boundaries" class="mt-2 text-sm text-ink-body">
          <span class="field-label">{$t('Tier boundaries:')}</span>
          {#each Object.entries(cfg.rules.boundaries) as [tier, value] (tier)}
            <span class="ml-2 font-mono">{tier}={value}</span>
          {/each}
        </div>
      {/if}
    </div>
  </details>

  <!-- Read-only: eval details -->
  <div class="card flex flex-col gap-2">
    <div class="flex flex-col gap-1">
      <h2 class="section-header">{$t('Eval details')}</h2>
      <p class="section-desc">
        {$t('The Layer-2 model and its limits. Read-only — configured in')}
        <code>classifier.yaml</code>.
      </p>
    </div>
    <dl data-testid="eval-details" class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <dt class="text-ink-muted">{$t('Model')}</dt>
      <dd class="font-mono text-ink-strong">{cfg.eval.model}</dd>
      <dt class="text-ink-muted">{$t('Temperature')}</dt>
      <dd class="tabular-nums text-ink-strong">{cfg.eval.temperature}</dd>
      <dt class="text-ink-muted">{$t('Max tokens')}</dt>
      <dd class="tabular-nums text-ink-strong">{cfg.eval.max_tokens}</dd>
      <dt class="text-ink-muted">{$t('Timeout (ms)')}</dt>
      <dd class="tabular-nums text-ink-strong">{cfg.eval.timeout_ms}</dd>
      <dt class="text-ink-muted">{$t('On failure')}</dt>
      <dd class="text-ink-strong">{cfg.eval.on_failure}</dd>
      <dt class="text-ink-muted">{$t('Cache')}</dt>
      <dd class="text-ink-strong">
        {cfg.eval.cache.enabled ? $t('on') : $t('off')} · ttl {cfg.eval.cache.ttl_sec}s
      </dd>
    </dl>
  </div>
</section>
