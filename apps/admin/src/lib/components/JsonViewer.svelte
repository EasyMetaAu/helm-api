<script lang="ts">
  import { t } from '$lib/i18n';
  import FullscreenToggle from './FullscreenToggle.svelte';
  import JsonTree from './JsonTree.svelte';
  import { type JsonTreeCtl, setJsonTreeCtl } from './jsonTreeContext';
  import { VIEWER_FS_CONTAINER, viewerSizing } from './viewerChrome';

  // Tabbed JSON viewer: Tree (collapsible, default) / Formatted (pretty JSON) / Raw.
  // Mirrors llm-router's per-panel viewer. `value` is `unknown` because captured
  // request/response bodies may be a parsed object/array OR a raw string (e.g. an
  // assembled SSE stream): a JSON string is parsed for the tree; a non-JSON string
  // is shown verbatim instead of erroring (fail-soft, never white-screen).
  type Tab = 'tree' | 'formatted' | 'raw';
  const TABS: Tab[] = ['tree', 'formatted', 'raw'];

  let { value, testid }: { value: unknown; testid?: string } = $props();

  let tab = $state<Tab>('tree');
  // Fullscreen lifts the whole viewer into a fixed overlay (see viewerChrome.ts);
  // FullscreenToggle owns the Escape-to-exit shortcut.
  let fullscreen = $state(false);

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
  const formatted = $derived(
    normalized.parsedOk ? JSON.stringify(data, null, 2) : (data as string),
  );

  // Empty/null get a friendly placeholder instead of a bare, confusing tree root.
  const emptyPlaceholder = $derived.by((): string | null => {
    if (data === null) return $t('(null)');
    if (Array.isArray(data) && data.length === 0) return $t('(empty array)');
    if (data != null && typeof data === 'object' && Object.keys(data).length === 0)
      return $t('(empty object)');
    return null;
  });

  // A collapsible tree only exists when the root is a non-empty object/array.
  // Scalars and the empty/null placeholders have nothing to expand or collapse.
  const hasTree = $derived(
    emptyPlaceholder === null &&
      data !== null &&
      typeof data === 'object' &&
      (Array.isArray(data) ? data.length > 0 : Object.keys(data as object).length > 0),
  );

  // Broadcast channel for Expand all / Collapse all. Each JsonTree node owns its
  // own open state and reacts to `nonce` bumps (see jsonTreeContext). Bumping the
  // nonce re-fires even when `allOpen` is unchanged across two clicks of the same
  // button, and is what lets a collapse → expand round-trip re-open everything.
  const treeCtl = $state<JsonTreeCtl>({ allOpen: false, nonce: 0 });
  setJsonTreeCtl(treeCtl);
  function expandAll(): void {
    treeCtl.allOpen = true;
    treeCtl.nonce += 1;
  }
  function collapseAll(): void {
    treeCtl.allOpen = false;
    treeCtl.nonce += 1;
  }

  function tabLabel(id: Tab): string {
    return id === 'tree' ? $t('Tree') : id === 'formatted' ? $t('Formatted') : $t('Raw');
  }

  const tabActive = 'border-action bg-action text-white';
  const tabInactive = 'border-border bg-surface text-ink-muted hover:bg-canvas';
  // Height/resize comes from the shared helper (capped+resizable, or flex-fill when
  // fullscreen); the rest of the recipe is unchanged.
  const basePanelCls = $derived(
    `${viewerSizing(fullscreen)} overflow-y-auto overflow-x-hidden rounded bg-canvas p-2 font-mono text-xs break-words [overflow-wrap:anywhere] text-ink-body`,
  );
  // Tree markup contains recursive <details> with template newlines between nodes.
  // Keep whitespace normal here so those source newlines do not render as blank rows.
  const treePanelCls = $derived(`${basePanelCls} whitespace-normal`);
  const textPanelCls = $derived(`${basePanelCls} whitespace-pre-wrap`);
</script>

<div data-testid={testid} class={fullscreen ? VIEWER_FS_CONTAINER : ''}>
  <div class="mb-2 flex flex-wrap items-center gap-2">
    {#each TABS as id (id)}
      <button
        type="button"
        class={`rounded border px-3 py-1 text-sm ${tab === id ? tabActive : tabInactive}`}
        onclick={() => (tab = id)}>{tabLabel(id)}</button
      >
    {/each}
    <div class="ml-auto flex items-center gap-2">
      {#if tab === 'tree' && hasTree}
        <button
          type="button"
          class={`rounded border px-3 py-1 text-sm ${tabInactive}`}
          data-testid="jsontree-expand-all"
          onclick={expandAll}>{$t('Expand all')}</button
        >
        <button
          type="button"
          class={`rounded border px-3 py-1 text-sm ${tabInactive}`}
          data-testid="jsontree-collapse-all"
          onclick={collapseAll}>{$t('Collapse all')}</button
        >
      {/if}
      <FullscreenToggle bind:active={fullscreen} testid="jsonviewer-fullscreen" />
    </div>
  </div>

  <div data-testid="jsonviewer-tree" hidden={tab !== 'tree'} class={treePanelCls}>
    {#if emptyPlaceholder}
      <div class="text-ink-muted">{emptyPlaceholder}</div>
    {:else}
      <JsonTree value={data} />
    {/if}
  </div>

  <pre
    data-testid="jsonviewer-formatted"
    hidden={tab !== 'formatted'}
    class={textPanelCls}>{formatted}</pre>

  <pre
    data-testid="jsonviewer-raw"
    hidden={tab !== 'raw'}
    class={textPanelCls}>{normalized.raw}</pre>
</div>
