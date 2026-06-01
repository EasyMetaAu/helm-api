<script lang="ts">
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Visualises the recorded decision trail in order:
  //   classifier output -> eval -> matched policy -> lane candidates -> provider
  //   attempts.
  // CLAUDE.md 原则5: the classification-stage decision (classifier/eval/policy) and
  // the execution-stage provider fallback (attempts) live in SEPARATE sections and
  // are never conflated. Read-only: nothing here is recomputed.
  let { detail }: { detail: RequestDetail } = $props();

  const cls = $derived(detail.classifier_output);

  function outcomeBadge(outcome: string): string {
    switch (outcome) {
      case 'success':
        return 'badge-ok';
      case 'skipped':
        return 'badge-neutral';
      default:
        return 'badge-error';
    }
  }

  // Pretty-print the (already redacted) upstream error body for the expandable
  // detail panel. An object → indented JSON; a raw string → verbatim. READ-ONLY:
  // the backend has key-scrubbed this (原则7); we only display it.
  function showRaw(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
</script>

<div class="flex flex-col gap-4">
  <!-- 1. Classification stage (原则5: NOT execution fallback) -->
  <section data-testid="chain-classifier" class="card">
    <h3 class="text-sm font-semibold text-ink-strong">
      {$t('Classifier (classification stage)')}
    </h3>
    <p class="field-help mb-2">
      {$t('Layer-1 deterministic rules read the request and decide which lane it belongs to.')}
    </p>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="badge-neutral">{cls.task_type}</span>
      <span class="badge-neutral">{cls.complexity}</span>
      <span class="text-ink-muted">{$t('confidence')} {cls.confidence.toFixed(2)}</span>
    </div>
    {#if cls.matched_dimensions.length > 0}
      <div class="mt-2 flex flex-wrap gap-1">
        {#each cls.matched_dimensions as dim (dim)}
          <span class="badge-neutral">{dim}</span>
        {/each}
      </div>
    {/if}
    {#if Object.keys(cls.constraints).length > 0}
      <div class="mt-2 text-xs text-ink-muted">
        {$t('constraints:')}
        {#each Object.entries(cls.constraints) as [name, on] (name)}
          <span class="ml-1">{name}={on ? $t('yes') : $t('no')}</span>
        {/each}
      </div>
    {/if}
  </section>

  <!-- 2. Eval stage -->
  <section data-testid="chain-eval" class="card text-sm">
    <h3 class="text-sm font-semibold text-ink-strong">{$t('Eval')}</h3>
    <p class="field-help mb-2">
      {$t(
        'Optional Layer-2 step: a small model double-checks the lane. Off by default; results are cached.',
      )}
    </p>
    {#if detail.eval_triggered}
      <span class="badge-eval">{$t('triggered')}</span>
      <span class="ml-2 text-ink-body">
        {$t('cache:')}
        {detail.eval_cache_hit === null
          ? $t('n/a')
          : detail.eval_cache_hit
            ? $t('hit')
            : $t('miss')}
      </span>
    {:else}
      <span class="text-ink-muted">{$t('not triggered')}</span>
    {/if}
  </section>

  <!-- 3. Matched policy -->
  <section data-testid="chain-policy" class="card text-sm">
    <h3 class="text-sm font-semibold text-ink-strong">
      {$t('Matched policy')}
    </h3>
    <p class="field-help mb-2">
      {$t('The policy rule that overrode or capped the lane for this request, if any.')}
    </p>
    <span class="font-mono text-ink-strong">{detail.matched_policy ?? $t('— none')}</span>
  </section>

  <!-- 4. Lane candidate chain -->
  <section data-testid="chain-lanes" class="card">
    <h3 class="text-sm font-semibold text-ink-strong">
      {$t('Lane candidate chain')}
    </h3>
    <p class="field-help mb-2">
      {$t('Lanes considered in order — the first one whose model succeeds handles the request.')}
    </p>
    <ol class="flex flex-wrap items-center gap-1 text-sm">
      {#each detail.lane_candidates as lane, i (lane)}
        {#if i > 0}<span class="text-ink-faint">-></span>{/if}
        <li data-testid="lane-candidate" class="badge-neutral">
          {lane}
        </li>
      {/each}
    </ol>
  </section>

  <!-- 5. Execution stage: provider attempts (原则5: distinct from classification) -->
  <section data-testid="chain-attempts" class="card">
    <h3 class="text-sm font-semibold text-ink-strong">
      {$t('Provider attempts (execution fallback)')}
    </h3>
    <p class="field-help mb-2">
      {$t(
        'Each provider/model actually tried, in order. If one fails, Helm falls back to the next.',
      )}
    </p>
    <ul class="flex flex-col gap-2">
      {#each detail.provider_attempts as a, i (i)}
        <li data-testid="attempt-row" class="flex flex-col gap-1 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-ink-strong">{a.provider}</span>
            <span class="text-ink-muted">{a.model}</span>
            <span class={outcomeBadge(a.outcome)}>{a.outcome}</span>
            <span class="text-ink-muted">{a.latency_ms}ms</span>
            {#if a.error_class}<span class="text-red-600">{a.error_class}</span>{/if}
            {#if a.skip_reason}<span class="text-ink-muted">{$t('skip:')} {a.skip_reason}</span
              >{/if}
          </div>
          <!-- Expandable upstream failure detail for THIS attempt — the only
               record of WHY a candidate failed when a later one served. Already
               redacted by the backend (原则7). -->
          {#if a.error_detail}
            {@const ed = a.error_detail}
            <details
              data-testid="attempt-error-detail"
              class="ml-1 rounded border border-red-100 bg-red-50/60 px-2 py-1 text-xs"
            >
              <summary class="cursor-pointer select-none text-red-700">
                {$t('Error detail')}{ed.upstream_status !== null
                  ? ` · HTTP ${ed.upstream_status}`
                  : ''}{ed.message ? ` — ${ed.message}` : ''}
              </summary>
              {#if ed.provider_raw !== null && ed.provider_raw !== undefined}
                <pre
                  class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-red-900">{showRaw(
                    ed.provider_raw,
                  )}</pre>
              {:else}
                <p class="mt-1 italic text-ink-muted">{$t('No raw upstream body recorded.')}</p>
              {/if}
            </details>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
</div>
