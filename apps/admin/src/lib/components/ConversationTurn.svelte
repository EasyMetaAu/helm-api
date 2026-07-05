<script lang="ts">
  import { t } from '$lib/i18n';
  import type { ConversationTurn } from '$lib/conversation';
  import ImagePreview from './ImagePreview.svelte';
  import JsonViewer from './JsonViewer.svelte';

  // One chat bubble. Renders a single normalized ConversationTurn as a WhatsApp/
  // iMessage-style back-and-forth: assistant on the left, user/tool on the right.
  // Heavy content (system prompt, reasoning, tool bodies) starts collapsed so a
  // 100-turn Claude-Code session opens readable. The per-turn "View source" toggle
  // reveals THAT turn's exact wire object via the shared JsonViewer — the whole
  // point of the feature (查看脚本). Pure presentation; all folding lives in
  // conversation.ts.
  let {
    turn,
    index,
    showSystem,
    showReasoning,
  }: {
    turn: ConversationTurn;
    index: number;
    showSystem: boolean;
    showReasoning: boolean;
  } = $props();

  let sourceOpen = $state(false);

  // Assistant speaks from the left; the human (user) and tool outputs sit right —
  // the natural "them vs me" split of a chat client.
  const alignRight = $derived(turn.role === 'user' || turn.role === 'tool');

  // Role label + badge recipe, echoing StreamViewer's palette so the view reads as
  // the same product (sky=tool, ok=assistant, neutral=user/system).
  const ROLE_BADGE: Record<ConversationTurn['role'], string> = {
    assistant: 'badge-ok',
    user: 'badge-neutral',
    system: 'badge-fallback',
    tool: 'badge-rules',
  };
  function roleLabel(role: ConversationTurn['role']): string {
    return role === 'assistant'
      ? $t('Assistant')
      : role === 'user'
        ? $t('User')
        : role === 'system'
          ? $t('System')
          : $t('Tool');
  }

  // A tool call/result arg can be a JSON string (OpenAI) or an object (Anthropic/
  // Gemini) — JsonViewer normalizes both, so we hand it the value verbatim.
  function partKey(i: number): string {
    return `${index}-${i}`;
  }
</script>

<div
  data-testid="conversation-turn"
  data-turn-role={turn.role}
  class={`flex flex-col ${alignRight ? 'items-end' : 'items-start'}`}
>
  <!-- System turns collapse entirely behind the global toggle (huge prompts). -->
  {#if turn.role === 'system' && !showSystem}
    <div class="w-full rounded border border-border bg-canvas px-3 py-1.5 text-xs text-ink-muted">
      {$t('System prompt hidden — toggle “Show system” above to reveal.')}
    </div>
  {:else}
    <div class={`w-full max-w-full ${alignRight ? 'md:max-w-[85%]' : 'md:max-w-[85%]'}`}>
      <div class="mb-1 flex items-center gap-2 text-xs">
        <span class={ROLE_BADGE[turn.role]}>{roleLabel(turn.role)}</span>
        <button
          type="button"
          data-testid="conversation-source-toggle"
          class="ml-auto text-ink-muted underline decoration-dotted hover:text-ink-body"
          onclick={() => (sourceOpen = !sourceOpen)}
        >
          {sourceOpen ? $t('Hide source') : $t('View source')}
        </button>
      </div>

      <div
        class={`rounded-lg border px-3 py-2 text-sm ${
          alignRight ? 'border-action/30 bg-action/5' : 'border-border bg-surface'
        }`}
      >
        {#if turn.parts.length === 0}
          <p class="italic text-ink-muted">{$t('(no visible content)')}</p>
        {/if}

        {#each turn.parts as part, i (partKey(i))}
          {#if part.kind === 'text'}
            <p class="whitespace-pre-wrap break-words leading-relaxed text-ink-body">{part.text}</p>
          {:else if part.kind === 'reasoning'}
            <details data-testid="conversation-reasoning" class="my-1 rounded bg-canvas p-2" open={showReasoning}>
              <summary class="cursor-pointer text-xs font-medium text-ink-muted">{$t('Reasoning')}</summary>
              <p class="mt-1 whitespace-pre-wrap break-words text-xs text-ink-muted">{part.text}</p>
            </details>
          {:else if part.kind === 'image'}
            <div class="my-1">
              <ImagePreview src={part.url} label={$t('Image')} variant="thumb" />
            </div>
          {:else if part.kind === 'tool_call'}
            <details data-testid="conversation-tool" class="my-1 rounded bg-canvas p-2">
              <summary class="cursor-pointer text-xs">
                <span class="badge-rules">{$t('tool call')}</span>
                <span class="ml-1 font-mono font-medium text-ink-body">{part.name || $t('(unnamed)')}</span>
                {#if part.id}<span class="ml-1 font-mono text-ink-muted">{part.id}</span>{/if}
              </summary>
              <div class="mt-1"><JsonViewer value={part.args} /></div>
            </details>
          {:else if part.kind === 'tool_result'}
            <details data-testid="conversation-tool" class="my-1 rounded bg-canvas p-2">
              <summary class="cursor-pointer text-xs">
                <span class="badge-neutral">{$t('tool result')}</span>
                {#if part.name}<span class="ml-1 font-mono font-medium text-ink-body">{part.name}</span>{/if}
              </summary>
              <div class="mt-1"><JsonViewer value={part.output} /></div>
            </details>
          {:else}
            <details data-testid="conversation-tool" class="my-1 rounded bg-canvas p-2">
              <summary class="cursor-pointer text-xs text-ink-muted">{$t('Other content')}</summary>
              <div class="mt-1"><JsonViewer value={part.value} /></div>
            </details>
          {/if}
        {/each}
      </div>

      <!-- View source: the exact captured wire object for THIS turn. Mounted lazily
           so a 100-turn transcript doesn't build 100 JSON trees up front. -->
      {#if sourceOpen}
        <div data-testid="conversation-source" class="mt-1">
          <JsonViewer value={turn.raw} />
        </div>
      {/if}
    </div>
  {/if}
</div>
