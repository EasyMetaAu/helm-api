<script lang="ts">
  import type { RuleDimension } from '$lib/api/classifier.js';
  import { t } from '$lib/i18n';

  // READ-ONLY scoring-dimension table. Dimensions/weights are DATA in
  // classifier.yaml; tuning them risks skewing classification, so the UI shows
  // them but offers NO edit controls — the MVP path for weight changes is editing
  // the YAML and restarting (docs/11). Intentionally renders no input/select/
  // textarea/button.
  let { dimensions }: { dimensions: RuleDimension[] } = $props();

  const arrow = (d: RuleDimension['direction']) => (d === 'up' ? '↑' : d === 'down' ? '↓' : '·');
</script>

<div class="table-wrap">
  <table data-testid="dimension-table" class="table-base">
    <thead class="table-head">
      <tr>
        <th class="px-3 py-2 font-medium">{$t('Dimension')}</th>
        <th class="px-3 py-2 font-medium">{$t('Weight')}</th>
        <th class="px-3 py-2 font-medium">{$t('Direction')}</th>
      </tr>
    </thead>
    <tbody>
      {#each dimensions as dim (dim.name)}
        <tr class="table-row" data-testid="dimension-row">
          <td class="px-3 py-2 font-mono text-ink-strong">{dim.name}</td>
          <td class="px-3 py-2 tabular-nums text-ink-body">{dim.weight}</td>
          <td class="px-3 py-2 text-ink-body">
            <span aria-hidden="true">{arrow(dim.direction)}</span>
            {$t(dim.direction)}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
