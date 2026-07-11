<script lang="ts">
  import { t } from "$lib/i18n";
  import { parseSseStream, type SseEventKind } from "$lib/sse";
  import FullscreenToggle from "./FullscreenToggle.svelte";
  import JsonTree from "./JsonTree.svelte";
  import { VIEWER_FS_CONTAINER, viewerSizing } from "./viewerChrome";

  type Tab = "assembled" | "chunks" | "raw";
  const TABS: Tab[] = ["assembled", "chunks", "raw"];

  let { raw, testid }: { raw: string; testid?: string } = $props();
  let tab = $state<Tab>("assembled");
  let fullscreen = $state(false);

  const parsed = $derived(parseSseStream(raw));
  const assembled = $derived(parsed.assembled);

  function tabLabel(id: Tab): string {
    return id === "assembled"
      ? $t("Assembled")
      : id === "chunks"
        ? $t("Chunks")
        : $t("Raw");
  }

  const KIND_BADGE: Record<SseEventKind, string> = {
    reasoning: "badge-eval",
    content: "badge-ok",
    tool_call: "badge-rules",
    finish: "badge-fallback",
    meta: "badge-neutral",
    done: "badge-neutral",
    other: "badge-error",
  };

  function prettyArgs(args: string): string {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }

  const tabActive = "border-action bg-action text-white";
  const tabInactive = "border-border bg-surface text-ink-muted hover:bg-canvas";
  const panelCls = $derived(
    `${viewerSizing(fullscreen)} overflow-auto rounded bg-canvas p-2 font-mono text-xs text-ink-body`,
  );
</script>

<div data-testid={testid} class={fullscreen ? VIEWER_FS_CONTAINER : ""}>
  <div class="mb-2 flex flex-wrap items-center gap-2">
    {#each TABS as id (id)}
      <button
        type="button"
        class={`rounded border px-3 py-1 text-sm ${tab === id ? tabActive : tabInactive}`}
        onclick={() => (tab = id)}>{tabLabel(id)}</button
      >
    {/each}
    <div class="ml-auto">
      <FullscreenToggle
        bind:active={fullscreen}
        testid="streamviewer-fullscreen"
      />
    </div>
  </div>

  <div
    data-testid="streamviewer-assembled"
    hidden={tab !== "assembled"}
    class={`${viewerSizing(fullscreen)} overflow-auto`}
  >
    <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
      {#if assembled.model}
        <span class="badge-neutral font-mono">{assembled.model}</span>
      {/if}
      {#if assembled.finishReason}
        <span class="badge-fallback"
          >{$t("finish")}: {assembled.finishReason}</span
        >
      {/if}
      <span class="text-ink-muted"
        >{$t("{count} chunks", { count: parsed.events.length })}</span
      >
    </div>

    {#if assembled.reasoning}
      <details
        data-testid="stream-reasoning"
        class="mb-2 rounded bg-canvas p-2"
      >
        <summary class="cursor-pointer text-xs font-medium text-ink-muted">
          {$t("Reasoning")} · {$t("{count} chars", {
            count: assembled.reasoning.length,
          })}
        </summary>
        <p class="mt-2 whitespace-pre-wrap text-xs text-ink-muted">
          {assembled.reasoning}
        </p>
      </details>
    {/if}

    {#if assembled.content}
      <div
        data-testid="stream-final-content"
        class="rounded bg-canvas p-3 text-sm leading-relaxed whitespace-pre-wrap text-ink-body"
      >
        {assembled.content}
      </div>
    {:else if assembled.toolCalls.length === 0}
      <p class="text-sm italic text-ink-muted">
        {$t("No visible output (stream carried no text content).")}
      </p>
    {/if}

    {#if assembled.toolCalls.length > 0}
      <div data-testid="stream-tool-calls" class="mt-2 flex flex-col gap-2">
        {#each assembled.toolCalls as call, i (i)}
          <div class="rounded bg-canvas p-2">
            <div class="text-xs">
              <span class="badge-rules">{$t("tool call")}</span>
              <span class="ml-1 font-mono font-medium">{call.name}</span>
              {#if call.id}<span class="ml-1 font-mono text-ink-muted"
                  >{call.id}</span
                >{/if}
            </div>
            <pre
              class="mt-1 overflow-auto font-mono text-xs text-ink-body">{prettyArgs(
                call.arguments,
              )}</pre>
          </div>
        {/each}
      </div>
    {/if}

    {#if assembled.usage}
      <details class="mt-2 rounded bg-canvas p-2">
        <summary class="cursor-pointer text-xs font-medium text-ink-muted">
          {$t("Usage")}
        </summary>
        <pre
          class="mt-1 overflow-auto font-mono text-xs text-ink-body">{JSON.stringify(
            assembled.usage,
            null,
            2,
          )}</pre>
      </details>
    {/if}
  </div>

  <div
    data-testid="streamviewer-chunks"
    hidden={tab !== "chunks"}
    class={`${viewerSizing(fullscreen)} overflow-auto rounded bg-canvas`}
  >
    <ul class="divide-y divide-border/60">
      {#each parsed.events as ev (ev.index)}
        <li data-testid="stream-chunk-row">
          <details>
            <summary
              class="flex cursor-pointer items-baseline gap-2 px-2 py-1 text-xs hover:bg-surface"
            >
              <span class="w-8 shrink-0 text-right font-mono text-ink-muted"
                >{ev.index}</span
              >
              <span class={`${KIND_BADGE[ev.kind]} shrink-0`}>{ev.kind}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-ink-body"
                >{ev.text || (ev.event ?? "")}</span
              >
            </summary>
            <div class="bg-surface px-2 py-1 pl-12 font-mono text-xs">
              {#if ev.data !== null}
                <JsonTree value={ev.data} />
              {:else}
                <span class="text-ink-muted">{ev.raw}</span>
              {/if}
            </div>
          </details>
        </li>
      {/each}
    </ul>
  </div>

  <pre
    data-testid="streamviewer-raw"
    hidden={tab !== "raw"}
    class={panelCls}>{raw}</pre>
</div>
