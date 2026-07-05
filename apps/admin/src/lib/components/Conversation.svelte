<script lang="ts">
  import { t } from '$lib/i18n';
  import { extractConversation } from '$lib/conversation';
  import ConversationTurn from './ConversationTurn.svelte';

  // The chat lens for a captured request. Folds the request transcript + the final
  // response into an ordered list of bubbles (see conversation.ts) and renders them
  // back-and-forth. Noise defaults are opinionated: the system prompt and reasoning
  // start hidden (a Claude-Code system prompt is thousands of tokens), and very long
  // transcripts render behind a "show all" cap so first paint stays cheap. Everything
  // heavy lives in the pure normalizer; this component only orchestrates + toggles.
  let {
    request,
    response,
    testid,
  }: {
    request: unknown;
    response: unknown;
    testid?: string;
  } = $props();

  const turns = $derived(extractConversation(request, response));

  let showSystem = $state(false);
  let showReasoning = $state(false);
  let showAll = $state(false);

  // Cap eager rendering; the tail is one click away. Bounded so a huge session
  // doesn't build hundreds of bubbles before the operator asks for them.
  const CAP = 50;
  const visible = $derived(showAll ? turns : turns.slice(0, CAP));
  const hiddenCount = $derived(turns.length - visible.length);
</script>

<div data-testid={testid} class="flex flex-col gap-3">
  {#if turns.length === 0}
    <p data-testid="conversation-empty" class="italic text-ink-muted text-sm">
      {$t('No conversation could be reconstructed from the captured body.')}
    </p>
  {:else}
    <!-- Noise toggles: system + reasoning hidden by default. -->
    <div class="flex flex-wrap items-center gap-4 text-xs text-ink-muted">
      <label class="flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showSystem} data-testid="conversation-toggle-system" />
        {$t('Show system')}
      </label>
      <label class="flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showReasoning} data-testid="conversation-toggle-reasoning" />
        {$t('Show reasoning')}
      </label>
      <span class="ml-auto">{$t('{count} turns', { count: turns.length })}</span>
    </div>

    <!-- Group consecutive same-role turns: only the first of a run shows its
         avatar + label, so a long stretch of Codex context/tool turns reads as one
         cluster instead of a wall of repeated "User" stamps. -->
    <div class="flex flex-col">
      {#each visible as turn, i (i)}
        <ConversationTurn
          {turn}
          index={i}
          {showSystem}
          {showReasoning}
          grouped={i > 0 && visible[i - 1].role === turn.role}
        />
      {/each}
    </div>

    {#if hiddenCount > 0}
      <button
        type="button"
        data-testid="conversation-show-all"
        class="btn-secondary self-center text-sm"
        onclick={() => (showAll = true)}
      >
        {$t('Show all {count} turns', { count: turns.length })}
      </button>
    {/if}
  {/if}
</div>
