<script lang="ts">
  import type { TokenUsageView } from "$lib/api/requests.js";
  import { formatTokens } from "$lib/format.js";
  import { t } from "$lib/i18n";

  // Full token breakdown for one request (detail page). Mirrors CostBreakdown's
  // <dl> grid. Read-only: renders exactly the counts the backend recorded — null
  // leaves render as '—' (not measured), distinct from a measured 0.
  let { usage }: { usage: TokenUsageView } = $props();

  const fmt = formatTokens;
</script>

<dl data-testid="token-usage" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
  <dt class="text-ink-muted">{$t("Input tokens")}</dt>
  <dd data-testid="tokens-input" class="text-right font-mono text-ink-strong">
    {fmt(usage.input)}
  </dd>

  <dt class="text-ink-muted">{$t("Output tokens")}</dt>
  <dd data-testid="tokens-output" class="text-right font-mono text-ink-strong">
    {fmt(usage.output)}
  </dd>

  <dt class="text-ink-muted">{$t("Cached tokens")}</dt>
  <dd data-testid="tokens-cached" class="text-right font-mono text-ink-strong">
    {fmt(usage.cached)}
  </dd>

  <dt class="text-ink-muted">{$t("Non-cached tokens")}</dt>
  <dd
    data-testid="tokens-non-cached"
    class="text-right font-mono text-ink-strong"
  >
    {fmt(usage.nonCached)}
  </dd>

  <dt class="text-ink-muted">{$t("Cache write tokens")}</dt>
  <dd
    data-testid="tokens-cache-write"
    class="text-right font-mono text-ink-strong"
  >
    {fmt(usage.cacheCreation)}
  </dd>

  <dt class="font-medium text-ink-body">{$t("Total tokens")}</dt>
  <dd
    data-testid="tokens-total"
    class="text-right font-mono font-semibold text-ink-strong"
  >
    {fmt(usage.total)}
  </dd>
</dl>
