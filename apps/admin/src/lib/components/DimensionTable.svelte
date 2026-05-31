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

<table data-testid="dimension-table" class="w-full text-sm">
  <thead>
    <tr class="border-b border-slate-200 text-left text-slate-500">
      <th class="py-2 pr-4 font-medium">{$t('Dimension')}</th>
      <th class="py-2 pr-4 font-medium">{$t('Weight')}</th>
      <th class="py-2 font-medium">{$t('Direction')}</th>
    </tr>
  </thead>
  <tbody>
    {#each dimensions as dim (dim.name)}
      <tr class="border-b border-slate-100" data-testid="dimension-row">
        <td class="py-1.5 pr-4 font-mono text-slate-800">{dim.name}</td>
        <td class="py-1.5 pr-4 tabular-nums text-slate-700">{dim.weight}</td>
        <td class="py-1.5 text-slate-600">
          <span aria-hidden="true">{arrow(dim.direction)}</span>
          {$t(dim.direction)}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
