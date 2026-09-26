<script lang="ts">
  import { untrack } from 'svelte';
  import { EvalCandidateSchema, type EvalCandidate } from '@helm/shared';
  import { saveClassifier, type ClassifierConfig } from '$lib/api/classifier.js';
  import DimensionTable from '$lib/components/DimensionTable.svelte';
  import { formatDurationMs } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // Data comes from `+page.ts`'s load (mocked via the `data` prop in tests). The
  // page runs NO classification logic: it edits evaluation order and thresholds
  // and renders the read-only rule dimensions / shared eval limits. It writes back via the API client only.
  let { data }: { data: { classifier: ClassifierConfig } } = $props();

  let cfg = $state(untrack(() => data.classifier));

  // Editable settings.
  let evalEnabled = $state(untrack(() => cfg.eval.enabled));
  let thresholdText = $state(untrack(() => String(cfg.rules.confidence_threshold)));

  function candidates(config: ClassifierConfig): EvalCandidate[] {
    return structuredClone(
      config.eval.chain ?? [
        {
          type: 'chat',
          model: config.eval.model,
          timeout_ms: config.eval.outer_timeout_ms ?? 8000,
          min_confidence: 0,
        },
      ],
    );
  }
  let chain = $state<EvalCandidate[]>(untrack(() => candidates(data.classifier)));
  let chainDirty = $state(false);
  const chainValid = $derived(
    chain.length > 0 &&
      chain.length <= 4 &&
      chain.every((c) => EvalCandidateSchema.safeParse(c).success) &&
      new Set(chain.map((c) => `${c.type}:${c.model.trim()}`)).size === chain.length,
  );

  function addCandidate(type: EvalCandidate['type']) {
    const candidate: EvalCandidate =
      type === 'jev'
        ? { type, model: 'typesafe/jev-1.13', timeout_ms: 1000, min_confidence: 0.6 }
        : { type, model: 'economy', timeout_ms: 5000, min_confidence: 0 };
    chain = type === 'jev' ? [candidate, ...chain] : [...chain, candidate];
    chainDirty = true;
    saved = false;
  }
  function move(index: number, offset: number) {
    const next = [...chain];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    chain = next;
    chainDirty = true;
    saved = false;
  }
  function setType(index: number, type: EvalCandidate['type']) {
    chain[index] =
      type === 'jev'
        ? { type, model: 'typesafe/jev-1.13', timeout_ms: 1000, min_confidence: 0.6 }
        : {
            type,
            model: cfg.eval.model,
            timeout_ms: cfg.eval.outer_timeout_ms ?? 8000,
            min_confidence: 0,
          };
    chainDirty = true;
    saved = false;
  }

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
    if (!thresholdValid || !chainValid) return; // hard guard: never write an out-of-range value
    error = null;
    saved = false;
    saving = true;
    try {
      const result = await saveClassifier({
        eval_enabled: evalEnabled,
        ...(chainDirty ? { eval_chain: chain.map((c) => ({ ...c, model: c.model.trim() })) } : {}),
        confidence_threshold: thresholdValue,
      });
      // Reflect the persisted view.
      cfg = result;
      chain = candidates(result);
      chainDirty = false;
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

<section class="page-narrow">
  <header class="flex flex-col gap-1">
    <h1 class="page-title">{$t('Classifier')}</h1>
    <p class="section-desc">
      {$t('The classifier decides which lane each request is routed to.')}
    </p>
    <p class="section-desc" data-testid="rules-runtime-status">
      {#if cfg.rules.enabled}
        {$t(
          'Layer-1 rules are enabled (deterministic, zero-cost). You can tune the confidence threshold below.',
        )}
      {:else}
        {$t(
          'Layer-1 rules are disabled; requests go directly to Layer-2 eval when it is enabled, otherwise they use the terminal fallback lane.',
        )}
      {/if}
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
        {$t('Settings take effect after saving; no restart is needed.')}
      </p>
    </div>

    <label class="flex min-h-11 items-center gap-3 py-1.5 md:min-h-0 md:py-0">
      <input type="checkbox" class="checkbox" name="eval_enabled" bind:checked={evalEnabled} />
      <span class="field-label">{$t('Enable Layer-2 eval')}</span>
      <span class="badge-eval">{$t('Layer-2')}</span>
    </label>
    <p class="field-help">
      {$t(
        'Layer-2 tries classifiers in order when Layer-1 is uncertain or disabled. Only when every candidate fails does the request use the system default lane.',
      )}
    </p>
    <p class="field-help" data-testid="eval-cache-runtime-status">
      {#if cfg.eval.cache.enabled}
        {$t('The eval cache is enabled; matching decisions may be reused.')}
      {:else}
        {$t('The eval cache is disabled; every Layer-2 decision runs fresh.')}
      {/if}
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

    <fieldset class="flex min-w-0 flex-col gap-3 border-t border-slate-200 pt-4" disabled={saving}>
      <legend class="field-label">{$t('Classifier order')}</legend>
      <p class="field-help">
        {$t(
          'The first valid, confident result wins. Errors, timeouts and low confidence try the next classifier.',
        )}
      </p>
      <p class="field-help">
        {$t('Total evaluation budget: {duration}. Later candidates share the remaining time.', {
          duration: formatDurationMs(cfg.eval.outer_timeout_ms ?? 8000),
        })}
      </p>
      {#each chain as candidate, index}
        <div
          class="flex min-w-0 flex-col gap-3 rounded-control border border-slate-200 p-3"
          data-testid="classifier-candidate"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="field-label"
              >{index + 1}. {index === 0
                ? $t('Preferred classifier')
                : $t('Fallback classifier')}</span
            >
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn-secondary"
                disabled={index === 0}
                aria-label={$t('Move classifier {index} up', { index: index + 1 })}
                onclick={() => move(index, -1)}>{$t('Move up')}</button
              >
              <button
                type="button"
                class="btn-secondary"
                disabled={index === chain.length - 1}
                aria-label={$t('Move classifier {index} down', { index: index + 1 })}
                onclick={() => move(index, 1)}>{$t('Move down')}</button
              >
              <button
                type="button"
                class="btn-secondary"
                disabled={chain.length === 1}
                aria-label={$t('Remove classifier {index}', { index: index + 1 })}
                onclick={() => {
                  chain = chain.filter((_, i) => i !== index);
                  chainDirty = true;
                  saved = false;
                }}>{$t('Remove')}</button
              >
            </div>
          </div>
          <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="flex min-w-0 flex-col gap-1">
              <span class="field-label">{$t('Classifier type')}</span>
              <select
                class="input w-full"
                aria-label={$t('Classifier type {index}', { index: index + 1 })}
                value={candidate.type}
                onchange={(e) => setType(index, e.currentTarget.value as EvalCandidate['type'])}
              >
                <option value="jev">Jev · OpenRouter</option>
                <option value="chat">{$t('Chat model / lane')}</option>
              </select>
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              <span class="field-label">{$t('Model / lane')}</span>
              <input
                class="input w-full"
                aria-label={$t('Classifier model {index}', { index: index + 1 })}
                bind:value={candidate.model}
                oninput={() => {
                  chainDirty = true;
                  saved = false;
                }}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              <span class="field-label">{$t('Candidate timeout (ms)')}</span>
              <input
                type="number"
                class="input w-full"
                min="1"
                max="60000"
                step="1"
                aria-label={$t('Classifier timeout {index}', { index: index + 1 })}
                bind:value={candidate.timeout_ms}
                oninput={() => {
                  chainDirty = true;
                  saved = false;
                }}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              <span class="field-label">{$t('Minimum confidence')}</span>
              <input
                type="number"
                class="input w-full"
                min="0"
                max="1"
                step="0.01"
                aria-label={$t('Classifier minimum confidence {index}', { index: index + 1 })}
                bind:value={candidate.min_confidence}
                oninput={() => {
                  chainDirty = true;
                  saved = false;
                }}
              />
            </label>
          </div>
        </div>
      {/each}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn-secondary"
          disabled={chain.length >= 4 || chain.some((c) => c.type === 'jev')}
          onclick={() => addCandidate('jev')}>{$t('Add Jev')}</button
        >
        <button
          type="button"
          class="btn-secondary"
          disabled={chain.length >= 4}
          onclick={() => addCandidate('chat')}>{$t('Add chat classifier')}</button
        >
      </div>
      <p class="field-help">
        {$t(
          'Jev uses the configured OpenRouter credential. Test confidence thresholds on your own Chinese and English requests.',
        )}
      </p>
      {#if !chainValid}
        <p class="text-sm text-red-600" role="alert">
          {$t(
            'Use unique classifiers, valid model IDs, positive timeouts up to 60000 ms, and confidence values from 0 to 1.',
          )}
        </p>
      {/if}
    </fieldset>

    <div class="card-actions">
      {#if saved}
        <span class="badge-ok" role="status">{$t('Saved')}</span>
      {/if}
      <button
        type="button"
        onclick={handleSave}
        disabled={!thresholdValid || !chainValid || saving}
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
        {$t('Shared evaluation limits. Candidate order is configured above; other limits are in')}
        <code>classifier.yaml</code>.
      </p>
    </div>
    <dl data-testid="eval-details" class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
      <dt class="text-ink-muted">{$t('Model')}</dt>
      <dd class="break-all font-mono text-ink-strong">
        {cfg.eval.chain?.map((c) => c.model).join(' → ') ?? cfg.eval.model}
      </dd>
      <dt class="text-ink-muted">{$t('Temperature')}</dt>
      <dd class="tabular-nums text-ink-strong">{cfg.eval.temperature}</dd>
      <dt class="text-ink-muted">{$t('Max tokens')}</dt>
      <dd class="tabular-nums text-ink-strong">{cfg.eval.max_tokens}</dd>
      <dt class="text-ink-muted">{$t('Timeout')}</dt>
      <dd class="tabular-nums text-ink-strong">{formatDurationMs(cfg.eval.timeout_ms)}</dd>
      <dt class="text-ink-muted">{$t('On failure')}</dt>
      <dd class="text-ink-strong">{$t('System default lane')}</dd>
      <dt class="text-ink-muted">{$t('Cache')}</dt>
      <dd class="text-ink-strong">
        {cfg.eval.cache.enabled ? $t('on') : $t('off')} · ttl {formatDurationMs(
          cfg.eval.cache.ttl_sec * 1000,
        )}
      </dd>
    </dl>
  </div>
</section>
