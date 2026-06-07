<script lang="ts">
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Visualises the recorded decision trail in order:
  //   classifier output -> eval -> matched policy -> lane candidates -> provider
  //   attempts.
  // CLAUDE.md Principle 5: the classification-stage decision (classifier/eval/policy) and
  // the execution-stage provider fallback (attempts) live in SEPARATE sections and
  // are never conflated. Read-only: nothing here is recomputed.
  let { detail }: { detail: RequestDetail } = $props();

  const cls = $derived(detail.classifier_output);

  // Attribute the classifier verdict to the stage that actually produced it — the
  // key insight this view fixes: a `decided_by:'eval'` verdict is the EVAL MODEL's
  // output, not the Layer-1 rules. Each source has its own badge colour (app.css).
  function decidedBy(source: RequestDetail['classifier_output']['decided_by']): {
    badge: string;
    key: string;
  } {
    switch (source) {
      case 'eval':
        return { badge: 'badge-eval', key: 'Decided by the Layer-2 eval model' };
      case 'fallback':
        return { badge: 'badge-fallback', key: 'Rules uncertain — fell back to the balanced lane' };
      case 'default':
        return { badge: 'badge-neutral', key: 'Default (explicit passthrough or fail-open)' };
      default:
        return { badge: 'badge-rules', key: 'Decided by Layer-1 rules' };
    }
  }

  // Map a raw eval fail-open reason (e.g. 'eval_timeout') to a friendly i18n key.
  // The cascade tags these as `eval_<reason>`; strip the prefix before mapping.
  function evalReasonKey(reason: string): string {
    const bare = reason.startsWith('eval_') ? reason.slice(5) : reason;
    switch (bare) {
      case 'timeout':
        return 'timed out';
      case 'provider_error':
        return 'provider error';
      case 'circuit_open':
        return 'circuit open';
      case 'not_json':
        return 'returned non-JSON';
      case 'schema_invalid':
        return 'returned an invalid schema';
      default:
        return bare;
    }
  }

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
  // the backend has key-scrubbed this (Principle 7); we only display it.
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
  <!-- 1. Classification stage (Principle 5: NOT execution fallback) -->
  <section data-testid="chain-classifier" class="card">
    <h3 class="text-sm font-semibold text-ink-strong">
      {$t('Classifier (classification stage)')}
    </h3>
    <!-- Deliberately NOT described as "Layer-1 rules": when eval decides, the
         verdict below (incl. its confidence) is the EVAL MODEL's output. The
         badge + escalation line attribute it; the description stays neutral. -->
    <p class="field-help mb-2">
      {$t('The verdict that routed this request — the badge shows which layer decided it.')}
    </p>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="badge-neutral">{cls.task_type}</span>
      <span class="badge-neutral">{cls.complexity}</span>
      <span class="text-ink-muted">{$t('confidence')} {cls.confidence.toFixed(2)}</span>
    </div>
    <!-- Decision source: makes clear WHICH stage produced the verdict above, so an
         eval-decided verdict is no longer mistaken for a Layer-1 rules verdict. -->
    <div data-testid="chain-decided-by" class="mt-2">
      <span class={decidedBy(cls.decided_by).badge}>{$t(decidedBy(cls.decided_by).key)}</span>
    </div>
    {#if cls.decided_by === 'eval'}
      <!-- The escalation causality: the confidence above is the EVAL model's —
           Layer-1's own (low) gate value is what sent the request to eval. -->
      <p data-testid="rules-escalation" class="mt-1 text-xs text-ink-muted">
        {#if cls.rules_confidence !== null}
          {$t(
            'Layer-1 rules were uncertain (confidence {confidence}) — escalated to the eval model; the verdict and confidence above are the eval model’s.',
            {
              confidence: cls.rules_confidence.toFixed(2),
            },
          )}
        {:else}
          {$t(
            'Layer-1 rules were uncertain — escalated to the eval model; the verdict and confidence above are the eval model’s.',
          )}
        {/if}
      </p>
    {/if}
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
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="badge-eval">{$t('triggered')}</span>
        {#if detail.eval_model}
          <span class="text-ink-body">
            {$t('model:')}
            <span class="font-mono text-ink-strong">{detail.eval_model}</span>
          </span>
        {/if}
        <span class="text-ink-body">
          {$t('cache:')}
          {detail.eval_cache_hit === null
            ? $t('n/a')
            : detail.eval_cache_hit
              ? $t('hit')
              : $t('miss')}
        </span>
        {#if detail.eval_latency_ms !== null}
          <span class="text-ink-muted">{$t('latency:')} {detail.eval_latency_ms}ms</span>
        {/if}
      </div>
      {#if cls.decided_by === 'eval'}
        <!-- The verdict in the Classifier box above IS this eval's output — restate
             it here, explicitly attributed, so its provenance is unambiguous. -->
        <p data-testid="eval-verdict" class="mt-2 flex flex-wrap items-center gap-2 text-ink-body">
          <span>{$t('Eval verdict:')}</span>
          <span class="badge-neutral">{cls.task_type}</span>
          <span class="badge-neutral">{cls.complexity}</span>
          <span class="text-ink-muted">{$t('confidence')} {cls.confidence.toFixed(2)}</span>
        </p>
      {:else if detail.eval_fallback_reason}
        <!-- Eval ran but failed open → routing fell back to balanced; say why. -->
        <p data-testid="eval-failed" class="mt-2 text-amber-800">
          {$t('Eval failed open ({reason}) — routing fell back to the balanced lane.', {
            reason: $t(evalReasonKey(detail.eval_fallback_reason)),
          })}
        </p>
      {/if}
    {:else}
      <span class="text-ink-muted">{$t('not triggered')}</span>
      {#if detail.eval_fallback_reason === 'eval_disabled'}
        <!-- Rules were uncertain but Layer 2 is off — complete the causal chain
             so the balanced fallback isn't mistaken for a confident decision. -->
        <span data-testid="eval-disabled-note" class="ml-2 text-ink-muted">
          {$t(
            '— eval is disabled; rules were uncertain, so routing fell back to the balanced lane.',
          )}
        </span>
      {/if}
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

  <!-- 5. Execution stage: provider attempts (Principle 5: distinct from classification) -->
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
               redacted by the backend (Principle 7). -->
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
