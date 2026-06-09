<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import Self from './JsonTree.svelte';

  // One node of the collapsible JSON tree (ported from llm-router's vanilla-JS
  // detail viewer, src/api/admin/views/detail.ts). Recursive: objects/arrays render
  // as a native <details> open to DEFAULT_DEPTH; children render lazily on open and
  // are paginated at VISIBLE_LIMIT so a huge payload never blows up the DOM at once.
  // Long strings clip at STRING_LIMIT with an Expand toggle. Read-only — purely a view.
  const DEFAULT_DEPTH = 2;
  const VISIBLE_LIMIT = 200;
  const STRING_LIMIT = 512;
  const MAX_RENDER_DEPTH = 24;

  let { value, name, depth = 0 }: { value: unknown; name?: string; depth?: number } = $props();

  type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  function kindOf(v: unknown): Kind {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    const tp = typeof v;
    return tp === 'object' ? 'object' : (tp as Kind);
  }

  const kind = $derived(kindOf(value));
  const isBranch = $derived(kind === 'object' || kind === 'array');

  const entries = $derived.by((): [string, unknown][] => {
    if (kind === 'array') return (value as unknown[]).map((v, i) => [String(i), v]);
    if (kind === 'object') return Object.entries(value as Record<string, unknown>);
    return [];
  });

  // `depth` is fixed for the lifetime of a node (children are keyed), so capturing
  // its initial value for the default-open state is intentional — untrack silences
  // the (here spurious) state_referenced_locally warning.
  let open = $state(untrack(() => depth < DEFAULT_DEPTH));
  let visible = $state(VISIBLE_LIMIT);
  let expandedStr = $state(false);

  const isLongString = $derived(kind === 'string' && (value as string).length > STRING_LIMIT);
  const scalarText = $derived.by(() => {
    if (kind === 'string') {
      const s = value as string;
      if (isLongString && !expandedStr) return JSON.stringify(`${s.slice(0, STRING_LIMIT)}...`);
      return JSON.stringify(s);
    }
    if (kind === 'null') return 'null';
    return String(value);
  });

  const remaining = $derived(Math.max(0, entries.length - visible));
  function showMore(): void {
    visible = Math.min(entries.length, visible + VISIBLE_LIMIT);
  }
</script>

{#if isBranch}
  <div class="json-node" data-testid="json-node">
    <details bind:open>
      <summary class="cursor-pointer select-none">
        {#if name != null}<span class="text-link">{name}: </span>{/if}<span class="text-ink-muted"
          >{kind === 'array' ? `Array(${entries.length})` : `Object(${entries.length})`}</span
        >
      </summary>
      {#if open}
        <div class="ml-5 border-l border-border pl-3">
          {#if depth >= MAX_RENDER_DEPTH}
            <div class="text-ink-muted">{$t('Max depth reached')}</div>
          {:else}
            {#each entries.slice(0, visible) as [k, v] (k)}
              <Self value={v} name={k} depth={depth + 1} />
            {/each}
            {#if remaining > 0}
              <button type="button" class="mt-1 text-link underline" onclick={showMore}
                >{$t('Show remaining {count} items', { count: remaining })}</button
              >
            {/if}
          {/if}
        </div>
      {/if}
    </details>
  </div>
{:else}
  <div class="json-node" data-testid="json-node">
    {#if name != null}<span class="text-link">{name}: </span>{/if}<span
      class="json-scalar whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >{scalarText}</span
    >
    {#if isLongString}
      <button
        type="button"
        class="ml-2 text-link underline"
        onclick={() => (expandedStr = !expandedStr)}
        >{expandedStr ? $t('Collapse') : $t('Expand')}</button
      >
    {/if}
  </div>
{/if}
