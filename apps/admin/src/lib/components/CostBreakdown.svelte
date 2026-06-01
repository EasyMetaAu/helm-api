<script lang="ts">
  import { formatUsd } from '$lib/format.js';
  import type { RequestDetail } from '$lib/api/requests.js';
  import { t } from '$lib/i18n';

  // Cost breakdown for one request (docs/07「成本拆分，含 eval 评估自身的成本」).
  // Read-only: renders exactly the figures the backend recorded — no re-computation.
  let { cost }: { cost: RequestDetail['cost_breakdown'] } = $props();

  // Adaptive precision so sub-cent relay costs (~$0.0000244) stay visible instead
  // of collapsing to $0.0000; null components render as "—" (not measured).
  const usd = formatUsd;
</script>

<dl data-testid="cost-breakdown" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
  <dt class="text-ink-muted">{$t('Routing')}</dt>
  <dd data-testid="cost-routing" class="text-right font-mono text-ink-strong">
    {usd(cost.routing_usd)}
  </dd>

  <dt class="text-ink-muted">{$t('Eval (self-cost)')}</dt>
  <dd data-testid="cost-eval" class="text-right font-mono text-ink-strong">{usd(cost.eval_usd)}</dd>

  <dt class="text-ink-muted">{$t('Completion')}</dt>
  <dd data-testid="cost-completion" class="text-right font-mono text-ink-strong">
    {usd(cost.completion_usd)}
  </dd>

  <dt class="font-medium text-ink-body">{$t('Total')}</dt>
  <dd data-testid="cost-total" class="text-right font-mono font-semibold text-ink-strong">
    {usd(cost.total_usd)}
  </dd>
</dl>
