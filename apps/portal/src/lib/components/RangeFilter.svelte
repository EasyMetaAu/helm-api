<script lang="ts">
  import type { RangeKey } from "$lib/requests-filters.js";
  import { t } from "$lib/i18n";

  let {
    value,
    onChange,
    label = undefined,
  }: {
    value: RangeKey;
    onChange: (next: RangeKey) => void;
    label?: string;
  } = $props();

  const OPTIONS: { key: RangeKey; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
    { key: "all", label: "All" },
  ];
</script>

<div
  class="flex flex-wrap items-center gap-2"
  role="group"
  aria-label={label ?? $t("Date range")}
>
  {#each OPTIONS as opt (opt.key)}
    <button
      type="button"
      data-testid="range-{opt.key}"
      class="{value === opt.key
        ? 'btn-primary-sm'
        : 'btn-secondary'} min-h-11 md:min-h-0"
      aria-pressed={value === opt.key}
      onclick={() => onChange(opt.key)}
    >
      {opt.key === "7d" || opt.key === "30d" ? opt.label : $t(opt.label)}
    </button>
  {/each}
</div>
