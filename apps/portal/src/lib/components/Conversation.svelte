<script lang="ts">
  import { t } from "$lib/i18n";
  import {
    extractConversation,
    type ConversationTurn,
  } from "$lib/conversation";
  import ConversationTurnRow from "./ConversationTurn.svelte";

  // The chat lens for a captured request. Folds the transcript + final reply (see
  // conversation.ts, which already drops empty parts/turns and merges tool
  // call↔result) and renders a scannable, collapsed-by-default timeline: every row
  // is a one-line summary that expands on click. A toolbar carries the only global
  // controls that matter for a 150-turn trace — collapse/expand all, jump to the
  // first reply, and a role filter. System turns are hidden by default (a Codex
  // system prompt is huge); one quiet chip says how many are hidden.
  let {
    request,
    response,
    testid,
  }: {
    request: unknown;
    response: unknown;
    testid?: string;
  } = $props();

  const allTurns = $derived(extractConversation(request, response));

  // Roles present, for the filter chips. system is opt-in (hidden by default).
  let showSystem = $state(false);
  let showReasoning = $state(false);
  // null = all roles; otherwise only this role shows.
  let roleFilter = $state<ConversationTurn["role"] | null>(null);
  // Global expand/collapse: a bumping nonce so even a repeated "Expand all" re-applies
  // to rows the user manually collapsed in between.
  let expandCommand = $state<{ open: boolean; nonce: number } | null>(null);
  let expandNonce = 0;
  function commandAll(openAll: boolean) {
    expandNonce += 1;
    expandCommand = { open: openAll, nonce: expandNonce };
  }

  const systemCount = $derived(
    allTurns.filter((tn) => tn.role === "system").length,
  );

  const visible = $derived(
    allTurns.filter((tn) => {
      if (tn.role === "system" && !showSystem) return false;
      if (roleFilter && tn.role !== roleFilter) return false;
      return true;
    }),
  );

  // Index of the first assistant turn in the FULL list — the "jump to reply" target
  // (Codex front-loads dozens of context turns before the model speaks).
  const firstAssistantIdx = $derived(
    allTurns.findIndex((tn) => tn.role === "assistant"),
  );

  const rolesPresent = $derived.by(() => {
    const seen = new Set<ConversationTurn["role"]>();
    for (const tn of allTurns) seen.add(tn.role);
    return (["assistant", "user", "tool", "system"] as const).filter((r) =>
      seen.has(r),
    );
  });
  function roleChipLabel(role: ConversationTurn["role"]): string {
    return role === "assistant"
      ? $t("Assistant")
      : role === "user"
        ? $t("User")
        : role === "system"
          ? $t("System")
          : $t("Tool");
  }

  let container: HTMLDivElement | undefined;
  function jumpToFirstReply() {
    const el = container?.querySelector('[data-first-assistant="true"]');
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

<div data-testid={testid} bind:this={container} class="flex flex-col gap-2">
  {#if allTurns.length === 0}
    <p data-testid="conversation-empty" class="text-sm italic text-ink-muted">
      {$t("No conversation could be reconstructed from the captured body.")}
    </p>
  {:else}
    <!-- Toolbar: the only global controls. Kept to one quiet row. -->
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-2 text-xs"
    >
      <!-- role filter chips -->
      <div class="flex items-center gap-1" data-testid="conversation-filter">
        <button
          type="button"
          class={`rounded-full px-2 py-0.5 ${roleFilter === null ? "bg-action text-white" : "text-ink-muted hover:bg-canvas"}`}
          onclick={() => (roleFilter = null)}>{$t("All")}</button
        >
        {#each rolesPresent as role (role)}
          {#if role !== "system"}
            <button
              type="button"
              class={`rounded-full px-2 py-0.5 ${roleFilter === role ? "bg-action text-white" : "text-ink-muted hover:bg-canvas"}`}
              onclick={() => (roleFilter = roleFilter === role ? null : role)}
              >{roleChipLabel(role)}</button
            >
          {/if}
        {/each}
      </div>

      <span class="text-ink-faint">·</span>

      <!-- collapse / expand all -->
      <button
        type="button"
        data-testid="conversation-expand-all"
        class="text-ink-muted hover:text-link"
        onclick={() => commandAll(true)}
      >
        {$t("Expand all")}
      </button>
      <button
        type="button"
        data-testid="conversation-collapse-all"
        class="text-ink-muted hover:text-link"
        onclick={() => commandAll(false)}
      >
        {$t("Collapse all")}
      </button>

      {#if firstAssistantIdx > 3}
        <span class="text-ink-faint">·</span>
        <button
          type="button"
          data-testid="conversation-jump-reply"
          class="text-ink-muted hover:text-link"
          onclick={jumpToFirstReply}
        >
          ↓ {$t("First reply")}
        </button>
      {/if}

      <label class="flex cursor-pointer items-center gap-1.5 text-ink-muted">
        <input
          type="checkbox"
          bind:checked={showReasoning}
          data-testid="conversation-toggle-reasoning"
        />
        {$t("Show reasoning")}
      </label>

      <span class="ml-auto text-ink-faint"
        >{$t("{count} turns", { count: allTurns.length })}</span
      >
    </div>

    <!-- One quiet line for the hidden system prompt(s). -->
    {#if systemCount > 0 && !showSystem}
      <button
        type="button"
        data-testid="conversation-show-system"
        class="self-start rounded-md border border-amber-200 bg-amber-50/50 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
        onclick={() => (showSystem = true)}
      >
        {$t("{count} system prompt hidden — show", { count: systemCount })}
      </button>
    {/if}

    <div class="flex flex-col">
      {#each visible as turn, i (i)}
        <div data-first-assistant={allTurns[firstAssistantIdx] === turn}>
          <ConversationTurnRow
            {turn}
            index={i}
            {showReasoning}
            {expandCommand}
            grouped={i > 0 && visible[i - 1].role === turn.role}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>
