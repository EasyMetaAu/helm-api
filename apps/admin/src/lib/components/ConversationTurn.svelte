<script lang="ts">
  import { t } from '$lib/i18n';
  import type { ConversationTurn } from '$lib/conversation';
  import ImagePreview from './ImagePreview.svelte';
  import JsonViewer from './JsonViewer.svelte';

  // One conversation row, rendered as a single-column transcript (the shape agent
  // logs actually take — a Codex/Claude-Code turn stream is mostly same-role runs,
  // so left/right bubbles leave half the width empty). Each row: a role avatar + name
  // on a colored left spine, then the content. Consecutive same-role turns are
  // `grouped` — the avatar/header is dropped so a run reads as one block. A tall row
  // clamps to a fixed height with a fade + "Show more" (measured, so it works for any
  // content), and reasoning / tool bodies stay collapsed. So a 150-turn session opens
  // skimmable. Pure presentation; folding lives in conversation.ts.
  let {
    turn,
    index,
    showSystem,
    showReasoning,
    grouped = false,
  }: {
    turn: ConversationTurn;
    index: number;
    showSystem: boolean;
    showReasoning: boolean;
    /** True when the previous turn had the same role — hide avatar + header. */
    grouped?: boolean;
  } = $props();

  let sourceOpen = $state(false);
  let expanded = $state(false);
  // Set by the `clampProbe` action once the natural height exceeds the cap.
  let overflowing = $state(false);

  // Collapsed rows cap here; taller content fades under a "Show more". ~10 lines —
  // enough to read the gist, small enough a 400px context dump can't dominate.
  const CLAMP_PX = 240;

  // Measure rendered content vs the cap (content-agnostic, unlike a char count).
  // ResizeObserver may be absent (jsdom / very old browsers) — degrade to a one-shot
  // measure so the row still renders and clamps on its initial height.
  function clampProbe(node: HTMLElement) {
    const measure = () => {
      overflowing = node.scrollHeight > CLAMP_PX + 8;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  // Per-role identity: avatar glyph + color, and a left spine tint. Straight from the
  // app tokens (indigo brand = assistant, slate = user, amber = system, sky = tool).
  type RoleStyle = { glyph: string; avatar: string; spine: string; name: string };
  const ROLE: Record<ConversationTurn['role'], RoleStyle> = {
    user: { glyph: 'U', avatar: 'bg-slate-700 text-white', spine: 'border-slate-300', name: 'text-ink-strong' },
    assistant: { glyph: 'AI', avatar: 'bg-brand text-white', spine: 'border-indigo-300', name: 'text-brand' },
    system: { glyph: 'S', avatar: 'bg-amber-500 text-white', spine: 'border-amber-300', name: 'text-amber-700' },
    tool: { glyph: '↳', avatar: 'bg-sky-600 text-white', spine: 'border-sky-300', name: 'text-sky-700' },
  };
  const style = $derived(ROLE[turn.role]);
  function roleLabel(role: ConversationTurn['role']): string {
    return role === 'assistant'
      ? $t('Assistant')
      : role === 'user'
        ? $t('User')
        : role === 'system'
          ? $t('System')
          : $t('Tool');
  }

  function partKey(i: number): string {
    return `${index}-${i}`;
  }
</script>

{#if turn.role === 'system' && !showSystem}
  <!-- System prompt: one quiet strip behind the global toggle (prompts are huge). -->
  <div class="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-1.5 text-xs text-ink-muted">
    {$t('System prompt hidden — toggle “Show system” above to reveal.')}
  </div>
{:else}
  <div
    data-testid="conversation-turn"
    data-turn-role={turn.role}
    class={`flex gap-3 border-l-2 pl-3 ${style.spine} ${grouped ? 'mt-0' : 'mt-3'}`}
  >
    <!-- Avatar rail: shown once per run of same-role turns; a spacer keeps grouped
         rows aligned under the first. -->
    <div class="w-7 shrink-0">
      {#if !grouped}
        <div
          class={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ${style.avatar}`}
          title={roleLabel(turn.role)}
        >
          {style.glyph}
        </div>
      {/if}
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
      {#if !grouped}
        <div class="mb-1 flex items-center gap-2 text-xs">
          <span class={`font-semibold ${style.name}`}>{roleLabel(turn.role)}</span>
          <button
            type="button"
            data-testid="conversation-source-toggle"
            class="ml-auto text-ink-faint transition-colors hover:text-link"
            onclick={() => (sourceOpen = !sourceOpen)}
          >
            {sourceOpen ? $t('Hide source') : $t('View source')}
          </button>
        </div>
      {/if}

      <div class="relative">
        <div
          use:clampProbe
          class="overflow-hidden text-sm text-ink-body"
          style={overflowing && !expanded ? `max-height:${CLAMP_PX}px` : ''}
        >
          {#if turn.parts.length === 0}
            <p class="italic text-ink-faint">{$t('(no visible content)')}</p>
          {/if}

          {#each turn.parts as part, i (partKey(i))}
            {#if part.kind === 'text'}
              <p class="whitespace-pre-wrap break-words leading-relaxed">{part.text}</p>
            {:else if part.kind === 'reasoning'}
              <details
                data-testid="conversation-reasoning"
                class="my-1 rounded-lg border border-violet-200 bg-violet-50/70 p-2"
                open={showReasoning}
              >
                <summary class="cursor-pointer text-xs font-medium text-violet-700">{$t('Reasoning')}</summary>
                <p class="mt-1 whitespace-pre-wrap break-words text-xs text-ink-muted">{part.text}</p>
              </details>
            {:else if part.kind === 'image'}
              <div class="my-1">
                <ImagePreview src={part.url} label={$t('Image')} variant="thumb" />
              </div>
            {:else if part.kind === 'tool_call'}
              <details data-testid="conversation-tool" class="my-1 rounded-lg border border-sky-200 bg-sky-50/70 p-2">
                <summary class="flex cursor-pointer items-center gap-1.5 text-xs">
                  <span class="badge-rules">{$t('tool call')}</span>
                  <span class="font-mono font-medium text-ink-strong">{part.name || $t('(unnamed)')}</span>
                  {#if part.id}<span class="truncate font-mono text-ink-faint">{part.id}</span>{/if}
                </summary>
                <div class="mt-1.5"><JsonViewer value={part.args} /></div>
              </details>
            {:else if part.kind === 'tool_result'}
              <details data-testid="conversation-tool" class="my-1 rounded-lg border border-border bg-canvas p-2">
                <summary class="flex cursor-pointer items-center gap-1.5 text-xs">
                  <span class="badge-neutral">{$t('tool result')}</span>
                  {#if part.name}<span class="font-mono font-medium text-ink-strong">{part.name}</span>{/if}
                </summary>
                <div class="mt-1.5"><JsonViewer value={part.output} /></div>
              </details>
            {:else}
              <details data-testid="conversation-tool" class="my-1 rounded-lg border border-border bg-canvas p-2">
                <summary class="cursor-pointer text-xs text-ink-muted">{$t('Other content')}</summary>
                <div class="mt-1.5"><JsonViewer value={part.value} /></div>
              </details>
            {/if}
          {/each}
        </div>

        <!-- Fade + toggle over the cut-off edge of a clamped row. -->
        {#if overflowing}
          {#if !expanded}
            <div class="pointer-events-none absolute inset-x-0 bottom-6 h-8 bg-gradient-to-t from-surface to-transparent"></div>
          {/if}
          <button
            type="button"
            data-testid="conversation-expand"
            class="mt-1 text-xs font-medium text-link hover:underline"
            onclick={() => (expanded = !expanded)}
          >
            {expanded ? $t('Show less') : $t('Show more')}
          </button>
        {/if}
      </div>

      <!-- Grouped rows have no header; give them their own quiet source toggle. -->
      {#if grouped}
        <button
          type="button"
          data-testid="conversation-source-toggle"
          class="mt-0.5 self-start text-[11px] text-ink-faint hover:text-link"
          onclick={() => (sourceOpen = !sourceOpen)}
        >
          {sourceOpen ? $t('Hide source') : $t('View source')}
        </button>
      {/if}

      <!-- View source: the exact captured wire object for THIS turn, lazily mounted. -->
      {#if sourceOpen}
        <div data-testid="conversation-source" class="mt-1">
          <JsonViewer value={turn.raw} />
        </div>
      {/if}
    </div>
  </div>
{/if}
