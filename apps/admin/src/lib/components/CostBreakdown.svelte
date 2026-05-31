<script lang="ts">
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Cost breakdown for one request (docs/07「成本拆分，含 eval 评估自身的成本」).
  // Read-only: renders exactly the figures the backend recorded — no re-computation.
  let { cost }: { cost: RequestDetail['cost_breakdown'] } = $props();

  function usd(n: number): string {
    return `$${n.toFixed(4)}`;
  }
</script>

<dl data-testid="cost-breakdown" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
  <dt class="text-slate-500">{$t('Routing')}</dt>
  <dd data-testid="cost-routing" class="text-right font-mono text-slate-800">
    {usd(cost.routing_usd)}
  </dd>

  <dt class="text-slate-500">{$t('Eval (self-cost)')}</dt>
  <dd data-testid="cost-eval" class="text-right font-mono text-slate-800">{usd(cost.eval_usd)}</dd>

  <dt class="text-slate-500">{$t('Completion')}</dt>
  <dd data-testid="cost-completion" class="text-right font-mono text-slate-800">
    {usd(cost.completion_usd)}
  </dd>

  <dt class="font-medium text-slate-700">{$t('Total')}</dt>
  <dd data-testid="cost-total" class="text-right font-mono font-semibold text-slate-900">
    {usd(cost.total_usd)}
  </dd>
</dl>
