<script lang="ts">
  import type { TokenUsageView } from '$lib/api/requests.js';
  import { formatTokens } from '$lib/format.js';
  import { t } from '$lib/i18n';

  // Compact per-request token cell for the request list views (homepage recent +
  // /requests). Read-only (Principle 1): renders the recorded `usage`, never
  // recomputes counts. The wide table only has room for the two headline numbers
  // (↑ input / ↓ output) plus a cached sub-line; the FULL split (incl. non-cached)
  // rides the hover title and the detail page's Token-usage card.
  let { usage }: { usage: TokenUsageView } = $props();

  // "Measured at all?" — a legacy/un-stamped record has every leaf null, so the
  // cell collapses to a single '—' (distinct from a measured 0, which shows "0").
  const measured = $derived(
    usage.input !== null ||
      usage.output !== null ||
      usage.cached !== null ||
      usage.cacheCreation !== null,
  );

  // The full breakdown, surfaced on hover so the headline cell stays compact.
  const tip = $derived(
    $t('input {input} · output {output} · cached {cached} · non-cached {nonCached}', {
      input: formatTokens(usage.input),
      output: formatTokens(usage.output),
      cached: formatTokens(usage.cached),
      nonCached: formatTokens(usage.nonCached),
    }),
  );
</script>

{#if measured}
  <div data-testid="tokens-cell" class="font-mono text-xs leading-tight" title={tip}>
    <div class="text-ink-body">
      <span data-testid="tokens-input">↑ {formatTokens(usage.input)}</span>
      <span class="ml-2" data-testid="tokens-output">↓ {formatTokens(usage.output)}</span>
    </div>
    <div class="text-ink-muted" data-testid="tokens-cached">
      {$t('cached')}
      {formatTokens(usage.cached)}
    </div>
  </div>
{:else}
  <span data-testid="tokens-cell" class="text-ink-muted">—</span>
{/if}
