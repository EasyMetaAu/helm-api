<script lang="ts">
  import { t } from "$lib/i18n";
  import Modal from "./Modal.svelte";

  // "Read it like text" affordance for the JSON tree. String values are shown
  // JSON-escaped there, so real newlines render as the literal two chars `\n` —
  // unbearable for a long system prompt. This pops a roomy modal that renders the
  // DECODED string verbatim (whitespace-pre-wrap, real line breaks) plus a
  // one-click copy. Read-only — never mutates the value.
  let { text, label }: { text: string; label?: string } = $props();

  let open = $state(false);
  let copied = $state(false);

  function show(): void {
    copied = false;
    open = true;
  }

  function close(): void {
    open = false;
    copied = false;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      copied = true;
    } catch {
      // clipboard unavailable (insecure context / private mode) — degrade silently
    }
  }
</script>

<button
  type="button"
  class="ml-2 cursor-pointer text-link underline"
  data-testid="text-preview-open"
  onclick={show}>{$t("Preview")}</button
>

{#if open}
  <Modal label={label ?? $t("Preview")} onclose={close} wide>
    <div class="flex max-h-[80vh] flex-col">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="truncate font-mono text-sm text-ink-body">
          {label ?? $t("Preview")}
        </h2>
        <div class="flex shrink-0 items-center gap-2">
          <button type="button" class="btn-secondary" onclick={copy}
            >{copied ? $t("Copied") : $t("Copy")}</button
          >
          <button
            type="button"
            class="btn-secondary"
            data-testid="text-preview-close"
            onclick={close}>{$t("Close")}</button
          >
        </div>
      </div>
      <pre
        data-testid="text-preview-body"
        class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-body [overflow-wrap:anywhere]">{text}</pre>
    </div>
  </Modal>
{/if}
