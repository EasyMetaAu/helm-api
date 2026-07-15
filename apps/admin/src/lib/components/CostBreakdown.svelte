<script lang="ts">
  import { formatUsd } from '$lib/format.js';
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Cost breakdown for one request (docs/07 "cost breakdown, including eval's own cost").
  // Read-only: renders exactly the figures the backend recorded — no re-computation.
  let {
    cost,
    measurement = 'reported',
    apiEquivalent = false,
  }: {
    cost: RequestDetail['cost_breakdown'];
    measurement?: RequestDetail['usage']['measurement'];
    apiEquivalent?: boolean;
  } = $props();

  // Adaptive precision so sub-cent relay costs (~$0.0000244) stay visible instead
  // of collapsing to $0.0000; null components render as "—" (not measured).
  const usd = formatUsd;

  function completionUsd(value: number | null): string {
    const rendered = usd(value);
    return value !== null && measurement === 'estimated_partial' ? `≈${rendered}` : rendered;
  }
</script>

{#if measurement === 'estimated_partial'}
  <p data-testid="cost-measurement" class="mb-2 text-xs text-ink-muted">
    {apiEquivalent
      ? $t('API-equivalent estimate; subscription has no per-request charge')
      : $t('Estimated from a partial stream.')}
  </p>
{/if}

<dl data-testid="cost-breakdown" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
  <dt class="text-ink-muted">{$t('Routing')}</dt>
  <dd data-testid="cost-routing" class="text-right font-mono text-ink-strong">
    {usd(cost.routing_usd)}
  </dd>

  <dt class="text-ink-muted">{$t('Eval (self-cost)')}</dt>
  <dd data-testid="cost-eval" class="text-right font-mono text-ink-strong">{usd(cost.eval_usd)}</dd>

  <dt class="text-ink-muted">{$t('Completion')}</dt>
  <dd data-testid="cost-completion" class="text-right font-mono text-ink-strong">
    {completionUsd(cost.completion_usd)}
  </dd>

  <dt class="font-medium text-ink-body">{$t('Total')}</dt>
  <dd data-testid="cost-total" class="text-right font-mono font-semibold text-ink-strong">
    {completionUsd(cost.total_usd)}
  </dd>
</dl>
