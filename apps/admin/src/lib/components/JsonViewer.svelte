<script lang="ts">
  import { t } from '$lib/i18n';
  import JsonTree from './JsonTree.svelte';

  // Tabbed JSON viewer: Tree (collapsible, default) / Formatted (pretty JSON) / Raw.
  // Mirrors llm-router's per-panel viewer. `value` is `unknown` because captured
  // request/response bodies may be a parsed object/array OR a raw string (e.g. an
  // assembled SSE stream): a JSON string is parsed for the tree; a non-JSON string
  // is shown verbatim instead of erroring (fail-soft, never white-screen).
  type Tab = 'tree' | 'formatted' | 'raw';
  const TABS: Tab[] = ['tree', 'formatted', 'raw'];

  let { value, testid }: { value: unknown; testid?: string } = $props();

  let tab = $state<Tab>('tree');

  const normalized = $derived.by((): { data: unknown; raw: string; parsedOk: boolean } => {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        return { data: parsed, raw: JSON.stringify(parsed, null, 2), parsedOk: true };
      } catch {
        return { data: value, raw: value, parsedOk: false };
      }
    }
    try {
      return { data: value, raw: JSON.stringify(value, null, 2), parsedOk: true };
    } catch {
      return { data: value, raw: String(value), parsedOk: false };
    }
  });

  const data = $derived(normalized.data);
  const formatted = $derived(normalized.parsedOk ? JSON.stringify(data, null, 2) : (data as string));

  // Empty/null get a friendly placeholder instead of a bare, confusing tree root.
  const emptyPlaceholder = $derived.by((): string | null => {
    if (data === null) return $t('(null)');
    if (Array.isArray(data) && data.length === 0) return $t('(empty array)');
    if (data != null && typeof data === 'object' && Object.keys(data).length === 0)
      return $t('(empty object)');
    return null;
  });

  function tabLabel(id: Tab): string {
    return id === 'tree' ? $t('Tree') : id === 'formatted' ? $t('Formatted') : $t('Raw');
  }

  const tabActive = 'border-action bg-action text-white';
  const tabInactive = 'border-border bg-surface text-ink-muted hover:bg-canvas';
  const panelCls = 'max-h-96 overflow-auto rounded bg-canvas p-2 font-mono text-xs text-ink-body';
</script>

<div data-testid={testid}>
  <div class="mb-2 flex flex-wrap gap-2">
    {#each TABS as id (id)}
      <button
        type="button"
        class={`rounded border px-3 py-1 text-sm ${tab === id ? tabActive : tabInactive}`}
        onclick={() => (tab = id)}>{tabLabel(id)}</button
      >
    {/each}
  </div>

  <div data-testid="jsonviewer-tree" hidden={tab !== 'tree'} class={panelCls}>
    {#if emptyPlaceholder}
      <div class="text-ink-muted">{emptyPlaceholder}</div>
    {:else}
      <JsonTree value={data} />
    {/if}
  </div>

  <pre data-testid="jsonviewer-formatted" hidden={tab !== 'formatted'} class={panelCls}>{formatted}</pre>

  <pre data-testid="jsonviewer-raw" hidden={tab !== 'raw'} class={panelCls}>{normalized.raw}</pre>
</div>
