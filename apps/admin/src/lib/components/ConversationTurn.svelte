<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import { formatToolArgs, toolOutputPeek, type ConversationTurn, type TurnPart } from '$lib/conversation';
  import ImagePreview from './ImagePreview.svelte';
  import JsonViewer from './JsonViewer.svelte';

  // One conversation row in the transcript. Two states, inverted from a naive viewer:
  //   COLLAPSED (default) — a single dense line: role dot + name (first of a run only)
  //     + a one-line preview + type badges (reasoning / tool / image / error) + a size
  //     hint. This is what makes a 150-turn Codex trace scannable instead of a wall.
  //   EXPANDED (on click) — full text, reasoning, merged tool exchanges, images.
  // Raw wire JSON is a hover-revealed { } icon (not a per-turn link × 48). The
  // normalizer already dropped empty parts/turns, so everything here carries signal.
  // Pure presentation; folding + suppression live in conversation.ts.
  let {
    turn,
    index,
    showReasoning,
    grouped = false,
    expandCommand = null,
  }: {
    turn: ConversationTurn;
    index: number;
    showReasoning: boolean;
    /** True when the previous turn had the same role — hide the avatar/name header. */
    grouped?: boolean;
    /**
     * Global expand/collapse-all. `nonce` bumps on every click (even repeats), so the
     * effect always re-fires and re-applies `open` — a second "Expand all" after a
     * manual collapse still opens the row. null = no global command issued yet.
     */
    expandCommand?: { open: boolean; nonce: number } | null;
  } = $props();

  // A turn made entirely of tool calls (no prose/image/reasoning) is opened by default:
  // its whole signal IS the tool exchange, so the extra "expand the row first" click is
  // pure friction — the inline peek should just be there (Claude-Code style). Mixed and
  // text/reasoning turns still start collapsed to keep a long trace scannable. Computed
  // once at mount (turns never mutate in place), so read `turn` inside the initializer.
  const isToolOnly = (t: ConversationTurn): boolean =>
    t.parts.length > 0 && t.parts.every((p) => p.kind === 'tool_exchange' || p.kind === 'tool_result' || p.kind === 'tool_call');
  // A tool-only turn drops the separate role-header row entirely: it would render as an
  // near-empty `▾ ● { }` line above the tool block (ugly, no content). The tool line IS
  // the row — it carries the name, args, status, and the hover-revealed source toggle.
  const toolOnly = $derived(isToolOnly(turn));
  // Index of the first tool part — the one that carries the turn's single `{ }` source
  // toggle when the header row is dropped (tool-only turns), so it appears once, not per row.
  const firstToolPart = $derived(turn.parts.findIndex((p) => p.kind === 'tool_exchange' || p.kind === 'tool_result' || p.kind === 'tool_call'));
  // Read the initial tool-only-ness once for the default open state (untracked so the
  // $state initializer doesn't capture `turn` reactively — turns never mutate in place).
  let open = $state(untrack(() => isToolOnly(turn)));
  let sourceOpen = $state(false);
  // Apply a global command whenever its nonce changes (tracked by value, so identical
  // consecutive commands still re-apply). A later per-row toggle just flips `open`.
  let lastNonce = -1;
  $effect(() => {
    if (expandCommand && expandCommand.nonce !== lastNonce) {
      lastNonce = expandCommand.nonce;
      open = expandCommand.open;
    }
  });
  function toggle() {
    open = !open;
  }

  // Which tool parts have their FULL JsonViewer revealed (keyed by part index). The
  // terminal-style block shows an inline peek by default; clicking "+N lines" or the
  // header lifts the full args+result viewer. A Set keeps each tool row independent.
  let toolOpen = $state<Set<number>>(new Set());
  function toggleTool(i: number) {
    const next = new Set(toolOpen);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    toolOpen = next;
  }

  // Expanded tool header gets a wider arg budget than the 72-char collapsed line.
  const EXPANDED_ARG_CHARS = 160;
  // Inline output peek is a glimpse, not the log — keep it short (full body is one click away).
  const PEEK_LINES = 3;

  // Per-role identity: dot color + spine tint + name color — straight from app tokens
  // (indigo brand = assistant, slate = user, amber = system, sky = tool).
  type RoleStyle = { dot: string; spine: string; name: string };
  const ROLE: Record<ConversationTurn['role'], RoleStyle> = {
    user: { dot: 'bg-slate-500', spine: 'border-slate-200', name: 'text-ink-strong' },
    assistant: { dot: 'bg-brand', spine: 'border-indigo-200', name: 'text-brand' },
    system: { dot: 'bg-amber-500', spine: 'border-amber-200', name: 'text-amber-700' },
    tool: { dot: 'bg-sky-500', spine: 'border-sky-200', name: 'text-sky-700' },
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

  // ── collapsed-line summary ─────────────────────────────────────────────────
  // First non-empty text, single line, clipped — the "what was said" preview.
  const preview = $derived.by(() => {
    const textPart = turn.parts.find((p) => p.kind === 'text');
    if (textPart && textPart.kind === 'text') return textPart.text.replace(/\s+/g, ' ').trim();
    // no text → describe by the dominant non-text part. For a tool call, fill the
    // parens with a preview of its key argument so the row reads `Bash(grep …)`, not
    // a blind `Bash()` (full args still show expanded).
    const ex = turn.parts.find((p) => p.kind === 'tool_exchange');
    if (ex && ex.kind === 'tool_exchange') return `${ex.name || $t('tool call')}(${formatToolArgs(ex.name, ex.args)})`;
    const r = turn.parts.find((p) => p.kind === 'reasoning');
    if (r && r.kind === 'reasoning') return r.text.replace(/\s+/g, ' ').trim();
    if (turn.parts.some((p) => p.kind === 'image')) return $t('Image');
    if (turn.parts.some((p) => p.kind === 'tool_result')) return $t('tool result');
    // a turn with only opaque/unknown parts still gets a label, never a blank row
    if (turn.parts.length > 0) return $t('Other content');
    return '';
  });

  // Type badges — icons only for the kinds actually present (absence itself is signal).
  const counts = $derived.by(() => {
    let reasoning = 0;
    let tools = 0;
    let images = 0;
    let errors = 0;
    for (const p of turn.parts) {
      if (p.kind === 'reasoning') reasoning++;
      else if (p.kind === 'tool_exchange') {
        tools++;
        if (p.hasResult && isErrorOutput(p.output)) errors++;
      } else if (p.kind === 'image') images++;
    }
    return { reasoning, tools, images, errors };
  });

  // A rough size hint for the collapsed line, so a 40KB context dump is obvious.
  const sizeHint = $derived.by(() => {
    let chars = 0;
    for (const p of turn.parts) {
      if (p.kind === 'text' || p.kind === 'reasoning') chars += p.text.length;
      else if (p.kind === 'tool_exchange') chars += approxLen(p.args) + approxLen(p.output);
    }
    if (chars < 1000) return '';
    return chars < 10000 ? `${Math.round(chars / 100) / 10}k` : `${Math.round(chars / 1000)}k`;
  });

  function approxLen(v: unknown): number {
    if (typeof v === 'string') return v.length;
    if (v == null) return 0;
    try {
      return JSON.stringify(v).length;
    } catch {
      return 0;
    }
  }
  function isErrorOutput(v: unknown): boolean {
    const s = typeof v === 'string' ? v : approxLen(v) > 0 ? JSON.stringify(v) : '';
    return /"?(error|is_error|isError)"?\s*[:=]\s*(true|"[^"]|')/i.test(s) || /^error\b/i.test(s.trim());
  }
  function exchangeStatus(p: Extract<TurnPart, { kind: 'tool_exchange' }>): {
    glyph: string;
    cls: string;
    label: string;
  } {
    if (!p.hasResult) return { glyph: '⋯', cls: 'text-ink-faint', label: $t('no result') };
    if (isErrorOutput(p.output)) return { glyph: '✗', cls: 'text-red-600', label: $t('error') };
    if (p.output == null || p.output === '' || approxLen(p.output) <= 2)
      return { glyph: '∅', cls: 'text-ink-faint', label: $t('empty') };
    return { glyph: '✓', cls: 'text-emerald-600', label: $t('ok') };
  }

  function partKey(i: number): string {
    return `${index}-${i}`;
  }
</script>

<div
  data-testid="conversation-turn"
  data-turn-role={turn.role}
  data-open={open}
  class={`group border-l-2 pl-3 ${style.spine} ${grouped ? '' : 'mt-3'}`}
>
  <!-- Collapsed header line: click anywhere to expand. One dense, scannable row.
       A tool-only turn SKIPS this row — the tool block below is the whole row (it
       carries name/args/status + its own source toggle), so no empty `▾ ● { }` line. -->
  {#if !toolOnly}
    <div class="flex items-center gap-2">
      <button
        type="button"
        data-testid="conversation-row-toggle"
        class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        onclick={toggle}
        aria-expanded={open}
      >
        <!-- disclosure caret -->
        <span class="shrink-0 text-[10px] text-ink-faint">{open ? '▾' : '▸'}</span>
        <!-- role dot + name (name only on the first row of a same-role run) -->
        <span class={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}></span>
        {#if !grouped}
          <span class={`shrink-0 text-xs font-semibold ${style.name}`}>{roleLabel(turn.role)}</span>
        {/if}
        <!-- one-line preview (hidden once expanded — the full content shows below) -->
        {#if !open}
          <span class="min-w-0 flex-1 truncate text-xs text-ink-muted">{preview}</span>
        {:else}
          <span class="flex-1"></span>
        {/if}
        <!-- type badges: only what's present -->
        <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-faint">
          {#if counts.reasoning}<span title={$t('Reasoning')}>🧠</span>{/if}
          {#if counts.tools}<span title={$t('tool call')}>🔧{counts.tools > 1 ? `×${counts.tools}` : ''}</span>{/if}
          {#if counts.images}<span title={$t('Image')}>🖼{counts.images > 1 ? `×${counts.images}` : ''}</span>{/if}
          {#if counts.errors}<span class="text-red-500" title={$t('error')}>⚠</span>{/if}
          {#if sizeHint}<span class="font-mono">{sizeHint}</span>{/if}
        </span>
      </button>
      <!-- hover-revealed raw-source affordance (no 48 always-on links) -->
      <button
        type="button"
        data-testid="conversation-source-toggle"
        class="shrink-0 rounded px-1 font-mono text-xs text-ink-faint opacity-0 transition-opacity hover:text-link focus:opacity-100 group-hover:opacity-100"
        title={$t('View source')}
        onclick={() => (sourceOpen = !sourceOpen)}
      >
        {'{ }'}
      </button>
    </div>
  {/if}

  <!-- Expanded body — flat, terminal-style transcript (no boxes; dot+indent spine). -->
  {#if open}
    <div class="pb-2 pl-4 text-sm text-ink-body">
      {#each turn.parts as part, i (partKey(i))}
        {#if part.kind === 'text'}
          <p class="my-1 whitespace-pre-wrap break-words leading-relaxed">{part.text}</p>
        {:else if part.kind === 'reasoning'}
          <details data-testid="conversation-reasoning" class="my-1" open={showReasoning}>
            <summary class="cursor-pointer text-xs font-medium text-violet-600">🧠 {$t('Reasoning')}</summary>
            <p class="mt-1 whitespace-pre-wrap break-words border-l-2 border-violet-200 pl-3 text-xs text-ink-muted">{part.text}</p>
          </details>
        {:else if part.kind === 'image'}
          <div class="my-1"><ImagePreview src={part.url} label={$t('Image')} variant="thumb" /></div>
        {:else if part.kind === 'tool_exchange'}
          {@const st = exchangeStatus(part)}
          {@const detail = formatToolArgs(part.name, part.args, EXPANDED_ARG_CHARS)}
          {@const peek = part.hasResult ? toolOutputPeek(part.output, PEEK_LINES) : { lines: [], moreLines: 0 }}
          {@const full = toolOpen.has(i)}
          <div data-testid="conversation-tool" class="my-1.5">
            <!-- Header: ● Name(args)  <status>  { } — click toggles the full args+result
                 viewer; the hover-revealed { } shows this turn's raw wire object. -->
            <div class="flex items-baseline gap-2">
              <button
                type="button"
                data-testid="conversation-tool-toggle"
                class="flex min-w-0 flex-1 items-baseline gap-2 text-left font-mono text-xs"
                onclick={() => toggleTool(i)}
                aria-expanded={full}
              >
                <span class="shrink-0 text-sky-500">●</span>
                <span class="min-w-0 flex-1 break-words">
                  <span class="font-semibold text-ink-strong">{part.name || $t('tool call')}</span><span class="text-ink-muted">({detail})</span>
                </span>
                <span class={`shrink-0 font-medium ${st.cls}`}>{st.glyph} {st.label}</span>
              </button>
              {#if toolOnly && firstToolPart === i}
                <button
                  type="button"
                  data-testid="conversation-source-toggle"
                  class="shrink-0 rounded px-1 font-mono text-xs text-ink-faint opacity-0 transition-opacity hover:text-link focus:opacity-100 group-hover:opacity-100"
                  title={$t('View source')}
                  onclick={() => (sourceOpen = !sourceOpen)}
                >
                  {'{ }'}
                </button>
              {/if}
            </div>
            <!-- Inline output peek (first lines) under a left rule — the CC glimpse. -->
            {#if !full && peek.lines.length}
              <div class="mt-0.5 border-l-2 border-border pl-3 font-mono text-[11px] leading-snug text-ink-muted">
                {#each peek.lines as line, li (li)}
                  <div class="truncate whitespace-pre">{line || ' '}</div>
                {/each}
              </div>
            {/if}
            <!-- Affordance: reveal the full args + result JsonViewer inline. -->
            {#if !full}
              <button
                type="button"
                data-testid="conversation-tool-expand"
                class="mt-0.5 pl-3 font-mono text-[11px] text-link hover:underline"
                onclick={() => toggleTool(i)}
              >
                {peek.moreLines > 0 ? `… +${peek.moreLines} ${$t('lines')} (${$t('click to expand')})` : `⋯ ${$t('view details')}`}
              </button>
            {:else}
              <div class="mt-1 space-y-2 border-l-2 border-sky-200 pl-3">
                <div>
                  <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{$t('Arguments')}</div>
                  <JsonViewer value={part.args} />
                </div>
                {#if part.hasResult}
                  <div>
                    <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{$t('Result')}</div>
                    <JsonViewer value={part.output} />
                  </div>
                {/if}
                <button
                  type="button"
                  data-testid="conversation-tool-collapse"
                  class="font-mono text-[11px] text-link hover:underline"
                  onclick={() => toggleTool(i)}>▾ {$t('Collapse')}</button
                >
              </div>
            {/if}
          </div>
        {:else if part.kind === 'tool_result'}
          <!-- orphan result (no matching call) — kept, never silently lost -->
          {@const peek = toolOutputPeek(part.output, PEEK_LINES)}
          {@const full = toolOpen.has(i)}
          <div data-testid="conversation-tool" class="my-1.5 font-mono text-xs">
            <button
              type="button"
              data-testid="conversation-tool-toggle"
              class="flex w-full items-baseline gap-2 text-left"
              onclick={() => toggleTool(i)}
              aria-expanded={full}
            >
              <span class="shrink-0 text-ink-faint">●</span>
              <span class="text-ink-muted">{$t('tool result')}{#if part.name} <span class="font-semibold text-ink-strong">{part.name}</span>{/if}</span>
            </button>
            {#if !full && peek.lines.length}
              <div class="mt-0.5 border-l-2 border-border pl-3 text-[11px] leading-snug text-ink-muted">
                {#each peek.lines as line, li (li)}<div class="truncate whitespace-pre">{line || ' '}</div>{/each}
              </div>
            {/if}
            {#if full}
              <div class="mt-1 border-l-2 border-border pl-3"><JsonViewer value={part.output} /></div>
            {/if}
          </div>
        {:else if part.kind === 'tool_call'}
          <!-- defensive: a bare call the pairing pass didn't convert -->
          {@const full = toolOpen.has(i)}
          <div data-testid="conversation-tool" class="my-1.5 font-mono text-xs">
            <button
              type="button"
              data-testid="conversation-tool-toggle"
              class="flex w-full items-baseline gap-2 text-left"
              onclick={() => toggleTool(i)}
              aria-expanded={full}
            >
              <span class="shrink-0 text-sky-500">●</span>
              <span class="min-w-0 flex-1 break-words"
                ><span class="font-semibold text-ink-strong">{part.name || $t('tool call')}</span><span class="text-ink-muted"
                  >({formatToolArgs(part.name, part.args, EXPANDED_ARG_CHARS)})</span
                ></span
              >
            </button>
            {#if full}<div class="mt-1 border-l-2 border-sky-200 pl-3"><JsonViewer value={part.args} /></div>{/if}
          </div>
        {:else}
          <details data-testid="conversation-tool" class="my-1">
            <summary class="cursor-pointer font-mono text-xs text-ink-muted">● {$t('Other content')}</summary>
            <div class="mt-1 border-l-2 border-border pl-3"><JsonViewer value={part.value} /></div>
          </details>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- Raw wire object for THIS turn, revealed by the { } affordance. -->
  {#if sourceOpen}
    <div data-testid="conversation-source" class="mb-2 ml-4">
      <JsonViewer value={turn.raw} />
    </div>
  {/if}
</div>
