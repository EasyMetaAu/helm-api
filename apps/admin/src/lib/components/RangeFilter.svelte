<script lang="ts">
  import type { RangeKey } from '$lib/requests-filters.js';
  import { t } from '$lib/i18n';

  // Shared date-range preset selector — a button row (mirrors the old LLM-Router
  // toolbar). Used by the dashboard window picker and the request-list filter bar
  // so both read identically. Stateless: the parent owns the active `value` (from
  // the URL) and applies the change in `onChange`; this only renders + reports.
  let {
    value,
    onChange,
    label = undefined,
  }: {
    value: RangeKey;
    onChange: (next: RangeKey) => void;
    label?: string;
  } = $props();

  // The numeric labels are language-neutral literals; only "All" is translated.
  const OPTIONS: { key: RangeKey; label: string }[] = [
    { key: '1h', label: '1h' },
    { key: '6h', label: '6h' },
    { key: '24h', label: '24h' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All' },
  ];
</script>

<div class="flex flex-wrap items-center gap-2" role="group" aria-label={label ?? $t('Date range')}>
  {#each OPTIONS as opt (opt.key)}
    <button
      type="button"
      data-testid="range-{opt.key}"
      class="{value === opt.key ? 'btn-primary-sm' : 'btn-secondary'} min-h-11 md:min-h-0"
      aria-pressed={value === opt.key}
      onclick={() => onChange(opt.key)}
    >
      {opt.key === 'all' ? $t('All') : opt.label}
    </button>
  {/each}
</div>
