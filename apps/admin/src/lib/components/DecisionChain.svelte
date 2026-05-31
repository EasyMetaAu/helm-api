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

  function outcomeClass(outcome: string): string {
    switch (outcome) {
      case 'success':
        return 'bg-emerald-100 text-emerald-700';
      case 'skipped':
        return 'bg-slate-200 text-slate-600';
      default:
        return 'bg-red-100 text-red-700';
    }
  }
</script>

<div class="flex flex-col gap-4">
  <!-- 1. Classification stage (原则5: NOT execution fallback) -->
  <section data-testid="chain-classifier" class="rounded-lg border border-slate-200 bg-white p-4">
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {$t('Classifier (classification stage)')}
    </h3>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800"
        >{cls.task_type}</span
      >
      <span class="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800"
        >{cls.complexity}</span
      >
      <span class="text-slate-500">{$t('confidence')} {cls.confidence.toFixed(2)}</span>
    </div>
    {#if cls.matched_dimensions.length > 0}
      <div class="mt-2 flex flex-wrap gap-1">
        {#each cls.matched_dimensions as dim (dim)}
          <span class="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{dim}</span>
        {/each}
      </div>
    {/if}
    {#if Object.keys(cls.constraints).length > 0}
      <div class="mt-2 text-xs text-slate-500">
        {$t('constraints:')}
        {#each Object.entries(cls.constraints) as [name, on] (name)}
          <span class="ml-1">{name}={on ? $t('yes') : $t('no')}</span>
        {/each}
      </div>
    {/if}
  </section>

  <!-- 2. Eval stage -->
  <section data-testid="chain-eval" class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{$t('Eval')}</h3>
    {#if detail.eval_triggered}
      <span class="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
        >{$t('triggered')}</span
      >
      <span class="ml-2 text-slate-600">
        {$t('cache:')}
        {detail.eval_cache_hit === null
          ? $t('n/a')
          : detail.eval_cache_hit
            ? $t('hit')
            : $t('miss')}
      </span>
    {:else}
      <span class="text-slate-500">{$t('not triggered')}</span>
    {/if}
  </section>

  <!-- 3. Matched policy -->
  <section
    data-testid="chain-policy"
    class="rounded-lg border border-slate-200 bg-white p-4 text-sm"
  >
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {$t('Matched policy')}
    </h3>
    <span class="font-mono text-slate-800">{detail.matched_policy ?? $t('— none')}</span>
  </section>

  <!-- 4. Lane candidate chain -->
  <section data-testid="chain-lanes" class="rounded-lg border border-slate-200 bg-white p-4">
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {$t('Lane candidate chain')}
    </h3>
    <ol class="flex flex-wrap items-center gap-1 text-sm">
      {#each detail.lane_candidates as lane, i (lane)}
        {#if i > 0}<span class="text-slate-400">-></span>{/if}
        <li data-testid="lane-candidate" class="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
          {lane}
        </li>
      {/each}
    </ol>
  </section>

  <!-- 5. Execution stage: provider attempts (原则5: distinct from classification) -->
  <section data-testid="chain-attempts" class="rounded-lg border border-slate-200 bg-white p-4">
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {$t('Provider attempts (execution fallback)')}
    </h3>
    <ul class="flex flex-col gap-2">
      {#each detail.provider_attempts as a, i (i)}
        <li data-testid="attempt-row" class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-mono text-slate-800">{a.provider}</span>
          <span class="text-slate-500">{a.model}</span>
          <span class="rounded px-2 py-0.5 text-xs font-medium {outcomeClass(a.outcome)}"
            >{a.outcome}</span
          >
          <span class="text-slate-500">{a.latency_ms}ms</span>
          {#if a.error_class}<span class="text-red-600">{a.error_class}</span>{/if}
          {#if a.skip_reason}<span class="text-slate-500">{$t('skip:')} {a.skip_reason}</span>{/if}
        </li>
      {/each}
    </ul>
  </section>
</div>
